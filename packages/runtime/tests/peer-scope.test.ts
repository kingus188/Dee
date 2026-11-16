import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPeerReadScope, peerScopeAllows } from "../dist/peer-scope.js";
import type { PeerJob } from "@assistant/runtime";

function fixture() {
  const job: PeerJob = { id: randomUUID(), source: "desktop-" + randomUUID(), target: "server", task: "read record", workspace: "/chosen", targetSession: { agent: "pi", sessionId: "pi-2" }, status: "queued", createdAt: "now", updatedAt: "now" };
  const policy = { revision: "v1", tools: ["read_record", "search_record"] };
  job.readScope = createPeerReadScope(job, policy);
  return { job, policy };
}
test("peer capabilities are an intersection, never widened by a later destination policy", () => {
  const { job, policy } = fixture();
  assert.equal(peerScopeAllows(job, policy, "read_record", 1), true);
  assert.equal(peerScopeAllows(job, { ...policy, tools: [...policy.tools, "write_record"] }, "write_record", 1), false);
  assert.equal(peerScopeAllows(job, { ...policy, tools: [] }, "read_record", 1), false);
  assert.equal(peerScopeAllows({ ...job, readScope: undefined }, policy, "read_record"), false);
});
test("revocation, policy revision, payload and resource changes invalidate durable scope", () => {
  const { job, policy } = fixture();
  for (const changed of [ { task: "write instead" }, { workspace: "/other" }, { target: "desktop-" + randomUUID() }, { targetSession: { agent: "pi" as const, sessionId: "pi-3" } } ]) {
    assert.equal(peerScopeAllows({ ...job, ...changed }, policy, "read_record", 1), false);
  }
  assert.equal(peerScopeAllows(job, { ...policy, revision: "v2" }, "read_record", 1), false);
  assert.equal(peerScopeAllows(job, policy, "read_record", 2), false);
  job.readScope!.revoked = true;
  assert.equal(peerScopeAllows(job, policy, "read_record", 1), false);
});
