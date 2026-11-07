import type { ConversationItem } from "@assistant/contracts";

const clock = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" });
const monthDay = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });

/** Whole local days between the conversation start and now; createdAt is the only date the list has. */
function daysAgo(value: string, now: Date): number {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(date)) / 86_400_000);
}

export function historyTime(value: string, now = new Date()): string {
  const days = daysAgo(value, now), date = new Date(value);
  if (!Number.isFinite(days)) return "";
  // Date-only values carry no time of day, so show nothing rather than a fake 08:00.
  if (days === 0) return /T\d/.test(value) ? clock.format(date) : "";
  return days < 7 ? weekday.format(date) : monthDay.format(date);
}

export function historyGroups(items: ConversationItem[], single?: string, now = new Date()): { label: string; items: ConversationItem[] }[] {
  if (single) return items.length ? [{ label: single, items }] : [];
  const groups = new Map<string, ConversationItem[]>();
  for (const item of items) {
    const days = daysAgo(item.createdAt, now);
    const label = days <= 0 ? "今天" : days === 1 ? "昨天" : days < 7 ? "本周" : "更早";
    groups.set(label, [...groups.get(label) ?? [], item]);
  }
  return [...groups].map(([label, grouped]) => ({ label, items: grouped }));
}
