import type { ApiRequest, ConversationView, ServerMessage } from "@assistant/contracts";

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export type ConnectionState = "connecting" | "connected" | "disconnected";

// Adapted from Gina's transport/client.ts: stale-socket guards, request correlation,
// pending-request rejection and exponential reconnect. Durable views replace replay.
export class ApiClient {
  private socket: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(view: ConversationView) => void>();
  private connectionListeners = new Set<(state: ConnectionState) => void>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private nextId = 0;
  private closed = false;
  private conversationId: number | null = null;
  private connecting: Promise<void> | undefined;
  private rejectConnection: ((error: Error) => void) | undefined;
  private state: ConnectionState = "connecting";

  constructor(private readonly url: () => string = () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/socket`) {}
  onView(listener: (view: ConversationView) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onConnection(listener: (state: ConnectionState) => void) {
    this.connectionListeners.add(listener); listener(this.state);
    return () => { this.connectionListeners.delete(listener); };
  }
  private notify(state: ConnectionState) { this.state = state; for (const listener of this.connectionListeners) listener(state); }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("连接已关闭"));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    this.notify("connecting");
    this.connecting = new Promise<void>((resolve, reject) => {
      this.rejectConnection = reject;
      const socket = new WebSocket(this.url());
      this.socket = socket;
      this.connectTimer = setTimeout(() => {
        if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
          reject(new Error("连接超时，请重试")); socket.close();
        }
      }, 15_000);
      socket.onopen = () => {
        if (this.socket !== socket) return;
        clearTimeout(this.connectTimer);
        this.connecting = undefined; this.rejectConnection = undefined;
        this.stableTimer = setTimeout(() => { this.attempt = 0; }, 10_000);
        resolve(); this.notify("connected");
        if (this.conversationId !== null) void this.subscribeConversation(this.conversationId).catch(error => console.warn("恢复会话失败：", error));
      };
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data));
          if (!message || (message.type !== "response" && message.type !== "event") ||
            (message.type === "event" && (message.event !== "view" || !Number.isInteger(message.data?.conversationId))) ||
            (message.type === "response" && (typeof message.id !== "string" || !Number.isInteger(message.status)))) throw new Error("响应格式不合法");
        }
        catch { socket.close(1008, "响应格式不合法"); return; }
        if (message.type === "event" && message.event === "view") {
          if (message.data.conversationId === this.conversationId) for (const listener of this.listeners) listener(message.data);
        } else if (message.type === "response") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.status >= 400) pending.reject(new Error(message.error || "请求失败"));
          else pending.resolve(message.data);
        }
      };
      socket.onerror = () => { if (this.socket === socket) this.notify("disconnected"); };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        clearTimeout(this.connectTimer); clearTimeout(this.stableTimer);
        this.connecting = undefined; this.rejectConnection = undefined;
        reject(new Error("连接中断，请重试"));
        this.failPending(new Error("连接中断，操作结果尚未确认，请核对后重试"));
        this.notify("disconnected");
        if (!this.closed) this.retryTimer = setTimeout(() => {
          this.retryTimer = undefined;
          void this.connect().catch(error => console.warn("重新连接失败：", error));
        }, Math.min(1000 * 2 ** this.attempt++, 30_000));
      };
    });
    return this.connecting;
  }
  async request<T = unknown>(path: string, body?: unknown): Promise<T> {
    await this.connect();
    const id = String(++this.nextId);
    const request: ApiRequest = { type: "request", id, method: body === undefined ? "GET" : "POST", path, ...(body === undefined ? {} : { body: body as Record<string, unknown> }) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("请求超时，操作结果尚未确认，请核对后重试")); }, 30_000);
      this.pending.set(id, { resolve: data => resolve(data as T), reject, timer });
      try { this.socket!.send(JSON.stringify(request)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async subscribeConversation(id: number) {
    await this.connect();
    this.conversationId = id;
    return this.request(`/api/conversations/${id}/events`);
  }
  private failPending(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer); clearTimeout(this.connectTimer); clearTimeout(this.stableTimer);
    this.rejectConnection?.(new Error("连接已关闭")); this.connecting = undefined;
    this.failPending(new Error("连接已关闭"));
    this.socket?.close(); this.socket = null;
    this.notify("disconnected");
  }
  resume() { this.closed = false; return this.connect(); }
}

export const apiClient = new ApiClient();
