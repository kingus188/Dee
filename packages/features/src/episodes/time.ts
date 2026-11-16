// Source-message timestamps are not business effective dates or proof of what
// was known then. Never infer dates or supersession from summary prose.
export type EpisodeTimeQuery = { sourceBefore?: string };
export function normalizeSourceBefore(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("sourceBefore 必须是有效且带时区的完整 ISO 时间");
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3)), offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4));
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) throw new Error("sourceBefore 日期或时区无效");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("sourceBefore 日期无效");
  const normalized = parsed.toISOString();
  if (!/^\d{4}-/.test(normalized)) throw new Error("sourceBefore 超出支持的年份范围");
  return normalized;
}
export function sourceTimeRange(values: readonly (string | number)[]) {
  if (!values.length) return undefined;
  try {
    const times = values.map(value => typeof value === "number" ? Number.isFinite(value) ? normalizeSourceBefore(new Date(value).toISOString()) : "" : normalizeSourceBefore(value));
    if (times.some(value => !value)) return undefined;
    times.sort();
    return { periodStart: times[0], periodEnd: times.at(-1)!, sourceTimeVerified: true as const };
  } catch { return undefined; }
}
export function verifiedSourceTimeRange(row: { periodStart: string; periodEnd: string; sourceTimeVerified?: boolean }) {
  if (row.sourceTimeVerified !== true) return false;
  try { return normalizeSourceBefore(row.periodStart) <= normalizeSourceBefore(row.periodEnd); } catch { return false; }
}
export const EPISODE_TIME_POLICY = {
  factValidity: "unknown", supersession: "unknown", conflicts: "not_resolved",
  notice: "来源创建时间不是事实生效时间；摘要保存时间不是首次获知时间。旧消息可能后来编辑，本查询不重建当时内容或当时已知事实。来源版本及当前可访问性不证明内容为真。",
};
export function episodeTimeBounds(row: { periodStart: string; periodEnd: string; sourceTimeVerified?: boolean; summaryRecordedAt?: string }, before?: string) {
  const verified = verifiedSourceTimeRange(row);
  return {
    sourceTime: { start: row.periodStart, end: row.periodEnd, rangeVerified: verified, meaning: "source_message_creation_time" },
    summaryRecordedAt: row.summaryRecordedAt ?? null,
    ...(before ? { withinSourceWindow: verified && normalizeSourceBefore(row.periodEnd) <= before } : {}),
  };
}
export function episodeTimeEvidence(row: Parameters<typeof episodeTimeBounds>[0], before?: string) {
  return { ...EPISODE_TIME_POLICY, ...episodeTimeBounds(row, before), ...(before ? { sourceBefore: before } : {}) };
}
