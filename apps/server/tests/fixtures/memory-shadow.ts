import type { EpisodeRecord } from "@assistant/features";
import { MEMORY_EVAL_NOW } from "./memory-evaluation.js";

// Predeclared before evaluation: one lexical match dominates both bonuses.
// This is a test-only ordering hypothesis, not semantic inference or retention.
export const SHADOW_POLICY = { version: "shadow-v1", relevanceWeight: 1, timeWeight: 0.2, readWeight: 0.2, halfLifeDays: 30, candidateLimit: 10, topK: 2 } as const;
export const SHADOW_ROWS = [
  { label: "rollback-important", summary: "回滚 校验：必须保存完整校验记录。", date: "2026-01-01", access: "private" },
  { label: "rollback-recent", summary: "回滚：今天只是讨论标题颜色。", date: "2026-10-31", access: "private" },
  { label: "budget-old", summary: "预算 甲项目：此前批准额度是30。", date: "2026-01-01", access: "private" },
  { label: "budget-update", summary: "预算 甲项目：新决定替换旧额度，现为20。", date: "2026-10-01", access: "private" },
  { label: "budget-noise", summary: "预算 甲项目：今天讨论表格样式，没有金额决定。", date: "2026-10-31", access: "private" },
  { label: "january-fact", summary: "历史 月份：一月发布计划定在周三。", date: "2026-01-01", access: "private" },
  { label: "october-fact", summary: "历史 月份：十月发布计划定在周五。", date: "2026-10-01", access: "private" },
  { label: "fact-a", summary: "联合事实：接口负责人是林。", date: "2026-06-01", access: "private" },
  { label: "fact-b", summary: "联合事实：存储负责人是陈。", date: "2026-06-02", access: "private" },
  { label: "fact-noise", summary: "联合事实：会议室颜色为蓝。", date: "2026-10-31", access: "private" },
  { label: "source-denied", summary: "访问凭据：外部渠道的资料。", date: "2026-10-31", access: "denied" },
  { label: "source-revoked", summary: "访问凭据：已撤回的资料。", date: "2026-10-31", access: "revoked" },
  { label: "source-allowed", summary: "访问凭据：仅此条可以展示。", date: "2026-01-01", access: "private" },
] as const;
export const SHADOW_QUERIES = [
  { name: "old-important", question: "回滚操作必须保留什么校验依据？", tokens: ["回滚", "校验"], relevant: ["rollback-important"], answerable: true },
  { name: "multi-fact", question: "接口和存储分别由谁负责？", tokens: ["联合事实"], relevant: ["fact-a", "fact-b"], answerable: true },
  { name: "updated-contradiction", question: "甲项目当前批准预算是多少？", tokens: ["预算", "甲项目"], relevant: ["budget-update"], answerable: true },
  { name: "historical-time", question: "一月发布计划定在哪一天？", tokens: ["历史", "月份"], relevant: ["january-fact"], answerable: true },
  { name: "access-revocation", question: "有哪些当前允许访问的访问凭据相关记录？", tokens: ["访问凭据"], relevant: ["source-allowed"], answerable: true },
  { name: "unanswerable-with-noisy-match", question: "财务审批负责人是谁？", tokens: ["负责人"], relevant: [], answerable: false },
  { name: "unanswerable-no-match", question: "火星观测站下周值班人是谁？", tokens: ["不存在的天文记录"], relevant: [], answerable: false },
] as const;
export type ReadSignal = { episodeId: string; revision: number; taskId: number; callId: string; kind: "explicit_read"; status: "recorded" | "replayed" | "outside_window" | "unverified"; observedAt?: string };
export function readStrength(signals: readonly ReadSignal[], row: Pick<EpisodeRecord, "id" | "sourceRevision">, now = Date.parse(MEMORY_EVAL_NOW)) {
  const accepted = new Map<string, number>();
  for (const signal of signals) {
    const at = Date.parse(signal.observedAt ?? "");
    if (signal.kind !== "explicit_read" || signal.status !== "recorded" || signal.episodeId !== row.id || signal.revision !== row.sourceRevision
      || !Number.isSafeInteger(signal.taskId) || signal.taskId <= 0 || !signal.callId || !Number.isFinite(at) || at > now) continue;
    const identity = JSON.stringify([signal.episodeId, signal.revision, signal.taskId, signal.callId]);
    if (!accepted.has(identity)) accepted.set(identity, at);
  }
  return Math.min(1, [...accepted.values()].reduce((sum, at) => sum + 2 ** (-(now - at) / 86400000 / SHADOW_POLICY.halfLifeDays), 0));
}
export function shadowRank(rows: EpisodeRecord[], tokens: readonly string[], evidence: Map<string, ReadSignal[]>, variant: "full" | "no-time" | "no-read" | "lexical-only") {
  const now = Date.parse(MEMORY_EVAL_NOW);
  return rows.map((row, index) => {
    const text = `${row.summary} ${JSON.stringify(row.openItems)} ${row.label}`.toLowerCase();
    const lexical = tokens.filter(token => text.includes(token.toLowerCase())).length;
    const time = 2 ** (-Math.max(0, now - Date.parse(row.periodEnd)) / 86400000 / SHADOW_POLICY.halfLifeDays);
    const reads = readStrength(evidence.get(row.label) ?? [], row, now);
    const score = lexical + (variant === "no-time" || variant === "lexical-only" ? 0 : SHADOW_POLICY.timeWeight * time)
      + (variant === "no-read" || variant === "lexical-only" ? 0 : SHADOW_POLICY.readWeight * reads);
    return { row, index, score, components: { lexical, time, reads } };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}
