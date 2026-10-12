export type Decision = { id: string; status: "pending" | "approved" | "rejected"; source: "user" | "agent"; createdAt: number; decidedAt: number | null };
export type MemoryItem = Decision & { text: string };
export type SkillItem = Decision & { name: string; description: string; body: string };
export type KnowledgeStatus = { enabled: boolean; reason?: string; root?: string; allow: string[] };
export type KnowledgeHit = { path: string; status: string; revision: string; line: number; endLine: number; excerpt: string; score: number };
export type PersonalData = { memory: MemoryItem[]; skills: SkillItem[]; knowledge: KnowledgeStatus };
