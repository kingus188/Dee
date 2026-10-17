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

// 自动代回是持续性的对外发送，必须由用户原话开启；模型不能自行启用。
const AWAY = /(自动(回复|回|答复|回应|应答)|替我回|代我回|帮我回(复)?|自动帮我回)/;
export const authorizesAwayReply = (text: string) => !text.trim().startsWith("[") && AWAY.test(text);
