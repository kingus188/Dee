import type { CalendarRule } from "@assistant/contracts";

export function normalizeCalendar(value: unknown): CalendarRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("日历规则格式不正确");
  const rule = value as Record<string, unknown>;
  if (!["daily", "weekly", "monthly"].includes(String(rule.kind)) || typeof rule.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(rule.time)) throw new Error("日历类型或时间格式不正确，应为 HH:mm");
  if (typeof rule.timeZone !== "string" || (rule.timeZone !== "UTC" && !rule.timeZone.includes("/"))) throw new Error("时区必须是 IANA 名称，例如 Asia/Shanghai");
  try { new Intl.DateTimeFormat("en", { timeZone: rule.timeZone }).format(0); } catch { throw new Error("时区名称不正确"); }
  const common = { time: rule.time, timeZone: rule.timeZone };
  if (rule.kind === "weekly") {
    if (!Array.isArray(rule.weekdays) || !rule.weekdays.length || rule.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7) || new Set(rule.weekdays).size !== rule.weekdays.length) throw new Error("星期须为不重复的 1～7，星期一为 1");
    return { kind: "weekly", ...common, weekdays: [...rule.weekdays].sort((a, b) => a - b) };
  }
  if (rule.kind === "monthly") {
    if (!Number.isInteger(rule.monthDay) || Number(rule.monthDay) < 1 || Number(rule.monthDay) > 31) throw new Error("日历日期须为 1～31");
    return { kind: "monthly", ...common, monthDay: Number(rule.monthDay) };
  }
  return { kind: "daily", ...common };
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}
function parts(format: Intl.DateTimeFormat, at: number) {
  const values = Object.fromEntries(format.formatToParts(at).filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! };
}
function clockValue(value: ReturnType<typeof parts>) { return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute); }

/** Missing local times are skipped; repeated local times use the earlier instant once. */
export function nextCalendarOccurrence(input: CalendarRule, after = Date.now()): number {
  const rule = normalizeCalendar(input), format = formatter(rule.timeZone), local = parts(format, after);
  const firstDay = Date.UTC(local.year, local.month - 1, local.day);
  const [hour, minute] = rule.time.split(":").map(Number) as [number, number];
  for (let dayOffset = 0; dayOffset <= 370; dayOffset++) {
    const day = new Date(firstDay + dayOffset * 86400000);
    if (rule.kind === "weekly" && !rule.weekdays.includes(day.getUTCDay() || 7)) continue;
    if (rule.kind === "monthly" && day.getUTCDate() !== rule.monthDay) continue;
    const localAt = day.getTime() + hour * 3600000 + minute * 60000;
    const candidates = new Set<number>();
    // Sample both sides of timezone transitions, then round-trip each candidate.
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = localAt + hours * 3600000;
      const candidate = localAt - (clockValue(parts(format, sample)) - sample);
      if (clockValue(parts(format, candidate)) === localAt) candidates.add(candidate);
    }
    const earlier = Math.min(...candidates);
    if (Number.isFinite(earlier) && earlier > after) return earlier;
  }
  throw new Error("日历规则在未来一年内没有执行时间");
}

export function calendarLabel(rule: CalendarRule): string {
  const kind = rule.kind === "daily" ? "每天" : rule.kind === "monthly" ? `每月 ${rule.monthDay} 日` : `每周 ${rule.weekdays.map(day => "一二三四五六日"[day - 1]).join("、")}`;
  return `${kind} ${rule.time} · ${rule.timeZone}`;
}
