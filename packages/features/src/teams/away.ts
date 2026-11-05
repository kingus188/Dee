// 工作状态自动代回：先展示固定正文、范围与截止时间，明确确认后才启用。
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { hasSecret } from "../personal/service.js";
import { resultText } from "../results.js";
import { awayPreview, confirmAwayReply, prepareAwayReply, stopAwayReply, type AwayPort } from "./away-approval.js";

const STATUS_MAX = 40;
const REPLY_MAX = 500;
export type { AwayStatus, AwayPort } from "./away-approval.js";

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
				description: "准备自动代回草稿，不开启、不发送。仅用户明确要求开启时调用；询问、停止、否定不算开启。原样展示草稿编号、命中重要性规则的 Teams 私聊适用范围、固定截止时间和完整正文，等用户确认后调用 confirm_away_reply。默认截止当天，用户明确时长时才填 hours；修改正文或时长必须生成新版并重新确认。",
				executionMode: "sequential",
				parameters: Type.Object({
					status: Type.String({ description: "工作状态，如「出差中」「全天会议」，最多 40 字" }),
					reply: Type.String({ description: "代发给对方的纯文本安抚语，只能包含用户提供的状态、回复时间或联系方式，不得自行添加承诺，最多 500 字" }),
					hours: Type.Optional(Type.Number({ description: "用户说了明确时长时填持续小时数；不填表示只管到今天结束" })),
				}),
				execute: async (args, api, context) => {
					const status = args.status.trim();
					const reply = args.reply.trim();
					if (!status || status.length > STATUS_MAX) return resultText(`状态必须是 1～${STATUS_MAX} 字。`);
					if (!reply || reply.length > REPLY_MAX) return resultText(`回复内容必须是 1～${REPLY_MAX} 字。`);
					if (hasSecret(reply)) return resultText("自动回复里不能包含密码、密钥或令牌，已拒绝。");
					if (args.hours !== undefined && (!Number.isFinite(args.hours) || args.hours <= 0 || args.hours > 24 * 30)) return resultText("时长必须大于 0 且不超过 720 小时，不能静默延长或截断。");
					const until = args.hours === undefined ? endOfToday() : new Date(Date.now() + args.hours * 3_600_000).toISOString();
					try {
						const draft = await prepareAwayReply({ status, reply, until }, api, context);
						return resultText(`草稿已保存，尚未开启。请原样展示下方内容，用户须在 30 分钟内单独回复「确认开启自动回复 草稿 ${draft.id}」。确认后调用 confirm_away_reply({draftId:${draft.id}})，不要重新起草。\n${awayPreview(draft)}`);
					} catch (error) {
						return resultText(`未开启：${error instanceof Error ? error.message : String(error)}`);
					}
				},
			}),
			defineTool({
				name: "confirm_away_reply",
				replay: "unsafe",
				executionMode: "sequential",
				description: "批准用户已确认的自动代回草稿编号，不接受新正文、范围或时长。用户必须在完整预览之后单独回复『确认开启自动回复 草稿 N』。批准只消费一次，过期或被替换的旧稿不能启用。",
				parameters: Type.Object({ draftId: Type.Integer({ minimum: 1 }) }),
				execute: async (args, api, context) => {
					try {
						const draft = await confirmAwayReply(args.draftId, port, api, context);
						return resultText(`已开启「${draft.status}」自动代回，有效到 ${clock(draft.until)}。自动回复不算用户已处理，来信仍保留在未回复清单。可随时说「停止自动回复」。\n${awayPreview(draft)}`);
					} catch (error) {
						return resultText(`未开启：${error instanceof Error ? error.message : String(error)}`);
					}
				},
			}),
			defineTool({
				name: "clear_away_reply",
				replay: "safe",
				executionMode: "sequential",
				description: "停止工作状态自动代回。用户说回来了、不用自动回了就调用。",
				parameters: Type.Object({}),
				execute: async (_args, api, context) => {
					try {
						const current = await stopAwayReply(port, api, context);
						return resultText(current ? `已停止「${current.status}」自动代回。` : "当前没有开启自动代回，待确认草稿也已取消。");
					} catch (error) {
						return resultText(`未停止：${error instanceof Error ? error.message : String(error)}`);
					}
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
