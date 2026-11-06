import test from "node:test";
import assert from "node:assert/strict";
import { createTeamsFetch } from "../dist/teams-throttle.js";

test("all Graph readers share Retry-After, while non-Graph downloads remain independent", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-06T08:00:00Z") });
  let calls = 0;
  const fetch = createTeamsFetch(async () => { calls++; return new Response("", { status: calls === 1 ? 429 : 200, headers: { "Retry-After": "3600" } }); });
  assert.equal((await fetch("https://graph.microsoft.com/v1.0/chats/history/messages")).status, 429);
  for (const path of ["me/chats", "chats/live/messages", "chats/live/messages/id"]) await assert.rejects(fetch("https://graph.microsoft.com/v1.0/" + path), /Retry-After/);
  assert.equal(calls, 1);
  await fetch("https://example.test/already-authorized-file"); assert.equal(calls, 2);
  t.mock.timers.tick(3600_000); await fetch("https://graph.microsoft.com/v1.0/me/chats"); assert.equal(calls, 3);
});

test("Retry-After HTTP dates and malformed headers have bounded nonzero fallback", async t => {
  const now = Date.parse("2026-11-06T08:00:00Z"); t.mock.timers.enable({ apis: ["Date"], now });
  for (const value of [new Date(now + 120_000).toUTCString(), "invalid"]) {
    const fetch = createTeamsFetch(async () => new Response("", { status: 503, headers: { "retry-after": value } }));
    await fetch("https://graph.microsoft.com/v1.0/me");
    await assert.rejects(fetch("https://graph.microsoft.com/v1.0/me"), error => {
      assert.equal((error as Error & { retryAfterMs: number }).retryAfterMs, value === "invalid" ? 60_000 : 120_000); return true;
    });
  }
});
