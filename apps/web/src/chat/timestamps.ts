const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const calendar = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });

function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// Use source timestamps only. Older history and live replies may not have one.
export function chatTimestamp(timestamp: number | undefined, now = new Date()) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const day = dayKey(date), fullDate = calendar.format(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return {
    iso: date.toISOString(), day, time: clock.format(date), fullDate,
    dayLabel: day === dayKey(now) ? "今天" : day === dayKey(yesterday) ? "昨天" : fullDate,
  };
}
