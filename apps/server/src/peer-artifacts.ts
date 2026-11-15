import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { PEER_JOB_ID, type Runtime } from "@assistant/runtime";
import type { PeerArtifact, PeerArtifactUpload } from "@assistant/contracts";
import { HttpError } from "./errors.js";

const Artifacts = defineDoc<{ items: Array<PeerArtifact & { data: string }> }>({ kind: "app.peer-artifacts", version: 1, scope: "session", initial: () => ({ items: [] }) });
export function validateArtifact(input: PeerArtifactUpload): PeerArtifactUpload {
  if (!input || typeof input.id !== "string" || !PEER_JOB_ID.test(input.id) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(input.name) || [".", ".."].includes(input.name) || typeof input.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) || input.mimeType.length > 100 || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > 1024 * 1024 || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256) || typeof input.data !== "string" || input.data.length > 1398104) throw new HttpError(400, "Invalid artifact metadata or file limit exceeded (1 MiB)");
  const bytes = Buffer.from(input.data, "base64");
  if (bytes.toString("base64") !== input.data || bytes.length !== input.size || createHash("sha256").update(bytes).digest("hex") !== input.sha256) throw new HttpError(400, "Artifact checksum mismatch");
  return input;
}
export async function peerArtifacts(runtime: Runtime, ctx: Context, taskId: string | undefined, input?: PeerArtifactUpload, artifactId?: string) {
  if (input) {
    if (!taskId) throw new HttpError(400, "Task required");
    validateArtifact(input);
    return runtime.root.commit(async tx => {
      const doc = await tx.doc(Artifacts), existing = doc.items.find(item => item.id === input.id);
      if (existing) {
        if (existing.taskId !== taskId || existing.deviceId !== input.deviceId || existing.sha256 !== input.sha256 || existing.name !== input.name || existing.mimeType !== input.mimeType) throw new HttpError(409, "Artifact ID already used");
        const { data: _, ...item } = existing; return { item };
      }
      if (doc.items.filter(item => item.taskId === taskId).length >= 5 || doc.items.reduce((sum, item) => sum + item.size, 0) + input.size > 50 * 1024 * 1024 || doc.items.length >= 500) throw new HttpError(409, "Artifact storage limit reached");
      const item: PeerArtifact = { id: input.id, taskId, deviceId: input.deviceId, name: input.name, mimeType: input.mimeType, size: input.size, sha256: input.sha256, createdAt: new Date().toISOString(), status: "available" };
      doc.items.push({ ...item, data: input.data }); return { item };
    }, ctx);
  }
  const items = (await runtime.harness.snapshot(Artifacts, ctx))?.items.filter(item => !taskId || item.taskId === taskId) ?? [];
  if (artifactId) {
    const item = items.find(item => item.id === artifactId);
    if (!item) throw new HttpError(404, "Artifact not found");
    return { item };
  }
  return { items: items.map(({ data: _, ...item }) => item) };
}
