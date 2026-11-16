import { createHash } from "node:crypto";
import type { PeerJob } from "./peer-jobs.js";

import type { PeerReadPolicy, PeerReadScope } from "./peer-jobs.js";
export type { PeerReadPolicy, PeerReadScope } from "./peer-jobs.js";

// Includes the address and workspace contract, not just the model-written task.
export function peerPayloadDigest(job: PeerJob): string {
  return createHash("sha256").update(JSON.stringify([job.id, job.source, job.target, job.task,
    job.workspace ?? null, job.constraints ?? null, job.acceptanceCriteria ?? null,
    job.sourceSession ? [job.sourceSession.agent, job.sourceSession.sessionId] : null,
    job.targetSession ? [job.targetSession.agent, job.targetSession.sessionId] : null])).digest("hex");
}
export function createPeerReadScope(job: PeerJob, policy: PeerReadPolicy): PeerReadScope {
  return { revision: 1, policyRevision: policy.revision, payloadDigest: peerPayloadDigest(job), tools: [...new Set(policy.tools)], revoked: false, ...(policy.resourceRoot ? { resourceRoot: policy.resourceRoot } : {}) };
}
export function peerScopeAllows(job: PeerJob, policy: PeerReadPolicy | undefined, tool?: string, revision?: number): boolean {
  const scope = job.readScope;
  return !!scope && !!policy && !scope.revoked && !job.cancellation && !["done", "failed"].includes(job.status)
    && scope.policyRevision === policy.revision && scope.resourceRoot === policy.resourceRoot && scope.payloadDigest === peerPayloadDigest(job)
    && (revision === undefined || scope.revision === revision)
    // Re-read the destination cap: persisted capabilities can shrink, never expand.
    && (tool === undefined || scope.tools.includes(tool) && policy.tools.includes(tool));
}
