import { spawnAgent, stopAgent } from "./process.js";
import { object } from "./types.js";

export function openCodexRpc(options: {
  executable: string; cwd: string; searchPath?: string; env?: NodeJS.ProcessEnv;
  notify(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  failed(error: Error): void;
}) {
  const child = spawnAgent(options.executable, ["app-server", "--listen", "stdio://"], options.cwd, options.searchPath, options.env);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0, buffer = "", closed = false;
  function fail(error: Error) {
    if (closed) return;
    closed = true;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear(); options.failed(error); void stopAgent(child).catch(options.failed);
  }
  function write(value: unknown) {
    if (closed) throw new Error("Codex 连接已关闭");
    child.stdin.write(JSON.stringify(value) + "\n");
  }
  async function message(raw: string) {
    const value = object(JSON.parse(raw)), params = object(value.params);
    if (typeof value.method === "string") {
      if (value.id !== undefined) {
        try { const result = await options.request(value.method, params); if (!closed) write({ id: value.id, result }); }
        catch { if (!closed) write({ id: value.id, error: { code: -32601, message: "Unsupported or cancelled request" } }); }
      } else options.notify(value.method, params);
    } else if (typeof value.id === "number") {
      const call = pending.get(value.id); if (!call) return;
      clearTimeout(call.timer); pending.delete(value.id);
      if (value.error) call.reject(new Error("Codex 请求失败，请检查原生会话、登录和权限配置")); else call.resolve(value.result);
    }
  }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { fail(new Error("Codex 协议消息过大")); return; }
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) void message(line).catch(() => fail(new Error("Codex 协议消息无效")));
    }
  });
  child.on("error", () => fail(new Error("无法启动 Codex")));
  child.stdin.on("error", () => fail(new Error("Codex 输入连接中断")));
  child.once("close", () => fail(new Error("Codex 进程已退出；请核对未完成任务")));
  return {
    request(method: string, params: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => fail(new Error("Codex 协议请求超时")), 20000); timer.unref();
        pending.set(id, { resolve, reject, timer });
        try { write({ id, method, params }); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    notify: (method: string, params?: unknown) => write({ method, params }),
    async close() {
      if (!closed) { closed = true; for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Codex 连接已关闭")); } pending.clear(); }
      // EOF lets app-server release its workers before process-tree cleanup.
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); child.removeListener("exit", done); resolve(); };
        const timer = setTimeout(done, 1000);
        child.once("exit", done);
        child.stdin.end();
      });
      await stopAgent(child);
    },
  };
}
