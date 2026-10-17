// 工作状态自动代回：用户一句话开启，桌面端在新来信时代发固定安抚语。
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { hasSecret } from "../personal/service.js";
import { resultText } from "../results.js";
import { authorizesAwayReply } from "./authorization.js";
import { latestUserTextOf } from "./reply.js";

const STATUS_MAX = 40;
const REPLY_MAX = 500;
export type AwayStatus = { status: string; reply: string; since: string; until: string; version: number };
export type AwayPort = {
	get(): AwayStatus | undefined;
	set(input: { status: string; reply: string; until: string }): void;
	clear(): void;
};

// 默认只管当天：用户第二天不再交代状态，就按正常流程处理，不代回。
const endOfToday = () => { const end = new Date(); end.setHours(23, 59, 59, 999); return end.toISOString(); };

const clock = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

export function createTeamsAway(port: AwayPort) {
	return defineExtension({
		name: "teams-away",
		tools: [
			defineTool({
				name: "set_away_reply",
				replay: "safe",
				description: "开启工作状态自动代回：用户不在时，Teams 私聊新来信会自动收到一句安抚语。默认只当天有效，用户说了明确时长（如「出差三天」）才填 hours。只有用户明确要求自动/替他回复才能调用，不要自行开启。回复全文要原样展示给用户，用户要改就再调一次覆盖。",
				parameters: Type.Object({
					status: Type.String({ description: "工作状态，如「出差中」「全天会议」，最多 40 字" }),
					reply: Type.String({ description: "代发给对方的纯文本安抚语，说明状态、大概什么时候能回、紧急事情怎么找人，最多 500 字" }),
					hours: Type.Optional(Type.Number({ description: "用户说了明确时长时填持续小时数；不填表示只管到今天结束" })),
				}),
				execute: async (args, api, context) => {
					const status = args.status.trim();
					const reply = args.reply.trim();
					if (!status || status.length > STATUS_MAX) return resultText(`状态必须是 1～${STATUS_MAX} 字。`);
					if (!reply || reply.length > REPLY_MAX) return resultText(`回复内容必须是 1～${REPLY_MAX} 字。`);
					if (hasSecret(reply)) return resultText("自动回复里不能包含密码、密钥或令牌，已拒绝。");
					const text = await api.commit(async tx => latestUserTextOf((await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 20)).items), context);
					if (!authorizesAwayReply(text)) return resultText("用户这句话没有要求自动代回。请先问用户是否要在这个状态下自动回复找他的人，等用户明确说「自动回复」再调用。");
					const hours = args.hours && args.hours > 0 ? Math.min(args.hours, 24 * 30) : 0;
					const until = hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : endOfToday();
					port.set({ status, reply, until });
					return resultText([
						`已开启「${status}」自动代回，有效到 ${clock(until)}${hours ? "" : "（只管今天）"}。`,
						"只回 Teams 私聊，群聊不回；同一个人在这个状态里只回一次；到期后用户不再交代就按正常流程处理；用户也可以说「停止自动回复」。",
						"自动回复不算用户已处理，这些来信仍留在未回复清单里。",
						"请原样把下面全文展示给用户确认，要改就重新调用本工具覆盖。",
						`全文：\n${reply}`,
					].join("\n"));
				},
			}),
			defineTool({
				name: "clear_away_reply",
				replay: "safe",
				description: "停止工作状态自动代回。用户说回来了、不用自动回了就调用。",
				parameters: Type.Object({}),
				execute: async () => {
					const current = port.get();
					port.clear();
					return resultText(current ? `已停止「${current.status}」自动代回。` : "当前没有开启自动代回。");
				},
			}),
		],
		sections: [
			section("away", () => {
				const current = port.get();
				return current ? `用户当前工作状态：${current.status}，自动代回有效到 ${clock(current.until)}；Teams 私聊新来信会自动代回一句安抚语。自动代回不等于用户已处理；用户说状态结束时用 clear_away_reply 停掉。` : undefined;
			}),
		],
	});
}
