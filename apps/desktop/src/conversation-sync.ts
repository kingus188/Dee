import { createHash } from "node:crypto";
import type { DesktopConversation, DesktopConversationUpload } from "@assistant/contracts";
import type { Runtime, PeerSessionInfo } from "@assistant/runtime";
import { defineDoc, type Cursor, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

type Pending = { serverId: string; digest: string; revision: number; sentRevision: number };
const SyncState = defineDoc<{ sessions: Record<string, Pending> }>({ kind: "app.desktop-conversation-sync", version: 1, scope: "session", initial: () => ({ sessions: {} }) });

export async function peerSessionsForServer(runtime: Runtime, serverId: string, sessions: PeerSessionInfo[]): Promise<PeerSessionInfo[]> {
  return runtime.root.commit(async tx => {
    const state = await tx.doc(SyncState), items: PeerSessionInfo[] = [];
    for (const session of sessions) {
      state.sessions[session.sessionId] ??= { serverId, digest: "", revision: 0, sentRevision: 0 };
      if (state.sessions[session.sessionId]!.serverId === serverId) items.push({ ...session });
    }
    return items;
  }, ctx);
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
  for (const session of options.sessions) {
    if (!session.messages.length) continue;
    const digest = createHash("sha256").update(JSON.stringify(session)).digest("hex");
    const pending = await options.runtime.root.commit(async tx => {
      const state = await tx.doc(SyncState);
      state.sessions[session.sessionId] ??= { serverId: options.serverId, digest: "", revision: 0, sentRevision: 0 };
      // The setter copies new input; mutate the document draft, not the assigned object.
      const record = state.sessions[session.sessionId]!;
      // A conversation stays with its original server when the desktop connection changes.
      if (record.serverId !== options.serverId) return null;
      if (record.digest !== digest) { record.digest = digest; record.revision++; }
      return record.sentRevision < record.revision ? { ...record } : null;
    }, ctx);
    if (!pending) continue;
    const body = { ...session, deviceId: options.deviceId, revision: pending.revision };
    const response = await options.request("/api/peers/conversations", body, pending.serverId) as { revision?: number } | null;
    if (response?.revision !== pending.revision) throw new Error("服务器尚未确认保存对话");
    await options.runtime.root.commit(async tx => {
      const record = (await tx.doc(SyncState)).sessions[session.sessionId]!;
      record.sentRevision = Math.max(record.sentRevision, pending.revision);
    }, ctx);
  }
}
