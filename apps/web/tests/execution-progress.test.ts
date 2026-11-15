import test from "node:test";
import assert from "node:assert/strict";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { executionProgress } from "../dist/desktop/progress.js";
const now = Date.parse("2026-11-14T12:00:00Z");
const snapshot = { busy: true, external: { status: "running", approvals: [], activities: [], progress: { requestId: "r", startedAt: new Date(now - 180_000).toISOString() } } } as unknown as DesktopAgentSnapshot;
test("silence is observational and approvals are not mistaken for stalled execution", () => {
  assert.deepEqual(executionProgress(snapshot, now), { waitingFor: "Execution result", elapsedSeconds: 180, quietSeconds: 180, quiet: true, activity: undefined });
  assert.equal(executionProgress({ ...snapshot, external: { ...snapshot.external!, approvals: [{ id: "a", title: "Allow", detail: "" }] } }, now).quiet, false);
  assert.equal(executionProgress({ ...snapshot, busy: false }, now).quiet, false);
});
test("tool progress and recent provider output override silence without depending on server connectivity", () => {
  const result = executionProgress({ ...snapshot, serverConnected: false, external: { ...snapshot.external!, activities: [{ id: "t", title: "Build", status: "running" }], progress: { ...snapshot.external!.progress!, lastEventAt: new Date(now - 10_000).toISOString() } } }, now);
  assert.equal(result.waitingFor, "Tool result"); assert.equal(result.activity, "Build"); assert.equal(result.quiet, false);
  assert.equal(executionProgress({ busy: true } as DesktopAgentSnapshot, now).quietSeconds, undefined);
});
