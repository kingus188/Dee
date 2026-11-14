import type { Context } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import { PEER_DEVICE_ID, PEER_JOB_ID, PeerError, validPeerSession, type PeerSubmission, type PeerCompletion, type PeerJob, type PeerService, type Runtime } from "@assistant/runtime";
import { HttpError } from "./errors.js";
import { DesktopTranscript, desktopPeerSessions, saveDesktopConversation, savePeerSessionCatalog } from "./desktop-conversations.js";
import type { ConversationId } from "@earendil-works/pi-durable";

type Device = { deviceId: string; lastSeenAt: string };
const Devices = defineDoc<{ items: Device[] }>({ kind: "app.peer-devices", version: 1, scope: "session", initial: () => ({ items: [] }) });
const onlineMs = 60_000;
export async function peerDevices(runtime: Runtime, ctx: Context): Promise<(Device & { online: boolean })[]> {
  return ((await runtime.harness.snapshot(Devices, ctx))?.items ?? []).map(item => ({ ...item, online: Date.now() - Date.parse(item.lastSeenAt) < onlineMs }));
}
function deviceId(value: unknown): string {
  if (typeof value !== "string" || !PEER_DEVICE_ID.test(value)) throw new HttpError(400, "deviceId 必须为 desktop-UUID");
  return value;
}
function participant(job: PeerJob | undefined, device: string): PeerJob {
  if (!job || (job.source !== device && job.target !== device)) throw new HttpError(404, "委派任务不存在");
  return job;
}
export function schedulePeer(peers: PeerService, id: string, report: (error: unknown) => void): void {
  void peers.run(id).catch(report);
}

/** Shared API authentication is required; deviceId is a routing filter, not device identity proof. */
export async function peerApi(context: Runtime & { ctx: Context; peers: PeerService; config: { password: string; peerToken?: string }; exitIfFatal(error: unknown): void; redact(value: unknown): string }, method: string, url: URL, body: Record<string, unknown> = {}, paired = false) {
  if (!url.pathname.startsWith("/api/peers/")) return undefined;
  // The global self-use/anonymous mode cannot authorize remote delegation.
  if (!context.config.password && !(context.config.peerToken && paired)) throw new HttpError(401, "双端委派需要服务器认证或设备配对");
  const { peers, ctx } = context;
  try {
    if (method === "POST" && url.pathname === "/api/peers/conversations") return { status: 200, data: await saveDesktopConversation(context, body) };
    if (method === "POST" && url.pathname === "/api/peers/sessions") return { status: 200, data: await savePeerSessionCatalog(context, body) };
    if (method === "GET" && url.pathname === "/api/peers/sessions") {
      const node = url.searchParams.get("nodeId") ?? "server";
      const sessionId = url.searchParams.get("sessionId"), agent = url.searchParams.get("agent");
      const session = sessionId === null && agent === null ? undefined : { agent, sessionId };
      if (session && !validPeerSession(session)) throw new HttpError(400, "Agent 会话地址无效");
      const value = node === "server" ? session ? await peers.readSession(session) : await peers.sessions() : await desktopPeerSessions(context, deviceId(node), session);
      return { status: 200, data: session ? { item: value } : { items: value } };
    }
    if (method === "POST" && url.pathname === "/api/peers/messages") {
      if (!validPeerSession(body.sourceSession) || !validPeerSession(body.targetSession)) throw new HttpError(400, "必须指定来源与目标 Agent 会话");
      if (body.target === "server" && body.targetSession.agent === "pi" && (await context.harness.snapshot(DesktopTranscript, Number(body.targetSession.sessionId.slice(3)) as ConversationId, ctx))?.value) throw new HttpError(409, "本机历史只能在原本机 Agent 继续执行");
      const item = await peers.submit(body as PeerSubmission);
      if (item.target === "server") schedulePeer(peers, item.id, error => { context.exitIfFatal(error); });
      return { status: 202, data: { item } };
    }
    if (method === "GET" && url.pathname === "/api/peers/devices") return { status: 200, data: { items: await peerDevices(context, ctx) } };
    if (url.pathname === "/api/peers/tasks") {
      if (method === "GET") {
        const device = deviceId(url.searchParams.get("deviceId"));
        await context.root.commit(async tx => {
          const doc = await tx.doc(Devices), existing = doc.items.find(item => item.deviceId === device);
          const now = new Date().toISOString();
          if (existing) existing.lastSeenAt = now;
          else {
            if (doc.items.length >= 100) throw new HttpError(409, "登记设备数量已达上限");
            doc.items.push({ deviceId: device, lastSeenAt: now });
          }
        }, ctx);
        return { status: 200, data: { items: (await peers.list()).filter(job => job.source === device || job.target === device) } };
      }
      if (method === "POST") {
        const source = deviceId(body.source);
        if (body.target !== "server" || typeof body.id !== "string" || typeof body.task !== "string") throw new HttpError(400, "仅接受 desktop-UUID 委派至 server 的任务");
        const item = await peers.submit({ id: body.id, source, target: "server", task: body.task, ...(body.workspace !== undefined ? { workspace: body.workspace as string } : {}), ...(body.constraints !== undefined ? { constraints: body.constraints as string } : {}), ...(body.acceptanceCriteria !== undefined ? { acceptanceCriteria: body.acceptanceCriteria as string } : {}), ...(body.sourceSession ? { sourceSession: body.sourceSession as PeerSubmission["sourceSession"] } : {}), ...(body.targetSession ? { targetSession: body.targetSession as PeerSubmission["targetSession"] } : {}) });
        // Admission commits before scheduling; a retry or restart finds the same job.
        schedulePeer(peers, item.id, error => {
          context.exitIfFatal(error);
          console.error("双端任务等待恢复：", context.redact(error instanceof Error ? error.message : error));
        });
        return { status: 202, data: { item } };
      }
    }
    const match = url.pathname.match(/^\/api\/peers\/tasks\/([^/]+)(\/(?:complete|cancel))?$/);
    if (match) {
      if (!PEER_JOB_ID.test(match[1])) throw new HttpError(400, "任务 ID 必须为 UUID");
      if (method === "GET" && !match[2]) return { status: 200, data: { item: participant(await peers.get(match[1]), deviceId(url.searchParams.get("deviceId"))) } };
      if (method === "POST" && match[2] === "/cancel") {
        const job = participant(await peers.get(match[1]), deviceId(body.deviceId));
        return { status: 200, data: { item: await peers.requestCancel(job.id) } };
      }
      if (method === "POST" && match[2] === "/complete") {
        const device = deviceId(body.deviceId), job = participant(await peers.get(match[1]), device);
        if (job.target !== device) throw new HttpError(403, "只能提交发给当前设备的任务结果");
        const completion = { status: body.status, result: body.result, ...(body.cancellationConfirmed !== undefined ? { cancellationConfirmed: body.cancellationConfirmed } : {}) } as PeerCompletion;
        return { status: 200, data: { item: await peers.complete(job.id, completion) } };
      }
    }
    throw new HttpError(404, "接口不存在");
  } catch (error) {
    if (error instanceof PeerError) throw new HttpError(error.status, error.message);
    throw error;
  }
}
