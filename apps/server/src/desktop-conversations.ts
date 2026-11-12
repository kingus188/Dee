import type { Context } from "@earendil-works/chord";
import type { DesktopConversationUpload } from "@assistant/contracts";
import { Index, PEER_DEVICE_ID, peerTranscript, validPeerSession, type Runtime } from "@assistant/runtime";
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { HttpError } from "./errors.js";
import type { PeerSession, PeerSessionInfo, PeerTranscript } from "@assistant/runtime";
import { isDeepStrictEqual } from "node:util";

const Sessions = defineDoc<{ ids: Record<string, ConversationId> }>({ kind: "app.desktop-conversations", version: 1, scope: "session", initial: () => ({ ids: {} }) });
export const DesktopTranscript = defineDoc<{ value: DesktopConversationUpload | null }>({ kind: "app.desktop-transcript", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ value: null }) });
const PeerSessionCatalog = defineDoc<{ devices: Record<string, { items: PeerSessionInfo[]; syncedAt: string }> }>({ kind: "app.peer-session-catalog", version: 1, scope: "session", initial: () => ({ devices: {} }) });

export async function savePeerSessionCatalog(context: Runtime & { ctx: Context }, body: Record<string, unknown>) {
  if (typeof body.deviceId !== "string" || !PEER_DEVICE_ID.test(body.deviceId) || !Array.isArray(body.items) || body.items.length > 500) throw new HttpError(400, "Agent 会话目录无效或超过五百条");
  const ids = new Set<string>();
  const items: PeerSessionInfo[] = body.items.map((item: unknown) => {
    if (!validPeerSession(item) || ids.has(item.sessionId)) throw new HttpError(400, "Agent 会话目录地址无效或重复");
    ids.add(item.sessionId);
    const status = (item as PeerSessionInfo).status;
    if (status !== undefined && !["idle", "running", "waiting", "done", "failed", "cancelled", "interrupted"].includes(status)) throw new HttpError(400, "Agent 会话目录状态无效");
    return { agent: item.agent, sessionId: item.sessionId, ...(status ? { status } : {}) };
  });
  const device = body.deviceId;
  await context.root.commit(async tx => {
    const doc = await tx.doc(PeerSessionCatalog);
    if (!doc.devices[device] && Object.keys(doc.devices).length >= 100) throw new HttpError(409, "登记设备数量已达上限");
    doc.devices[device] = { items, syncedAt: new Date().toISOString() };
  }, context.ctx);
  return { count: items.length };
}

export async function desktopPeerSessions(context: Runtime & { ctx: Context }, deviceId: string, session?: PeerSession): Promise<PeerSessionInfo[] | PeerTranscript> {
  const ids = (await context.harness.snapshot(Sessions, context.ctx))?.ids ?? {};
  const visible = new Set((await context.harness.snapshot(Index, context.ctx))?.items.filter(item => !item.archivedAt).map(item => item.id));
  const catalog = (await context.harness.snapshot(PeerSessionCatalog, context.ctx))?.devices[deviceId];
  const items: PeerSessionInfo[] = (catalog?.items ?? []).filter(item => !ids[`${deviceId}/${item.sessionId}`] || visible.has(ids[`${deviceId}/${item.sessionId}`])).map(item => ({ ...item, syncedAt: catalog!.syncedAt }));
  for (const [key, id] of Object.entries(ids)) {
    if (!key.startsWith(`${deviceId}/`) || !visible.has(id)) continue;
    const value = (await context.harness.snapshot(DesktopTranscript, id, context.ctx))?.value;
    if (!value) continue;
    const address = items.find(item => item.sessionId === value.sessionId && item.agent === value.agent) ?? { agent: value.agent, sessionId: value.sessionId, status: "snapshot" };
    if (session?.agent === value.agent && session.sessionId === value.sessionId) return peerTranscript(address, value.messages);
    if (!items.includes(address)) items.push(address);
  }
  if (session) { const empty = items.find(item => item.sessionId === session.sessionId && item.agent === session.agent); if (empty) return { ...empty, messages: [] }; throw new HttpError(404, "本机 Agent 会话尚未同步或已移除"); }
  return items;
}

function parseUpload(body: Record<string, unknown>): DesktopConversationUpload {
  if (typeof body.deviceId !== "string" || !PEER_DEVICE_ID.test(body.deviceId)
    || typeof body.sessionId !== "string" || !/^(?:pi-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(body.sessionId)
    || typeof body.agent !== "string" || !["pi", "codex", "claude", "acp"].includes(body.agent)
    || typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1
    || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) throw new HttpError(400, "本机对话格式无效");
  const ids = new Set<string>();
  const messages = body.messages.map((message: unknown): DesktopConversationUpload["messages"][number] => {
    if (!message || typeof message !== "object") throw new HttpError(400, "本机消息格式无效");
    const item = message as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || item.id.length > 200 || (item.role !== "user" && item.role !== "assistant")
      || typeof item.text !== "string" || item.text.length > 1000000 || ids.has(`${item.role}:${item.id}`)) throw new HttpError(400, "本机消息格式无效");
    ids.add(`${item.role}:${item.id}`);
    return { id: item.id, role: item.role, text: item.text };
  });
  const value: DesktopConversationUpload = { deviceId: body.deviceId, sessionId: body.sessionId, agent: body.agent as DesktopConversationUpload["agent"], revision: body.revision, messages };
  if (Buffer.byteLength(JSON.stringify(value)) > 20 * 1024 * 1024) throw new HttpError(413, "本机对话超过 20 MiB");
  return value;
}

export async function saveDesktopConversation(context: Runtime & { ctx: Context }, body: Record<string, unknown>) {
  const value = parseUpload(body);
  return context.root.commit(async tx => {
    const sessions = await tx.doc(Sessions), index = await tx.doc(Index);
    const key = `${value.deviceId}/${value.sessionId}`;
    let id = sessions.ids[key];
    if (!id) {
      id = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      sessions.ids[key] = id;
      const title = value.messages.find(message => message.role === "user")?.text.trim().slice(0, 48) || "本机对话";
      index.items.push({ id, title, channel: "desktop", createdAt: new Date().toISOString() });
    }
    // Removal is durable: later desktop retries must not restore a removed history item.
    if (!index.items.some(item => item.id === id)) return { id, revision: value.revision, removed: true };
    const doc = await tx.doc(DesktopTranscript, id);
    if (doc.value) {
      if (doc.value.agent !== value.agent || value.revision < doc.value.revision
        || (value.revision === doc.value.revision && !isDeepStrictEqual(doc.value, value))) throw new HttpError(409, "本机对话版本冲突");
      if (value.revision === doc.value.revision) return { id, revision: value.revision };
    }
    doc.value = value;
    return { id, revision: value.revision };
  }, context.ctx);
}
