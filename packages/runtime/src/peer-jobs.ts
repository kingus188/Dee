/** Host-created, destination-local read capability. Never accepted from a peer payload. */
export type PeerReadScope = {
  revision: number; policyRevision: string; payloadDigest: string;
  tools: string[]; revoked: boolean; resourceRoot?: string;
};
export type PeerReadPolicy = { revision: string; tools: readonly string[]; resourceRoot?: string };

import { defineDoc } from "@earendil-works/pi-durable";
import type { PeerRequirements, PeerCancellation } from "./peer-boundaries.js";
import type { PeerSession } from "./peer-sessions.js";

export type PeerJob = PeerRequirements & {
  id: string; source: string; target: string; task: string;
  status: "queued" | "running" | "done" | "failed";
  readScope?: PeerReadScope;
  cancellation?: PeerCancellation; executionStartedAt?: string;
  result?: string; conversationId?: number; createdAt: string; updatedAt: string;
  sourceSession?: PeerSession; targetSession?: PeerSession; deliveryError?: string; resultDelivered?: boolean;
};

export const PeerJobs = defineDoc<{ items: PeerJob[] }>({ kind: "app.peer-jobs", version: 1, scope: "session", initial: () => ({ items: [] }) });
