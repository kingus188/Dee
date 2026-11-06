import assert from "node:assert/strict";
import test from "node:test";
import { archiveSyncDelay, defaultTeamsSyncSettings, syncDelay, validateTeamsSyncSettings } from "../dist/teams-sync-policy.js";

const minute = 60_000;
const defaults = () => validateTeamsSyncSettings(defaultTeamsSyncSettings);
const at = (value: string) => Date.parse(value);

test("Teams 低打扰默认频次与设置数组不共享", () => {
  const settings = defaults();
  assert.deepEqual(settings, { enabled: true, timeZone: "Asia/Shanghai", workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "18:00",
    workIntervalMinutes: 2, offHoursIntervalMinutes: 15, archiveIntervalMinutes: 30, normalDigestMinutes: 30 });
  settings.workDays.push(7);
  assert.deepEqual(defaults().workDays, [1, 2, 3, 4, 5]);
});

test("Teams 工作日按设置时区计算，工作起点包含终点排除", () => {
  const settings = defaults();
  for (const [time, delay] of [
    ["2026-11-06T00:59:59Z", 15], ["2026-11-06T01:00:00Z", 2], ["2026-11-06T09:59:59Z", 2],
    ["2026-11-06T10:00:00Z", 15], ["2026-11-07T01:00:00Z", 15], ["2026-11-08T01:00:00Z", 15],
  ] as const) assert.equal(syncDelay(settings, at(time)), delay * minute, time);
  assert.equal(syncDelay({ ...settings, workDays: [] }, at("2026-11-06T02:00:00Z")), 15 * minute);
  assert.equal(syncDelay({ ...settings, workDays: [7] }, at("2026-11-08T02:00:00Z")), 2 * minute);
});

test("跨午夜工作段归属开始日，周日凌晨和跨周一均不误判", () => {
  const settings = validateTeamsSyncSettings({ ...defaults(), timeZone: "UTC", workDays: [5, 7], workStart: "22:00", workEnd: "06:00" });
  for (const [time, delay] of [
    ["2026-11-06T21:59:59Z", 15], ["2026-11-06T22:00:00Z", 2], ["2026-11-07T05:59:59Z", 2],
    ["2026-11-07T06:00:00Z", 15], ["2026-11-08T02:00:00Z", 15], ["2026-11-08T22:00:00Z", 2],
    ["2026-11-09T05:59:59Z", 2], ["2026-11-09T06:00:00Z", 15],
  ] as const) assert.equal(syncDelay(settings, at(time)), delay * minute, time);
});

test("夏令时跳时与回拨按真实瞬间判断，不使用服务器本地时区", () => {
  const settings = validateTeamsSyncSettings({ ...defaults(), timeZone: "America/New_York", workDays: [7], workStart: "01:30", workEnd: "03:30" });
  for (const time of ["2026-11-01T05:45:00Z", "2026-11-01T06:45:00Z", "2026-03-08T06:45:00Z", "2026-03-08T07:00:00Z"]) {
    assert.equal(syncDelay(settings, at(time)), 2 * minute, time);
  }
  assert.equal(syncDelay(settings, at("2026-03-08T07:30:00Z")), 15 * minute);
});

test("完整设置严格校验，不接受隐式转换、未知字段或无效范围", () => {
  const base = defaults();
  const invalid: unknown[] = [null, undefined, [], "settings", {}, { ...base, extra: true }];
  for (const key of Object.keys(base)) { const missing = { ...base } as Record<string, unknown>; delete missing[key]; invalid.push(missing); }
  for (const patch of [
    { enabled: "true" }, { timeZone: "" }, { timeZone: "Invalid/Zone" }, { timeZone: " UTC" }, { timeZone: "+08:00" }, { timeZone: 8 },
    { workDays: [0] }, { workDays: [8] }, { workDays: [1, 1] }, { workDays: [1.5] }, { workDays: ["1"] }, { workDays: "1,2" }, { workDays: Array(1) },
    { workStart: "9:00" }, { workStart: "24:00" }, { workEnd: "18:60" }, { workEnd: "09:00" }, { workEnd: null },
    { workIntervalMinutes: 0 }, { workIntervalMinutes: 61 }, { workIntervalMinutes: 2.5 }, { workIntervalMinutes: "2" }, { workIntervalMinutes: NaN },
    { offHoursIntervalMinutes: 4 }, { offHoursIntervalMinutes: 121 }, { offHoursIntervalMinutes: Infinity },
    { archiveIntervalMinutes: 4 }, { archiveIntervalMinutes: 1441 }, { normalDigestMinutes: 4 }, { normalDigestMinutes: 721 },
    { workIntervalMinutes: 20, offHoursIntervalMinutes: 15 }, { workIntervalMinutes: 40, offHoursIntervalMinutes: 60, archiveIntervalMinutes: 30 },
  ]) invalid.push({ ...base, ...patch });
  for (const value of invalid) assert.throws(() => validateTeamsSyncSettings(value), { status: 400 });
  assert.doesNotThrow(() => validateTeamsSyncSettings({ ...base, enabled: false, workDays: [], workIntervalMinutes: 60,
    offHoursIntervalMinutes: 120, archiveIntervalMinutes: 1440, normalDigestMinutes: 720 }));
});

test("失败指数退避在一小时停止增长，但不能缩短服务端 Retry-After 或更慢的配置", () => {
  const settings = defaults(), now = at("2026-11-06T02:00:00Z");
  assert.deepEqual([0, 1, 2, 3, 4, 5, 100].map(failures => syncDelay(settings, now, failures) / minute), [2, 4, 8, 16, 32, 60, 60]);
  assert.equal(syncDelay(settings, now, 0, 30_000), 2 * minute);
  assert.equal(syncDelay(settings, now, 2, 90 * minute), 90 * minute);
  assert.equal(syncDelay({ ...settings, offHoursIntervalMinutes: 120 }, at("2026-11-07T02:00:00Z"), 3), 120 * minute);
  for (const failures of [-1, 1.5, NaN, Infinity]) assert.throws(() => syncDelay(settings, now, failures), RangeError);
  for (const retry of [-1, NaN, Infinity]) assert.throws(() => syncDelay(settings, now, 1, retry), RangeError);
  assert.throws(() => syncDelay(settings, NaN), RangeError);
});

test("历史归档独立低频，关闭开关由调度器处理而非让延迟变零", () => {
  const settings = defaults();
  assert.equal(archiveSyncDelay(settings), 30 * minute);
  assert.equal(archiveSyncDelay(settings, 1), 60 * minute);
  assert.equal(archiveSyncDelay(settings, 10, 90 * minute), 90 * minute);
  assert.equal(archiveSyncDelay({ ...settings, archiveIntervalMinutes: 1440 }, 10), 1440 * minute);
  const now = at("2026-11-06T02:00:00Z");
  assert.equal(syncDelay({ ...settings, enabled: false, normalDigestMinutes: 120 }, now), 2 * minute);
  assert.equal(archiveSyncDelay({ ...settings, workIntervalMinutes: 60, normalDigestMinutes: 120 }), 30 * minute);
});
