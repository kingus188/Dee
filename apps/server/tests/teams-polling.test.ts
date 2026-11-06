import assert from "node:assert/strict";
import test from "node:test";
import { startTeamsPolling } from "../dist/teams-polling.js";
import { defaultTeamsSyncSettings } from "../dist/teams-sync-policy.js";

const settled = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
test("adaptive polling is serialized, respects work hours and disabled settings, and stops cleanly", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-06T09:00:00Z") });
  let settings = { ...defaultTeamsSyncSettings, timeZone: "UTC" }, calls = 0;
  const stop = startTeamsPolling({ settings: () => settings, run: async () => { calls++; return { ok: true }; } });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await settled(); };
  try {
    await settled(); assert.equal(calls, 1);
    await advance(119_000); assert.equal(calls, 1);
    await advance(15_000); assert.equal(calls, 2);
    settings = { ...settings, enabled: false };
    await advance(2 * 3600_000); assert.equal(calls, 2);
    settings = { ...settings, enabled: true };
    await advance(15_000); assert.equal(calls, 3);
    await stop(); await advance(3600_000); assert.equal(calls, 3);
  } finally { await stop(); }
});

test("failed polls back off, server Retry-After wins, and archive uses its own slower cadence", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-06T09:00:00Z") });
  const settings = { ...defaultTeamsSyncSettings, timeZone: "UTC" };
  let live = 0, history = 0;
  const stop = startTeamsPolling({ settings: () => settings, run: async () => { live++; return { ok: live > 1, retryAfterMs: live === 1 ? 10 * 60_000 : 0 }; } });
  const stopArchive = startTeamsPolling({ settings: () => settings, archive: true, run: async () => { history++; return { ok: true }; } });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await settled(); };
  try {
    await settled(); assert.equal(live, 1); assert.equal(history, 1);
    await advance(9 * 60_000); assert.equal(live, 1); assert.equal(history, 1);
    await advance(60_000); assert.equal(live, 2); assert.equal(history, 1);
    await advance(20 * 60_000); assert.equal(history, 2);
  } finally { await stop(); await stopArchive(); }
});
