// Fixed source-time availability truth, not truth about when facts were valid.
export const TIME_EVAL_VERSION = "synthetic-source-time-v1";
export const JANUARY_CUTOFF = "2026-01-31T23:59:59.000Z";
export const TIME_EVAL_ROWS = [
  { label: "january", summary: "预算窗口：一月记录额度30。", start: "2026-01-02T10:00:00Z", end: "2026-01-02T10:05:00Z", trusted: true, access: "private", historical: true },
  { label: "inclusive-boundary", summary: "预算窗口：一月底补充审批条件。", start: "2026-01-31T23:00:00Z", end: JANUARY_CUTOFF, trusted: true, access: "private", historical: true },
  { label: "october-update", summary: "预算窗口：十月记录额度20，和旧记录不同。", start: "2026-10-01T10:00:00Z", end: "2026-10-01T10:05:00Z", trusted: true, access: "private", historical: false },
  { label: "cross-boundary", summary: "预算窗口：跨一月与二月合并的讨论。", start: "2026-01-30T10:00:00Z", end: "2026-02-02T10:00:00Z", trusted: true, access: "private", historical: false },
  { label: "legacy-unknown", summary: "预算窗口：旧摘要显示一月，但完整来源时间未核实。", start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z", trusted: false, access: "private", historical: false },
  { label: "revoked-january", summary: "预算窗口：已撤回的一月资料。", start: "2026-01-03T10:00:00Z", end: "2026-01-03T10:05:00Z", trusted: true, access: "revoked", historical: false },
  { label: "denied-january", summary: "预算窗口：外部受限的一月资料。", start: "2026-01-04T10:00:00Z", end: "2026-01-04T10:05:00Z", trusted: true, access: "denied", historical: false },
] as const;
