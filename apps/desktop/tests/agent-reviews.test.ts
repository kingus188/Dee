import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentSessionStore } from "../dist/agents/store.js";
import { reviewResult, validReviewHistory } from "../dist/agents/reviews.js";
import { nativeRuns } from "../dist/agents/runs.js";

test("result reviews persist, reject stale writes, preserve versions and never change execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-review-"));
  try {
    const store = openAgentSessionStore(directory);
    const session = store.create(JSON.stringify({kind: "codex"}));
    session.requests = { a: {status: "done"} }; session.status = "done";
    session.messages = [{id: "a", role: "user", text: "task"}, {id: "a:r", role: "assistant", text: "result"}]; store.persist(session);
    const version = nativeRuns(session, "codex")[0]!.resultVersion!;
    const input = {sessionId: session.id, requestId: "a", resultVersion: version, expectedRevision: 0, decision: "rejected" as const, reason: "needs work"};
    reviewResult(session, input, "result", store.persist);
    assert.equal(session.requests.a!.status, "done");
    assert.equal(session.messages.length, 2);
    assert.throws(() => reviewResult(session, input, "result", store.persist), /changed/);
    const restored = openAgentSessionStore(directory).byId(session.id)!;
    assert.equal(nativeRuns(restored, "codex")[0]!.review, "rejected");
    assert.equal(restored.reviews!.a![0]!.reason, "needs work");
    session.messages[1]!.text = "new result";
    assert.equal(nativeRuns(session, "codex")[0]!.review, "pending");
    assert.throws(() => reviewResult(session, {...input, expectedRevision: 1}, "new result", store.persist), /changed/);
    const next = nativeRuns(session, "codex")[0]!;
    reviewResult(session, {...input, resultVersion: next.resultVersion!, expectedRevision: 1, decision: "accepted"}, "new result", store.persist);
    assert.equal(session.reviews!.a!.length, 2);
    const before = structuredClone(session.reviews);
    assert.throws(() => reviewResult(session, {...input, resultVersion: next.resultVersion!, expectedRevision: 2}, "new result", () => {throw new Error("disk");}), /disk/);
    assert.deepEqual(session.reviews, before);
    session.requests.a!.status = "running";
    assert.throws(() => reviewResult(session, {...input, expectedRevision: 2}, "new result", store.persist), /completed/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test("review validation rejects malformed persistence and oversized reasons", () => {
  assert.equal(validReviewHistory({a: [{revision: 2, resultVersion: "a".repeat(64), decision: "accepted", reviewedAt: new Date().toISOString()}]}), false);
  assert.equal(validReviewHistory({a: [{revision: 1, resultVersion: "a".repeat(64), decision: "accepted", reviewedAt: "not a date"}]}), false);
  assert.equal(validReviewHistory({a: [null]}), false);
  assert.equal(validReviewHistory([]), false);
  const session = {id: "s", binding: "{}", status: "done" as const, messages: [{id: "a", role: "user" as const, text: "task"}], activities: [], requests: {a: {status: "done" as const}}};
  const run = nativeRuns(session, "codex")[0]!;
  assert.throws(() => reviewResult(session, {sessionId: "s", requestId: "a", resultVersion: run.resultVersion!, expectedRevision: 0, decision: "accepted", reason: "x".repeat(2001)}, "", () => assert.fail("must not persist")), /Invalid/);
});
