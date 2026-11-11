import type { Context } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import { PEER_DEVICE_ID, PEER_JOB_ID, PeerError, type PeerCompletion, type PeerJob, type PeerService, type Runtime } from "@assistant/runtime";
import { HttpError } from "./errors.js";

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
export async function peerApi(context: Runtime & { ctx: Context; peers: PeerService; config: { password: string }; exitIfFatal(error: unknown): void; redact(value: unknown): string }, method: string, url: URL, body: Record<string, unknown> = {}) {
  if (!url.pathname.startsWith("/api/peers/")) return undefined;
  // The global self-use/anonymous mode cannot authorize remote delegation.
  if (!context.config.password) throw new HttpError(401, "双端委派需要先配置服务器认证口令");
  const { peers, ctx } = context;
  try {
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
        const item = await peers.submit({ id: body.id, source, target: "server", task: body.task });
        // Admission commits before scheduling; a retry or restart finds the same job.
        schedulePeer(peers, item.id, error => {
          context.exitIfFatal(error);
          console.error("双端任务等待恢复：", context.redact(error instanceof Error ? error.message : error));
        });
        return { status: 202, data: { item } };
      }
    }
    const match = url.pathname.match(/^\/api\/peers\/tasks\/([^/]+)(\/complete)?$/);
    if (match) {
      if (!PEER_JOB_ID.test(match[1])) throw new HttpError(400, "任务 ID 必须为 UUID");
      if (method === "GET" && !match[2]) return { status: 200, data: { item: participant(await peers.get(match[1]), deviceId(url.searchParams.get("deviceId"))) } };
      if (method === "POST" && match[2]) {
        const device = deviceId(body.deviceId), job = participant(await peers.get(match[1]), device);
        if (job.target !== device) throw new HttpError(403, "只能提交发给当前设备的任务结果");
        const completion = { status: body.status, result: body.result } as PeerCompletion;
        return { status: 200, data: { item: await peers.complete(job.id, completion) } };
      }
    }
    throw new HttpError(404, "接口不存在");
  } catch (error) {
    if (error instanceof PeerError) throw new HttpError(error.status, error.message);
    throw error;
  }
}
