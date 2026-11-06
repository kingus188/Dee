import type { TeamsSyncSettings } from "@assistant/contracts";
import { HttpError } from "./errors.js";

const MINUTE = 60_000;
const MAX_BACKOFF = 60 * MINUTE;
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const fields = ["enabled", "timeZone", "workDays", "workStart", "workEnd", "workIntervalMinutes", "offHoursIntervalMinutes", "archiveIntervalMinutes", "normalDigestMinutes"];

export const defaultTeamsSyncSettings: TeamsSyncSettings = {
  enabled: true,
  timeZone: "Asia/Shanghai",
  workDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  workIntervalMinutes: 2,
  offHoursIntervalMinutes: 15,
  archiveIntervalMinutes: 30,
  normalDigestMinutes: 30,
};

/** Validate a complete settings replacement; never coerce strings or fill missing fields. */
export function validateTeamsSyncSettings(input: unknown): TeamsSyncSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Teams 同步设置无效");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) {
    throw new HttpError(400, "请提供完整的 Teams 同步设置，不能包含未知字段");
  }
  if (typeof value.enabled !== "boolean") throw new HttpError(400, "Teams 自动同步开关无效");
  if (typeof value.timeZone !== "string" || !value.timeZone || value.timeZone.length > 100 || value.timeZone.trim() !== value.timeZone || /^[+-]/.test(value.timeZone)) {
    throw new HttpError(400, "请输入有效的 IANA 时区");
  }
  try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format(0); }
  catch { throw new HttpError(400, "请输入有效的 IANA 时区"); }
  if (!Array.isArray(value.workDays) || value.workDays.length > 7 || Array.from(value.workDays).some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(value.workDays).size !== value.workDays.length) {
    throw new HttpError(400, "工作日须为不重复的 1–7 整数，周一为 1、周日为 7");
  }
  if (typeof value.workStart !== "string" || typeof value.workEnd !== "string" || !clock.test(value.workStart) || !clock.test(value.workEnd) || value.workStart === value.workEnd) {
    throw new HttpError(400, "工作时段须为不同的 HH:mm 时间");
  }
  const interval = (key: string, min: number, max: number) => {
    const number = value[key];
    if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
      throw new HttpError(400, `${key} 须为 ${min}–${max} 分钟的整数`);
    }
    return number;
  };
  const workIntervalMinutes = interval("workIntervalMinutes", 1, 60);
  const offHoursIntervalMinutes = interval("offHoursIntervalMinutes", 5, 120);
  const archiveIntervalMinutes = interval("archiveIntervalMinutes", 5, 1440);
  // Sources expire at 24 hours; leave room for off-hours polling and retry.
  const normalDigestMinutes = interval("normalDigestMinutes", 5, 720);
  if (offHoursIntervalMinutes < workIntervalMinutes || archiveIntervalMinutes < workIntervalMinutes) {
    throw new HttpError(400, "非工作时段和历史归档不能比工作时段同步更频繁");
  }
  return { enabled: value.enabled, timeZone: value.timeZone, workDays: [...value.workDays], workStart: value.workStart,
    workEnd: value.workEnd, workIntervalMinutes, offHoursIntervalMinutes, archiveIntervalMinutes, normalDigestMinutes };
}

const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function working(settings: TeamsSyncSettings, now: number): boolean {
  if (!Number.isFinite(now)) throw new RangeError("同步时间无效");
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value;
  const day = weekdays[part("weekday")], time = `${part("hour")}:${part("minute")}`;
  if (settings.workStart < settings.workEnd) return settings.workDays.includes(day) && time >= settings.workStart && time < settings.workEnd;
  // Overnight work belongs to the day it starts, including across week boundaries.
  return time >= settings.workStart ? settings.workDays.includes(day)
    : time < settings.workEnd && settings.workDays.includes(day === 1 ? 7 : day - 1);
}

function backoff(base: number, failures: number, retryAfterMs: number): number {
  if (!Number.isSafeInteger(failures) || failures < 0 || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) throw new RangeError("同步重试参数无效");
  // The one-hour cap limits exponential growth, not a longer configured cadence
  // or the server's Retry-After. Neither may be shortened by a failure.
  return Math.max(base, Math.min(MAX_BACKOFF, base * 2 ** Math.min(failures, 16)), retryAfterMs);
}

/** The scheduler handles enabled=false. Manual refresh does not use this delay. */
export function syncDelay(settings: TeamsSyncSettings, now: number, failures = 0, retryAfterMs = 0): number {
  return backoff((working(settings, now) ? settings.workIntervalMinutes : settings.offHoursIntervalMinutes) * MINUTE, failures, retryAfterMs);
}

/** Archive recovery stays independent of work hours, notification quiet hours and digests. */
export function archiveSyncDelay(settings: TeamsSyncSettings, failures = 0, retryAfterMs = 0): number {
  return backoff(settings.archiveIntervalMinutes * MINUTE, failures, retryAfterMs);
}
