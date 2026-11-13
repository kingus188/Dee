import test from "node:test";
import assert from "node:assert/strict";
import { nativeRuns } from "../dist/agents/runs.js";
import type { StoredAgentSession } from "../dist/agents/store.js";

test("native run projection keeps outcomes separate and never treats a final session status as every result", () => {
  const session: StoredAgentSession = {
    id: "local", nativeId: "native", binding: "{}", status: "done", activities: [],
    requests: { success: { status: "done" }, failure: { status: "failed" }, cancelled: { status: "cancelled" }, lost: { status: "interrupted" } },
    messages: [
      { id: "legacy", role: "user", text: "old" },
      { id: "success", role: "user", text: "make file" }, { id: "success:reply", role: "assistant", text: "created" },
      { id: "failure", role: "user", text: "failed work" }, { id: "failure:reply", role: "assistant", text: "partial" },
      { id: "cancelled", role: "user", text: "stop" }, { id: "lost", role: "user", text: "unknown" },
    ],
  };
  const runs = nativeRuns(session, "codex");
  assert.deepEqual(runs.map(run => run.status), ["unknown", "succeeded", "failed", "cancelled", "interrupted"]);
  assert.equal(runs[0]!.result, null);
  assert.equal(runs[1]!.result, "created");
  assert.equal(runs[2]!.result, "partial");
  assert.equal(runs[3]!.cancellation, "confirmed");
  assert.equal(runs[4]!.cancellation, "unknown");
  assert.ok(runs.every(run => run.review === "unsupported" && run.sessionId === "local" && run.nativeSessionId === "native"));
});

test("empty and old native sessions never fabricate executions", () => {
  assert.deepEqual(nativeRuns(undefined, "claude"), []);
  assert.deepEqual(nativeRuns({ id: "old", binding: "{}", status: "done", messages: [], activities: [] }, "claude"), []);
});

test("request prefixes do not double-attribute replies", () => {
  const session: StoredAgentSession = { id: "local", binding: "{}", status: "done", activities: [], requests: { a: { status: "done" }, "a:b": { status: "done" } }, messages: [
    { id: "a", role: "user", text: "first" }, { id: "a:reply", role: "assistant", text: "first result" },
    { id: "a:b", role: "user", text: "second" }, { id: "a:b:reply", role: "assistant", text: "second result" },
  ] };
  assert.deepEqual(nativeRuns(session, "codex").map(run => run.result), ["first result", "second result"]);
});
