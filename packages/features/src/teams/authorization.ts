// 发送授权只读用户原话；模型选择的收件人与正文必须逐项匹配。
export const chatName = (label: string) => /「(.*)」/.exec(label)?.[1] ?? label;
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function unwrap(text: string): string {
	let value = text.trim().replace(/[。.!！\s]+$/, "");
	const pairs: Record<string, string> = { "「": "」", "『": "』", "“": "”", '"': '"', "‘": "’", "'": "'" };
	// 仅去掉包住整句的成对引号，不从引用、否定句或附加指令中抽取确认语。
	for (let n = 0; n < 3 && pairs[value[0]] && value.at(-1) === pairs[value[0]]; n++) {
		value = value.slice(1, -1).trim().replace(/[。.!！\s]+$/, "");
	}
	return value;
}

const CONFIRM = /^(确认发送|确认回复|确认|发送|发吧|发出去|可以发送|可以发)[\s:：,，]*(.*)$/;
export function parseConfirmation(text: string): { rest: string } | null {
	const match = CONFIRM.exec(unwrap(text));
	if (!match || /[「」『』“”"‘’]/.test(match[2])) return null;
	return { rest: match[2].replace(/^(发?给|to\s+)\s*/i, "").trim() };
}

// 不使用 includes：拟稿、讨论、否定或额外要求不能授权发送其中一段原文。
export function parseSendDirective(text: string): { name: string; text: string } | null {
	const match = /^(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)?\s*(?:回复给?|发送给|发给)\s*([^：:\n]+?)\s*[：:]\s*([\s\S]+)$/.exec(text.trim());
	if (!match) return null;
	const body = match[2].trim();
	// 尾随的征询/暂缓要求不是收件人正文；即使模型把它一起保存，也不能发送。
	if (/(?:先(?:别|不要)|暂时(?:别|不要)|暂不|不要)(?:发送|发出去|发|回复)(?:[了吧啊呀]|给(?:他|她|对方))?[。.!！?？\s]*$/.test(body)
		|| /(?:这样|这么)(?:回(?:复)?|说|写)(?:可以|行|合适|妥当|好吗|怎么样|好不好|行不行)[吗么呢]?[。.!！?？\s]*$/.test(body)) return null;
	return { name: match[1].trim(), text: body };
}

export function explicitlyTargets(text: string, name: string): boolean {
	const directive = parseSendDirective(text);
	if (directive) return sameName(directive.name, name);
	// 用户只指定收件人、请助手拟稿时，仍需确认正文，但不必再次输入姓名。
	const request = /^(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)?\s*(?:拟(?:一?个)?回复给?|起草回复给?|回复给?)\s*([^：:\n]+?)(?:[：:][\s\S]*)?$/.exec(text.trim());
	const recipientFirst = /^(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)?\s*(?:给|向)\s*(.+?)\s*(?:拟(?:一?个)?|写(?:一?个)?|起草(?:一?个)?)回复(?:[：:][\s\S]*)?$/.exec(text.trim());
	return !!(request && sameName(request[1], name) || recipientFirst && sameName(recipientFirst[1], name));
}

// 持续代回与单次回复分开解析。只有完整的命令句才进入待确认流程，关键词本身不授权。
export type AwayReplyIntent = "enable" | "stop" | "query" | "decline" | "none";
const AWAY_TOPIC = /自动(?:回复|代回|回|答复|回应|应答)|(?:替我|代我)回/;
const AWAY_COMMAND = /^(?:(?:请(?:帮我)?|帮我|麻烦(?:帮我)?)\s*(?:(?:开启|启用|设置|打开)\s*)?|(?:开启|启用|设置|打开)\s*)(?:Teams\s*)?自动(?:回复|代回|回|答复|回应|应答)(?:一下)?(?:找我的人|所有找我的人|给找我的人|私聊消息)?$/i;
const AWAY_CONTEXT = /^(?:我)?(?:今天|明天|这几天|目前|现在|接下来)?(?:要|正在|在)?(?:出差|休假|开会|全天开会|全天会议|忙|不在|离线|外出)(?:中|了|一会儿|半天|[一二两三四五六七八九十\d]+天)?$/;
const cleanAway = (text: string) => text.trim().replace(/[。.!！\s]+$/, "");
export function awayReplyIntent(text: string): AwayReplyIntent {
	const value = cleanAway(text);
	if (!value || /^[\[<「『“"‘']/.test(value)) return "none";
	const topic = AWAY_TOPIC.test(value);
	if (topic && /[?？]|是否|能否|如何|怎么|什么|可不可以|能不能|要不要|有没有|了没有|[吗么呢]$/.test(value)) return "query";
	const clauses = value.split(/[，,；;。\n]/).map(part => part.trim()).filter(Boolean);
	const command = clauses.at(-1) ?? "";
	const context = clauses.slice(0, -1);
	const returned = /^(?:我)?(?:回来了|出差结束了|休假结束了|会议结束了|开完会了|状态结束了)$/;
	if (context.every(part => AWAY_CONTEXT.test(part) || returned.test(part)) && (/^(?:请(?:帮我)?|帮我)?(?:停止|关闭|取消|暂停|停掉)(?:Teams\s*)?自动(?:回复|代回|回)(?:了)?$/i.test(command)
		|| /^(?:请)?(?:不要再?|不用再?|别再?|不再|不需要)自动(?:回复|代回|回)(?:了)?$/.test(command)
		|| returned.test(command))) return "stop";
	// 否定开启、否定停止、讨论过去的指令都不能被关键词反转成授权。
	if (topic && /(?:不要|别|不用|不能|不许|不想|不需要|不允许|没有|没让|并非|不是).*(?:开启|启用|设置|打开|停止|关闭|取消|暂停|自动|替我|代我)/.test(value)) return "decline";
	if (context.every(part => AWAY_CONTEXT.test(part)) && (AWAY_COMMAND.test(command)
		|| context.length > 0 && /^(?:请)?(?:替我|代我)回(?:复)?(?:一下)?(?:找我的人)?$/.test(command))) return "enable";
	return "none";
}
// 兼容调用方：此处仅表示明确提出开启请求，不代表已批准正文、范围或有效期。
export const authorizesAwayReply = (text: string) => awayReplyIntent(text) === "enable";
export const awayConfirmation = (text: string) => {
	const match = /^确认开启自动回复\s+草稿\s+(\d+)$/.exec(cleanAway(text));
	return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
};
