import { defineDoc } from "@earendil-works/pi-durable";
import type { PeerJob } from "./peer-jobs.js";
import { peerPayloadDigest } from "./peer-scope.js";

/** Fixed source-host policy: no renewal and no offline lease. */
export const PEER_SOURCE_TTL_MS = 15 * 60_000;
export const PEER_SOURCE_READ_TOOLS = ["read", "list_local_skills", "read_local_skill"];
export type PeerSourceAuthority = { id: string; revision: number; expiresAt: number; payloadDigest: string; tools: string[] };
type SourceGrant = { jobId: string; revision: number; revoked: boolean; expiresAt: number; payloadDigest: string; tools: string[];
  origin: { taskId: number; callId: string; conversationId: number }; inputs: Array<{ conversationId: number; entryId: number }> };
/** Private source evidence: never included in serialized PeerJob results. */
export const PeerSourceGrants = defineDoc<{ items: SourceGrant[] }>({ kind: "app.peer-source-grants", version: 1, scope: "session", initial: () => ({ items: [] }) });
export function sourceAuthorityMatches(job: PeerJob, authority: unknown, tool?: string, now = Date.now()): authority is PeerSourceAuthority {
  if (job.source !== "server" || job.targetSession || !authority || typeof authority !== "object") return false;
  const value = authority as Partial<PeerSourceAuthority>;
  return value.id === job.id && Number.isSafeInteger(value.revision) && value.revision! > 0 && typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && value.expiresAt > now
    && value.payloadDigest === peerPayloadDigest(job) && Array.isArray(value.tools) && value.tools.every(name => typeof name === "string" && PEER_SOURCE_READ_TOOLS.includes(name))
    && (tool === undefined || value.tools.includes(tool));
}
