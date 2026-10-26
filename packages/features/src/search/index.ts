// Bounded, deterministic vocabulary expansion. Source/history filtering stays with callers.
const SYNONYMS = [
	["报销", "费用申请", "reimbursement", "expense"],
	["审批", "审核", "approval", "approve", "review"],
	["登录", "登陆", "单点登录", "sso", "login", "sign in"],
	["部署", "上线", "发布", "deployment", "deploy", "release"],
	["回滚", "rollback", "roll back"],
	["权限", "授权", "permission", "permissions", "authorization"],
	["备份", "backup", "backups"],
	["数据库", "database", "databases"],
	["发票", "invoice", "invoices"],
	["负责人", "责任人", "owner", "owners"],
	["流程", "步骤", "workflow", "procedure"],
] as const;
const STOP = new Set("请 请问 帮 帮我 我 我们 的 了 呢 吗 啊 是 有 在 和 与 及 要 想 一下 怎么 怎样 如何 什么 哪些 是否 可以 能 需要 知道 了解 关于 查找 搜索 帮忙 告诉 查 看看 how what which where when why who does do did is are was were a an the to of for on in and or can could would should please me my we i it this that work works configured configure".split(" "));
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function pattern(term: string) {
	// ASCII identifiers match whole words: `cat` must not find `concatenate`.
	return new RegExp(`${/^[a-z0-9_]/.test(term) ? "(?<![a-z0-9_])" : ""}${escape(term)}${/[a-z0-9_]$/.test(term) ? "(?![a-z0-9_])" : ""}`, "u");
}

export function queryTerms(query: string): string[][] {
	let remainder = normalize(query);
	const groups: string[][] = [];
	for (const family of SYNONYMS) {
		if (!family.some(term => pattern(term).test(remainder))) continue;
		groups.push([...family]);
		for (const term of [...family].sort((a, b) => b.length - a.length)) remainder = remainder.replace(new RegExp(pattern(term).source, "gu"), " ");
	}
	const seen = new Set<string>();
	for (const part of segmenter.segment(remainder)) {
		const term = part.segment.trim();
		if (!part.isWordLike || STOP.has(term) || seen.has(term)) continue;
		seen.add(term);
		groups.push([term]);
	}
	return groups;
}

export function bestMatchingLine(text: string, query: string, options: { requireAll?: boolean } = {}): { line: number; score: number; matched: number; total: number } {
	const phrase = normalize(query).trim();
	const terms = queryTerms(query);
	const empty = { line: 1, score: 0, matched: 0, total: terms.length };
	if (!phrase || !terms.length) return empty;
	const lines = String(text).split(/\r?\n/).map(normalize);
	const patterns = terms.map(group => group.map(pattern));
	const counts = lines.map(line => patterns.filter(group => group.some(re => re.test(line))).length);
	const matched = patterns.filter(group => lines.some(line => group.some(re => re.test(line)))).length;
	// Knowledge requires every concept; materials can explicitly retain partial draft recall.
	if (matched === 0 || (options.requireAll !== false && matched !== terms.length)) return { ...empty, matched };
	let best = empty;
	for (let i = 0; i < lines.length; i++) {
		const score = matched * 10 + counts[i] * 3 + (lines[i].includes(phrase) ? 5 : 0);
		if (score > best.score) best = { line: i + 1, score, matched, total: terms.length };
	}
	return best;
}
