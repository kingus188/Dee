import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule } from "@assistant/features";

function calendar(input: Record<string, unknown>, now: string) {
  return normalizeSchedule({ text: "整理今天的三项重点", ...input } as Parameters<typeof normalizeSchedule>[0], Date.parse(now)) as { text: string; at: number; everyMinutes: number; calendar?: Record<string, unknown> };
}

test("weekday calendar follows local wall time and skips the weekend", () => {
  const rule = { kind: "weekly", time: "08:00", timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] };
  const result = calendar({ calendar: rule }, "2026-10-23T01:00:00Z");
  assert.equal(new Date(result.at).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.deepEqual(result.calendar, rule);
  assert.equal(result.everyMinutes, 0);
});

test("calendar spring DST skips nonexistent times rather than changing wall time", () => {
  const result = calendar({ calendar: { kind: "daily", time: "02:30", timeZone: "America/New_York" } }, "2026-03-08T00:00:00Z");
  assert.equal(new Date(result.at).toISOString(), "2026-03-09T06:30:00.000Z");
});

test("calendar autumn DST fires once at the earlier instant", () => {
  const rule = { kind: "daily", time: "01:30", timeZone: "America/New_York" };
  assert.equal(new Date(calendar({ calendar: rule }, "2026-11-01T00:00:00Z").at).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(new Date(calendar({ calendar: rule }, "2026-11-01T05:45:00Z").at).toISOString(), "2026-11-02T06:30:00.000Z");
});

test("monthly calendars skip missing dates and support leap years", () => {
  const rule = { kind: "monthly", time: "09:15", timeZone: "Asia/Shanghai", monthDay: 31 };
  assert.equal(new Date(calendar({ calendar: rule }, "2026-04-01T00:00:00Z").at).toISOString(), "2026-05-31T01:15:00.000Z");
  assert.equal(new Date(calendar({ calendar: { ...rule, monthDay: 29 } }, "2028-02-01T00:00:00Z").at).toISOString(), "2028-02-29T01:15:00.000Z");
});

test("calendar validates IANA zones, weekday sets and mutually exclusive minute rules", () => {
  for (const invalid of [
    { kind: "daily", time: "24:00", timeZone: "Asia/Shanghai" },
    { kind: "daily", time: "08:00", timeZone: "Invalid/City" },
    { kind: "weekly", time: "08:00", timeZone: "UTC", weekdays: [] },
    { kind: "weekly", time: "08:00", timeZone: "UTC", weekdays: [1, 1] },
    { kind: "monthly", time: "08:00", timeZone: "UTC", monthDay: 32 },
  ]) assert.throws(() => calendar({ calendar: invalid }, "2026-10-23T01:00:00Z"), /日历|时区|星期|日期/);
  assert.throws(() => calendar({ calendar: { kind: "daily", time: "08:00", timeZone: "UTC" }, everyMinutes: 60 }, "2026-10-23T01:00:00Z"), /同时/);
});
