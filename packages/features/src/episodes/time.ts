// Source-message timestamps are not business effective dates or proof of what
// was known then. Never infer dates or supersession from summary prose.
export type EpisodeTimeQuery = { sourceBefore?: string; summaryRecordedBefore?: string };
function normalizeTimestamp(value: string, field: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`${field} 必须是有效且带时区的完整 ISO 时间`);
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3)), offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4));
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) throw new Error(`${field} 日期或时区无效`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} 日期无效`);
  const normalized = parsed.toISOString();
  if (!/^\d{4}-/.test(normalized)) throw new Error(`${field} 超出支持的年份范围`);
  return normalized;
}
export const normalizeSourceBefore = (value: string) => normalizeTimestamp(value, "sourceBefore");
export const normalizeSummaryRecordedBefore = (value: string) => normalizeTimestamp(value, "summaryRecordedBefore");
export function normalizeEpisodeTimeQuery(time?: EpisodeTimeQuery): EpisodeTimeQuery {
  return { sourceBefore: time?.sourceBefore === undefined ? undefined : normalizeSourceBefore(time.sourceBefore),
    summaryRecordedBefore: time?.summaryRecordedBefore === undefined ? undefined : normalizeSummaryRecordedBefore(time.summaryRecordedBefore) };
}
export function verifiedSummaryRecordedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return normalizeSummaryRecordedBefore(value); } catch { return undefined; }
}
export function withinRecordedWindow(recordedAt: string | undefined, before: string) {
  const verified = verifiedSummaryRecordedAt(recordedAt);
  return verified !== undefined && verified <= before;
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
  notice: "来源创建时间不是事实生效时间；摘要保存时间不是首次获知时间。旧消息可能后来编辑，本查询不重建当时内容或当时已知事实。来源版本及当前可访问性不证明内容为真。入库边界仅筛选现存且当前可访问摘要，不重建已被撤回、遗忘或合并删除的历史知识；更正或合并后新摘要使用新入库时间；该时间取宿主保存时钟，时钟回拨或跨设备时差下不保证事件严格先后。",
};
export function episodeTimeBounds(row: { periodStart: string; periodEnd: string; sourceTimeVerified?: boolean; summaryRecordedAt?: string }, before?: string, recordedBefore?: string) {
  const verified = verifiedSourceTimeRange(row);
  return {
    sourceTime: { start: row.periodStart, end: row.periodEnd, rangeVerified: verified, meaning: "source_message_creation_time" },
    summaryRecordedAt: verifiedSummaryRecordedAt(row.summaryRecordedAt) ?? null,
    recordedTimeVerified: verifiedSummaryRecordedAt(row.summaryRecordedAt) !== undefined,
    recordedTimeMeaning: "current_summary_storage_time",
    ...(recordedBefore ? { withinRecordedWindow: withinRecordedWindow(row.summaryRecordedAt, recordedBefore) } : {}),
    ...(before ? { withinSourceWindow: verified && normalizeSourceBefore(row.periodEnd) <= before } : {}),
  };
}
export function episodeTimeEvidence(row: Parameters<typeof episodeTimeBounds>[0], before?: string, recordedBefore?: string) {
  return { ...EPISODE_TIME_POLICY, ...episodeTimeBounds(row, before, recordedBefore), ...(before ? { sourceBefore: before } : {}), ...(recordedBefore ? { summaryRecordedBefore: recordedBefore } : {}) };
}
