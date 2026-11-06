import type { TeamsReadPort, TeamsReadQuery } from "@assistant/features";
import { createTeamsGraph, graphPageUrl } from "./teams-graph.js";
import { readTeamsFile } from "./teams-files.js";
import type { TeamsArchive, ArchivedChat, ArchivedMessage } from "./teams-archive-store.js";
import { createTeamsMedia } from "./teams-media.js";
import { teamsRecords } from "./teams-records.js";

type Page = { value: unknown[]; "@odata.nextLink"?: string };
type SearchHit = { resource: { id: string; name?: string; webUrl?: string; size?: number; file?: unknown; parentReference?: { driveId?: string } } };
type SearchResult = { value: { hitsContainers: { hits?: SearchHit[]; moreResultsAvailable?: boolean }[] }[] };
const segment = (value: string) => {
	if (!value || value.length > 1024 || /[\u0000-\u001f]/.test(value) || value === "." || value === "..") throw new Error("Teams 资源标识无效");
	return encodeURIComponent(value);
};

export function createTeamsReader({ getToken, getFilesToken = getToken, getChannelsToken = getToken, fetchImpl = fetch, signal, archive }: {
	getToken: () => Promise<string>; getFilesToken?: () => Promise<string>; getChannelsToken?: () => Promise<string>; fetchImpl?: typeof fetch; signal?: AbortSignal; archive?: TeamsArchive;
}): TeamsReadPort {
	const graph = createTeamsGraph(fetchImpl, signal);
	const media = archive ? createTeamsMedia({ archive, graph, getToken, fetchImpl, signal }) : undefined;
	let bound = false;
	async function bind(token: string) {
		if (!archive || bound) return;
		const me = await graph<{ id: string }>(token, graphPageUrl("/me?$select=id"));
		if (!me.id) throw new Error("Teams 登录身份无效");
		archive.bindAccount(me.id); bound = true;
	}
	async function save(chatId: string, messages: ArchivedMessage[], token: string, revision?: number) {
		if (!archive || !media) return undefined;
		await bind(token);
		archive.save(chatId, messages, revision);
		const accepted = messages.flatMap(message => { const current = archive.message(chatId, message.id); return current ? [current] : []; });
		await media.discover(chatId, accepted, token);
		await media.download();
		return messages.flatMap(m => archive.mediaRows(chatId, m.id));
	}
	const currentMessage = (chatId: string, message: ArchivedMessage): ArchivedMessage => archive?.message(chatId, message.id) ?? {
		id: message.id, createdDateTime: message.createdDateTime, lastModifiedDateTime: message.lastModifiedDateTime,
		deletedDateTime: message.deletedDateTime, body: { content: "[来源已撤回或暂不可用]", contentType: "text" },
	};
	async function page(path: string, cursor: string | undefined, token: string) {
		const url = graphPageUrl(path, cursor);
		const data = await graph<Page>(token, url);
		if (!Array.isArray(data.value)) throw new Error("Teams 返回的分页格式无效");
		const next = data["@odata.nextLink"];
		if (next !== undefined && (typeof next !== "string" || graphPageUrl(path, next) === url)) throw new Error("Teams 返回的分页地址无效或重复");
		return { data: { items: data.value, nextCursor: next ?? null, complete: !next } };
	}
	return async (query: TeamsReadQuery) => {
		if (query.kind === "archive") {
			if (!archive) throw new Error("Teams 数据库归档未启用");
			const data = archive.search({ ...query, limit: Math.min(50, Math.max(1, query.limit ?? 20)) });
      return { data: { ...data, sync: archive.status() }, media: data.items.flatMap(item => item.archiveMedia), records: teamsRecords(archive, data.items) };
		}
		if (query.kind === "archiveStatus") return { data: archive?.status() ?? { enabled: false } };
		if (query.kind === "media") {
			if (!media) throw new Error("Teams 截图归档未启用");
			return media.read(query.id);
		}
		signal?.throwIfAborted();
		switch (query.kind) {
			case "chats": {
				const token = await getToken(); await bind(token);
				const result = await page("/me/chats?$expand=members&$top=50", query.cursor, token);
				archive?.chats(result.data.items as ArchivedChat[]);
				return result;
			}
			case "channels": {
				const path = query.teamId ? `/teams/${segment(query.teamId)}/allChannels` : "/me/teamwork/associatedTeams";
				return page(path, query.cursor, await getChannelsToken());
			}
			case "history": {
				const chat = !!query.chatId, channel = !!query.teamId && !!query.channelId;
				if (chat === channel || (chat && (query.teamId || query.channelId))) throw new Error("请提供 chatId，或同时提供 teamId 和 channelId");
				if (query.replies && (chat || !query.messageId)) throw new Error("频道回复需要 teamId、channelId 和 messageId");
				let path = chat ? `/chats/${segment(query.chatId!)}/messages` : `/teams/${segment(query.teamId!)}/channels/${segment(query.channelId!)}/messages`;
				if (query.messageId) path += `/${segment(query.messageId)}`;
				if (query.replies) path += "/replies";
				const token = await (chat ? getToken() : getChannelsToken());
				const revision = chat ? archive?.sourceRevision(query.chatId!) : undefined;
				if (query.messageId && !query.replies) {
					if (query.cursor) throw new Error("读取指定消息不接受分页");
					let data = await graph<ArchivedMessage>(token, graphPageUrl(path));
          const savedMedia = chat ? await save(query.chatId!, [data], token, revision) : undefined;
          if (chat && archive) data = currentMessage(query.chatId!, data);
          return { data, media: savedMedia, records: chat && archive ? teamsRecords(archive, [{ ...data, chatId: query.chatId! }]) : undefined };
				}
				const result = await page(path + (chat ? `?$top=50&$orderby=${query.archiveSync ? "lastModifiedDateTime" : "createdDateTime"} desc` : "?$top=50"), query.cursor, token);
        const savedMedia = chat ? await save(query.chatId!, result.data.items as ArchivedMessage[], token, revision) : undefined;
        if (chat && archive) result.data.items = (result.data.items as ArchivedMessage[]).map(message => currentMessage(query.chatId!, message));
        return { ...result, media: savedMedia, records: chat && archive ? teamsRecords(archive, (result.data.items as ArchivedMessage[]).map(m => ({ ...m, chatId: query.chatId! }))) : undefined };
			}
			case "files": {
				const text = query.query.trim(), offset = query.offset ?? 0;
				if (!text || text.length > 1000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new Error("文件搜索词或分页位置无效");
				const data = await graph<SearchResult>(await getFilesToken(), graphPageUrl("/search/query"), {
					requests: [{ entityTypes: ["driveItem"], query: { queryString: text }, from: offset, size: 25 }],
				});
				const containers = data.value?.flatMap(item => item.hitsContainers);
				if (!containers?.length || containers.some(item => !item || (item.hits !== undefined && !Array.isArray(item.hits)))) throw new Error("微软文件搜索返回格式无效");
				const hits = containers.flatMap(item => item.hits ?? []);
				const more = containers.some(item => item.moreResultsAvailable);
				if (more && !hits.length) throw new Error("微软文件搜索分页未推进，请稍后重试");
				return { data: {
					items: hits.map(({ resource }) => ({ id: resource.id, driveId: resource.parentReference?.driveId, name: resource.name, webUrl: resource.webUrl, size: resource.size, isFile: !!resource.file })),
					moreResultsAvailable: more, nextOffset: more ? offset + hits.length : null,
					notice: "搜索只覆盖微软已建立索引的、当前账号有权访问的文件；请核对消息附件与文件 webUrl。",
				} };
			}
			case "file":
				segment(query.driveId); segment(query.itemId);
				return readTeamsFile({ graph, token: await getFilesToken(), driveId: query.driveId, itemId: query.itemId, fetchImpl, signal });
		}
	};
}
