// Fixed synthetic ground truth. This is not a user corpus or a model benchmark.
export const MEMORY_EVAL_VERSION = "synthetic-memory-v1";
export const MEMORY_EVAL_NOW = "2026-11-01T12:00:00.000Z";
export const MEMORY_EVAL_CASES = [
  { name: "old-important-after-230-noise", tokens: ["回滚窗口"], relevant: ["old-important"], limit: 3 },
  { name: "authorized-after-denied-top-k", tokens: ["发布依据"], relevant: ["allowed-evidence"], limit: 3 },
  { name: "synonym-without-lexical-overlap", tokens: ["恢复时限"], relevant: ["old-important"], limit: 3 },
  { name: "bounded-scan-exhausted", tokens: ["扫描预算"], relevant: ["beyond-budget"], limit: 3 },
  { name: "source-revoked", tokens: ["撤回资料"], relevant: [], limit: 3 },
  { name: "remote-source-denied", tokens: ["远端资料"], relevant: [], limit: 3 },
] as const;
export const PERSONAL_EVAL_ITEMS = [
  { id: "old-important", status: "approved", text: "发布事故需要保留回滚窗口。", relevant: true },
  { id: "unapproved", status: "pending", text: "未经批准的候选不能进入提示。", relevant: false },
  { id: "withdrawn", status: "rejected", text: "已撤回的长期记忆。", relevant: false },
  ...Array.from({ length: 8 }, (_, i) => ({ id: `recent-noise-${i}`, status: "approved", text: `近期无关事项${i}：讨论茶杯颜色与摆放。`, relevant: false })),
];
