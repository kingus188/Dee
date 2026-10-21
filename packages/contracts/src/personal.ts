export type Decision = { id: string; status: "pending" | "approved" | "rejected"; source: "user" | "agent"; createdAt: number; decidedAt: number | null };
export type MemoryItem = Decision & { text: string };
export type SkillItem = Decision & { name: string; description: string; body: string };
export type KnowledgeStatus = { enabled: boolean; reason?: string; root?: string; allow: string[] };
export type KnowledgeHit = { path: string; status: string; revision: string; line: number; endLine: number; excerpt: string; score: number };
export type PersonalData = { memory: MemoryItem[]; skills: SkillItem[]; knowledge: KnowledgeStatus };
// base 可选；存在时事务比较文本字段和 status，不同返回 409。编辑不改变审批状态。
// memory 保留 Markdown 换行；原有 280 字、总预算和禁止凭据等限制不变。
export type MemoryEditRequest = { text: string; base?: MemoryItem };
export type SkillEditRequest = { name: string; description: string; body: string; base?: SkillItem };
