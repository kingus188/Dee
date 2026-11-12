import type { ApiRequest } from "@assistant/contracts";

export class PeerConnectionError extends Error {
  constructor(readonly status: number) { super(status === 401 ? "双端协作需要设备配对" : status === 404 ? "服务器尚未启用双端协作" : "双端协作暂不可用，操作结果尚未确认"); }
}
export type PeerSocket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close" | "addEventListener">;
export type PeerChange = "connected" | "disconnected" | "tasks";
type Target = { key: string; url: string; origin: string; headers: Record<string, string> };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export function openPeerSocket(options: { target(): Target; socket(url: string, headers: Record<string, string>, origin: string): PeerSocket }) {
  let socket: PeerSocket | undefined, key: string | undefined, closed = false, ready = false, attempt = 0, nextId = 0;
  let connecting: Promise<void> | undefined, rejectConnect: ((error: Error) => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined, timeout: ReturnType<typeof setTimeout> | undefined, stable: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, Pending>(), listeners = new Set<(change: PeerChange) => void>();
  const notify = (change: PeerChange) => { for (const listener of listeners) listener(change); };
  function disconnect(error: Error, reconnect = true) {
    const previous = socket; socket = undefined; key = undefined; ready = false;
    clearTimeout(timeout); clearTimeout(stable); clearTimeout(retry);
    rejectConnect?.(error); rejectConnect = undefined; connecting = undefined;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear(); previous?.close(); notify("disconnected");
    if (!closed && reconnect) {
      retry = setTimeout(() => { retry = undefined; void connect().catch(() => { notify("disconnected"); }); }, Math.min(1000 * 2 ** Math.min(attempt++, 5), 30000));
      retry.unref();
    }
  }
  async function connect(): Promise<void> {
    if (closed) throw new PeerConnectionError(503);
    const target = options.target();
    if (key !== undefined && key !== target.key) disconnect(new PeerConnectionError(503), false);
    if (ready && socket?.readyState === 1) return;
    if (connecting) return connecting;
    clearTimeout(retry);
    let resolve!: () => void;
    const opening = new Promise<void>((done, reject) => { resolve = done; rejectConnect = reject; });
    connecting = opening; key = target.key;
    try {
      const current = options.socket(target.url, target.headers, target.origin); socket = current;
      timeout = setTimeout(() => { if (socket === current) disconnect(new PeerConnectionError(504)); }, 15000); timeout.unref();
      current.addEventListener("open", () => {
        if (socket !== current) return;
        try { current.send(JSON.stringify({ type: "peer-auth", authorization: target.headers.authorization })); }
        catch { disconnect(new PeerConnectionError(503)); }
      });
      current.addEventListener("message", event => {
        if (socket !== current) return;
        let message: Record<string, unknown>;
        try {
          const data = (event as Event & { data: unknown }).data;
          if (typeof data !== "string" || Buffer.byteLength(data) > 24 * 1024 * 1024) throw new Error("invalid frame");
          message = JSON.parse(data) as Record<string, unknown>;
          if (!message || typeof message !== "object") throw new Error("invalid frame");
          if (message.type === "peer-authenticated" && !ready) {
            ready = true; clearTimeout(timeout); connecting = undefined; rejectConnect = undefined;
            stable = setTimeout(() => { attempt = 0; }, 10000); stable.unref(); resolve(); notify("connected"); return;
          }
          if (!ready) throw new Error("unauthenticated response");
          if (message.type === "event" && message.event === "peer-tasks" && message.data && typeof message.data === "object" && typeof (message.data as { deviceId?: unknown }).deviceId === "string") { notify("tasks"); return; }
          if (message.type !== "response" || typeof message.id !== "string" || typeof message.status !== "number" || !Number.isInteger(message.status) || message.status < 100 || message.status > 599) throw new Error("invalid response");
        } catch { disconnect(new PeerConnectionError(502)); return; }
        const item = pending.get(message.id as string); if (!item) return;
        clearTimeout(item.timer); pending.delete(message.id as string);
        if ((message.status as number) >= 400) item.reject(new PeerConnectionError(message.status as number)); else item.resolve(message.data);
      });
      current.addEventListener("close", event => { if (socket === current) disconnect(new PeerConnectionError(!ready && (event as Event & { code?: number }).code === 1008 ? 401 : 503)); });
      current.addEventListener("error", () => { if (socket === current) disconnect(new PeerConnectionError(503)); });
    } catch { disconnect(new PeerConnectionError(503)); }
    return opening;
  }
  return {
    onChange(listener: (change: PeerChange) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async request(path: string, body?: unknown): Promise<unknown> {
      const id = String(++nextId);
      const input: ApiRequest = { type: "request", id, method: body === undefined ? "GET" : "POST", path, ...(body === undefined ? {} : { body: body as Record<string, unknown> }) };
      const text = JSON.stringify(input);
      if (Buffer.byteLength(text) > 24 * 1024 * 1024) throw new PeerConnectionError(413);
      await connect();
      if (!ready || !socket || socket.readyState !== 1) throw new PeerConnectionError(503);
      if (pending.size >= 16 || socket.bufferedAmount > 16 * 1024 * 1024) throw new PeerConnectionError(429);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new PeerConnectionError(504)); }, 30000); timer.unref();
        pending.set(id, { resolve, reject, timer });
        try { socket!.send(text); } catch { disconnect(new PeerConnectionError(503)); }
      });
    },
    close() { closed = true; disconnect(new PeerConnectionError(503), false); listeners.clear(); },
  };
}
