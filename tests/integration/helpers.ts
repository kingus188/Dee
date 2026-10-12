import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import assert from "node:assert/strict";
export async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}
export async function post(origin: string, path: string, data: unknown = {}) {
  const response: Response = await fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  const raw = await response.text();
  if (!raw) throw new Error("接口返回空响应：" + path + " HTTP " + response.status);
  const body = JSON.parse(raw);
  assert.equal(response.status < 400, true, JSON.stringify(body));
  return body;
}
export async function launch(dataDir: string, port: number, overrides: NodeJS.ProcessEnv = {}) {
  let logs = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../apps/server/dist/main.js", import.meta.url))], {
    cwd: process.cwd(),
    env: { ...process.env, LLM_API: "faux", LLM_API_KEY: "", WECHAT_ENABLED: "0", OBSIDIAN_ROOT: "", DATA_DIR: dataDir, PORT: String(port), NODE_ENV: "test", DEMO_PASSWORD: "", NOTIFY_MODE: "off", ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const origin = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("服务启动失败：" + logs);
    try { const r = await fetch(origin + "/api/info"); if (r.ok || r.status === 401) return { child, origin, getLogs: () => logs }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("服务启动超时：" + logs);
}
export async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref();
  });
}
