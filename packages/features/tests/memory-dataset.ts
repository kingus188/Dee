// 记忆功能测试数据集：密钥识别、文本规范化、提示词预算、状态流转场景。
export const secretsMustReject = [
	"我的 key 是 sk-abcdefghijklmnopqrstuv",
	"github token ghp_abcdefghijklmnopqrstuvwxyz0123",
	"aws AKIAABCDEFGHIJKLMNOP",
	"slack xoxb-1234567890-abcdefghij",
	"-----BEGIN RSA PRIVATE KEY-----",
	"Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
	"password: hunter2hunter2",
	"API_KEY=abcdef123456",
	"密码：abc12345",
	"密钥 = a1b2c3d4e5",
	"PASSWORD ： abc12345",
	"password:\nhunter2hunter2",
	"export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv",
	"secret=abcdef",
];

// 技能的名称、说明、正文都要检查，凭据可能出现在任何一处。
export const skillSecretCases = [
	{ name: "部署", description: "发布前", body: "先设置 token: abcdef123456 再发布" },
	{ name: "部署", description: "密码：abc12345", body: "步骤" },
	{ name: "部署", description: "发布前", body: "第一步\n第二步\npassword:\nhunter2hunter2" },
];

// 普通偏好和事实，含与密钥相关的词但不含凭据，必须放行。
export const mustAccept = [
	"回复用简体中文",
	"喜欢带要点的简洁回答",
	"喜欢用 token 计费的方案",
	"密码要定期轮换这件事我很在意",
	"我在做 API key 管理功能",
	"项目周报每周五发送",
	"English and 中文 mixed content is fine",
];

export const normalizeCases: { input: unknown; output?: string; error?: RegExp }[] = [
	{ input: "  记住   这件事  ", output: "记住 这件事" },
	{ input: "第一行\n第二行\t第三行", output: "第一行 第二行 第三行" },
	{ input: "甲".repeat(280), output: "甲".repeat(280) },
	{ input: "甲".repeat(281), error: /记忆必须/ },
	{ input: "", error: /记忆必须/ },
	{ input: "   \n ", error: /记忆必须/ },
	{ input: null, error: /记忆必须/ },
	{ input: undefined, error: /记忆必须/ },
];

export const promptCases: { name: string; items: { status: string; text: string }[]; budget: number; expect: string[] }[] = [
	{ name: "只取已批准", budget: 100, expect: ["乙"], items: [
		{ status: "pending", text: "待" }, { status: "approved", text: "乙" }, { status: "rejected", text: "拒" },
	] },
	{ name: "预算内保留全部且顺序不变", budget: 10, expect: ["a", "b", "c"], items: [
		{ status: "approved", text: "a" }, { status: "approved", text: "b" }, { status: "approved", text: "c" },
	] },
	{ name: "超预算时优先保留较新的", budget: 2, expect: ["b", "c"], items: [
		{ status: "approved", text: "a" }, { status: "approved", text: "b" }, { status: "approved", text: "c" },
	] },
	{ name: "装不下的大条目被跳过，更旧的小条目仍保留", budget: 5, expect: ["小", "新"], items: [
		{ status: "approved", text: "小" }, { status: "approved", text: "大".repeat(9) }, { status: "approved", text: "新" },
	] },
	{ name: "空列表", budget: 100, expect: [], items: [] },
];

// ref 指向此前第 N 个产生的条目（repeat 展开为多个，decide/edit 各占一个）。
type Expect = { error?: RegExp; status?: string; resultText?: string; sameAs?: number; differentFrom?: number };
export type Step =
	| ({ op: "propose"; text: string; approved?: boolean; requestId?: string; repeat?: number } & Expect)
	| ({ op: "decide"; ref: number; action: "approve" | "reject" } & Expect)
	| ({ op: "edit"; ref: number; text: string } & Expect);
export type Scenario = { name: string; steps: Step[]; finalCounts?: Partial<Record<"pending" | "approved" | "rejected", number>> };

const fill = (n: number, size: number, approved: boolean): Step[] =>
	Array.from({ length: n }, (_, i) => ({ op: "propose", text: `${i}`.padStart(size, "x"), approved }) as Step);

export const scenarios: Scenario[] = [
	{ name: "相同文本去重；被拒绝后可重新提交", steps: [
		{ op: "propose", text: "A" },
		{ op: "propose", text: "A", sameAs: 0 },
		{ op: "decide", ref: 0, action: "reject", status: "rejected" },
		{ op: "propose", text: "A", status: "pending", differentFrom: 0 },
	], finalCounts: { pending: 1, rejected: 1 } },
	{ name: "同一 requestId 返回第一次的结果", steps: [
		{ op: "propose", text: "第一条", requestId: "r1" },
		{ op: "propose", text: "完全不同", requestId: "r1", sameAs: 0 },
	], finalCounts: { pending: 1 } },
	{ name: "已批准最多 30 条", steps: [
		...fill(30, 60, true),
		{ op: "propose", text: "多一条", approved: true, error: /已确认记忆已满/ },
	], finalCounts: { approved: 30 } },
	{ name: "待确认最多 40 条", steps: [
		...fill(40, 10, false),
		{ op: "propose", text: "多一条", error: /待确认记忆已满/ },
	], finalCounts: { pending: 40 } },
	{ name: "已批准总字数不超过 1800：恰好放得下，多 1 字则拒绝", steps: [
		{ op: "propose", text: "甲".repeat(280), approved: true, repeat: 6 },
		{ op: "propose", text: "乙".repeat(120), approved: true, status: "approved" },
		{ op: "propose", text: "丙", approved: true, error: /总字数已满/ },
	], finalCounts: { approved: 7 } },
	{ name: "批准待确认项同样受总字数限制，撤回腾出空间后可批准", steps: [
		{ op: "propose", text: "甲".repeat(280), approved: true, repeat: 6 },
		{ op: "propose", text: "乙".repeat(200) },
		{ op: "decide", ref: 6, action: "approve", error: /总字数已满/ },
		{ op: "decide", ref: 0, action: "reject", status: "rejected" },
		{ op: "decide", ref: 6, action: "approve", status: "approved" },
	], finalCounts: { approved: 6, rejected: 1 } },
	{ name: "批准/拒绝重复操作是幂等的", steps: [
		{ op: "propose", text: "A" },
		{ op: "decide", ref: 0, action: "approve", status: "approved" },
		{ op: "decide", ref: 0, action: "approve", status: "approved" },
		{ op: "decide", ref: 0, action: "reject", status: "rejected" },
		{ op: "decide", ref: 0, action: "reject", status: "rejected" },
	], finalCounts: { rejected: 1 } },
	{ name: "修改：保持状态；重复、越界、不存在、已拒绝都报错", steps: [
		{ op: "propose", text: "原文" },
		{ op: "propose", text: "另一条", approved: true },
		{ op: "edit", ref: 0, text: " 新 文 ", status: "pending", resultText: "新 文" },
		{ op: "edit", ref: 0, text: "另一条", error: /已有相同记忆/ },
		{ op: "edit", ref: 0, text: "", error: /记忆必须/ },
		{ op: "edit", ref: 0, text: "password: abcdef123", error: /不能包含密码/ },
		{ op: "decide", ref: 0, action: "reject" },
		{ op: "edit", ref: 0, text: "再改", error: /记忆不存在/ },
	] },
	{ name: "修改已批准项受总字数限制", steps: [
		{ op: "propose", text: "甲".repeat(280), approved: true, repeat: 6 },
		{ op: "propose", text: "乙", approved: true },
		{ op: "edit", ref: 6, text: "乙".repeat(120), status: "approved" },
		{ op: "edit", ref: 6, text: "乙".repeat(121), error: /总字数已满/ },
	] },
	{ name: "已拒绝条目只保留最近 20 条", steps: [
		...Array.from({ length: 25 }, (_, i) => [
			{ op: "propose", text: `拒绝${i}` } as Step,
			{ op: "decide", ref: i * 2, action: "reject" } as Step,
		]).flat(),
		{ op: "propose", text: "触发裁剪" },
	], finalCounts: { pending: 1, rejected: 20 } },
];
