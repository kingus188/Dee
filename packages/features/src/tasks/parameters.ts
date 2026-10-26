import { nextCalendarOccurrence, normalizeCalendar } from "./calendar.js";
// 独立的任务参数校验和时间计算，不依赖模型与数据库。
export function normalizeSchedule(input: { text?: unknown; minutesFromNow?: unknown; everyMinutes?: unknown; calendar?: unknown } | null, now = Date.now()) {
  const text = String(input?.text ?? "").trim();
  if (!text || text.length > 1000) throw new Error("任务内容必须是 1～1000 字");
  if (input?.calendar !== undefined && input.calendar !== null) {
    if (input.minutesFromNow !== undefined || (input.everyMinutes !== undefined && input.everyMinutes !== 0)) throw new Error("日历规则和分钟间隔不能同时指定");
    const calendar = normalizeCalendar(input.calendar);
    return { text, at: nextCalendarOccurrence(calendar, now), everyMinutes: 0, calendar };
  }
  const delay = Number(input?.minutesFromNow);
  const repeat = Number(input?.everyMinutes ?? 0);
  if (!Number.isFinite(delay) || delay < 0.25 || delay > 525600) throw new Error("首次执行时间必须在 0.25～525600 分钟内");
  if (!Number.isFinite(repeat) || repeat < 0 || (repeat > 0 && (repeat < 1 || repeat > 525600))) {
    throw new Error("重复间隔须为 0 或 1～525600 分钟");
  }
  return { text, at: now + Math.round(delay * 60000), everyMinutes: repeat };
}

export function nextOccurrence(previousAt: number, everyMinutes: number, now = Date.now()) {
  if (!Number.isFinite(everyMinutes) || everyMinutes <= 0) return null;
  const interval = Math.round(everyMinutes * 60000);
  return previousAt + Math.max(1, Math.floor((now - previousAt) / interval) + 1) * interval;
}

export function scheduleMatches<T extends { status: string; nextAt: number | null; revision: number }>(item: T | undefined, taskInput: { at: number; revision: number }): item is T {
  return item?.status === "active" && item.nextAt === taskInput.at && item.revision === taskInput.revision;
}

/**
 * Idempotency keys are stored in a plain JSON document. Reject inherited /
 * prototype-mutating property names before attempting a read or write.
 */
export function normalizeRequestId(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 100) throw new Error("requestId 必须是不超过 100 字的字符串");
  if (["__proto__", "prototype", "constructor"].includes(value)) throw new Error("requestId 使用了保留名称");
  return value;
}
