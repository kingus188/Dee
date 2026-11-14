import { createHash } from "node:crypto";
import type { DesktopConversation, DesktopConversationUpload } from "@assistant/contracts";
import type { Runtime, PeerSessionInfo } from "@assistant/runtime";
import { defineDoc, type Cursor, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

export type ConversationSyncMode = "local" | "summary" | "full";
export type ConversationSyncPolicy = { mode: ConversationSyncMode; summary?: string };
export type ConversationSyncSnapshot = {
  mode: ConversationSyncMode; summary: string; serverId?: string;
  revision: number; sentRevision: number; previouslyShared: boolean;
  status: "local" | "pending" | "synced";
};
type Pending = { serverId?: string; digest: string; revision: number; sentRevision: number; mode?: ConversationSyncMode; summary?: string; shared?: boolean };
const SyncState = defineDoc<{ sessions: Record<string, Pending> }>({ kind: "app.desktop-conversation-sync", version: 1, scope: "session", initial: () => ({ sessions: {} }) });
// Existing v1 records predate scope controls and retain their explicitly visible full-sync behavior.
const modeOf = (record: Pending | undefined): ConversationSyncMode => record ? record.mode ?? "full" : "local";
const queues = new WeakMap<Runtime, Promise<unknown>>();
function serialized<T>(runtime: Runtime, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(runtime) ?? Promise.resolve()).catch(() => {}).then(action);
  queues.set(runtime, next);
  void next.finally(() => { if (queues.get(runtime) === next) queues.delete(runtime); }).catch(() => {});
  return next;
}
function snapshot(record: Pending | undefined): ConversationSyncSnapshot {
  const mode = modeOf(record), revision = record?.revision ?? 0, sentRevision = record?.sentRevision ?? 0;
  return { mode, summary: record?.summary ?? "", ...(record?.serverId ? { serverId: record.serverId } : {}), revision, sentRevision,
    previouslyShared: Boolean(record?.shared || sentRevision > 0 || (record?.serverId && !record.mode)),
    status: mode === "local" ? "local" : record?.digest && sentRevision === revision ? "synced" : "pending" };
}
function projection(session: DesktopConversation, record: Pending): DesktopConversation {
  return modeOf(record) === "summary"
    ? { sessionId: session.sessionId, agent: session.agent, messages: [{ id: "shared-summary", role: "assistant", text: "User-shared summary and results:\n" + record.summary! }] }
    : session;
}
const digestOf = (session: DesktopConversation) => createHash("sha256").update(JSON.stringify(session)).digest("hex");
export async function getConversationSync(runtime: Runtime, sessionId: string, current?: DesktopConversation): Promise<ConversationSyncSnapshot> {
  const record = (await runtime.harness.snapshot(SyncState, ctx))?.sessions[sessionId];
  const result = snapshot(record);
  // Local changes must be visible while offline, before a sync attempt can assign a revision.
  if (current && current.sessionId !== sessionId) throw new Error("Conversation address does not match sync state");
  if (current && record && result.status === "synced" && digestOf(projection(current, record)) !== record.digest) result.status = "pending";
  return result;
}
export async function setConversationSync(runtime: Runtime, sessionId: string, input: ConversationSyncPolicy): Promise<ConversationSyncSnapshot> {
  if (!/^(?:pi-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(sessionId)) throw new Error("Invalid conversation address");
  if (!input || !["local", "summary", "full"].includes(input.mode) || (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 32000))) throw new Error("Invalid conversation sync policy");
  if (input.mode === "summary" && !input.summary?.trim()) throw new Error("Enter the summary and results to share");
  // Await any in-flight upload before acknowledging a narrower scope. No background upload
  // can continue using its prior payload after this call has resolved.
  return serialized(runtime, () => runtime.root.commit(async tx => {
    const state = await tx.doc(SyncState);
    state.sessions[sessionId] ??= { mode: "local", digest: "", revision: 0, sentRevision: 0 };
    const record = state.sessions[sessionId]!;
    if (modeOf(record) !== input.mode || (input.mode === "summary" && record.summary !== input.summary)) record.digest = "";
    if (record.serverId && record.mode === undefined) record.shared = true;
    record.mode = input.mode;
    if (input.mode === "summary") record.summary = input.summary!;
    else delete record.summary;
    return snapshot(record);
  }, ctx));
}
export async function peerSessionsForServer(runtime: Runtime, serverId: string, sessions: PeerSessionInfo[]): Promise<PeerSessionInfo[]> {
  return serialized(runtime, () => runtime.root.commit(async tx => {
    const state = await tx.doc(SyncState), items: PeerSessionInfo[] = [];
    for (const session of sessions) {
      const record = state.sessions[session.sessionId];
      if (!record || modeOf(record) === "local") continue;
      record.serverId ??= serverId;
      if (record.serverId === serverId) items.push({ ...session });
    }
    return items;
  }, ctx));
}
export async function piConversation(runtime: Runtime, id: ConversationId = runtime.root.id): Promise<DesktopConversation> {
  const conversation = (await runtime.harness.conversation(id, ctx))!;
  const messages: DesktopConversation["messages"] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 200, cursor, ctx);
    for (const entry of page.items) {
      if (entry.kind === "app.peer-result" && entry.data && typeof entry.data === "object" && "text" in entry.data && typeof entry.data.text === "string") messages.push({ id: `${entry.id}:0`, role: "assistant", text: entry.data.text });
      for (const [index, message] of (entry.model ?? []).entries()) {
        if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") continue;
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("");
        if (text) messages.push({ id: `${entry.id}:${index}`, role: message.role, text });
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return { sessionId: `pi-${id}`, agent: "pi", messages };
}

export async function syncConversations(options: {
  runtime: Runtime; deviceId: string; serverId: string; sessions: DesktopConversation[];
  request(path: string, body: DesktopConversationUpload, serverId: string): Promise<unknown>;
}) {
  return serialized(options.runtime, async () => {
    for (const session of options.sessions) {
      const prepared = await options.runtime.root.commit(async tx => {
        const record = (await tx.doc(SyncState)).sessions[session.sessionId];
        const mode = modeOf(record);
        if (!record || mode === "local") return null;
        record.serverId ??= options.serverId;
        if (record.serverId !== options.serverId) return null;
        const projected = projection(session, record);
        if (!projected.messages.length) return null;
        const digest = digestOf(projected);
        if (record.digest !== digest) { record.digest = digest; record.revision++; }
        if (record.sentRevision >= record.revision) return null;
        // A failed acknowledgement cannot establish that the server did not retain the payload.
        record.shared = true;
        return { record: { ...record }, projected };
      }, ctx);
      if (!prepared) continue;
      const { record, projected } = prepared;
      const body = { ...projected, deviceId: options.deviceId, revision: record.revision };
      const response = await options.request("/api/peers/conversations", body, record.serverId!) as { revision?: number } | null;
      if (response?.revision !== record.revision) throw new Error("服务器尚未确认保存对话");
      await options.runtime.root.commit(async tx => {
        const current = (await tx.doc(SyncState)).sessions[session.sessionId]!;
        current.sentRevision = Math.max(current.sentRevision, record.revision);
        current.shared = true;
      }, ctx);
    }
  });
}
