import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSchedule, nextOccurrence, scheduleMatches, normalizeRequestId } from "@assistant/features";

test("仅允许合理延迟与重复间隔", () => {
  const s = normalizeSchedule({ text: "  查新闻 ", minutesFromNow: 2, everyMinutes: 1440 }, 100000);
  assert.deepEqual(s, { text: "查新闻", at: 220000, everyMinutes: 1440 });
  assert.throws(() => normalizeSchedule({ text: "", minutesFromNow: 2 }), /任务内容/);
  assert.throws(() => normalizeSchedule({ text: "x", minutesFromNow: -1 }), /首次执行/);
  assert.throws(() => normalizeSchedule({ text: "x", minutesFromNow: 2, everyMinutes: 0.5 }), /重复间隔/);
  assert.throws(() => normalizeSchedule({ text: "x", minutesFromNow: Infinity }), /首次执行/);
});

test("周期任务跳过停机时错过的时段，不发生补偿风暴", () => {
  assert.equal(nextOccurrence(60000, 1, 200000), 240000);
  assert.equal(nextOccurrence(60000, 1, 60001), 120000);
  assert.equal(nextOccurrence(60000, 0, 200000), null);
});

test("旧版本任务和暂停计划不能触发", () => {
  const item = { status: "active", nextAt: 12345, revision: 2 };
  assert.equal(scheduleMatches(item, { at: 12345, revision: 2 }), true);
  assert.equal(scheduleMatches(item, { at: 12345, revision: 1 }), false);
  assert.equal(scheduleMatches({ ...item, status: "paused" }, { at: 12345, revision: 2 }), false);
});

test("requestId 不能与原型链属性冲突", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.throws(() => normalizeRequestId(key), /requestId/);
  }
  assert.equal(normalizeRequestId("tool:call_123"), "tool:call_123");
  assert.equal(normalizeRequestId(null), null);
  assert.throws(() => normalizeRequestId("a".repeat(101)), /requestId/);
});
