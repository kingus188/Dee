import type { NotificationQuietHours } from "@assistant/contracts";
import { HttpError } from "./errors.js";

export function validateQuietHours(value: unknown): NotificationQuietHours {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "免打扰设置无效");
  const { enabled, start, end, timeZone } = value as Record<string, unknown>;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof enabled !== "boolean" || typeof start !== "string" || typeof end !== "string" || !time.test(start) || !time.test(end)) {
    throw new HttpError(400, "免打扰时间须为 HH:mm 格式");
  }
  if (start === end) throw new HttpError(400, "免打扰起止时间须不同");
  if (typeof timeZone !== "string" || !timeZone || timeZone.length > 100) throw new HttpError(400, "请输入有效的 IANA 时区");
  try { new Intl.DateTimeFormat("en", { timeZone }).format(0); }
  catch { throw new HttpError(400, "请输入有效的 IANA 时区"); }
  return { enabled, start, end, timeZone };
}

// Walk real minutes instead of constructing ambiguous wall times at DST gaps/folds.
export function nextNotificationAt(quiet: NotificationQuietHours, at: number): number {
  if (!quiet.enabled) return at;
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const inside = (time: number) => {
    const local = format.format(time);
    return quiet.start < quiet.end ? local >= quiet.start && local < quiet.end : local >= quiet.start || local < quiet.end;
  };
  if (!inside(at)) return at;
  let candidate = Math.floor(at / 60000) * 60000 + 60000;
  // A daily window is shorter than a day. Two real days also cover timezone transitions.
  for (let minute = 0; minute < 2880; minute++, candidate += 60000) if (!inside(candidate)) return candidate;
  throw new Error("免打扰窗口未找到结束时间");
}
