import type { ConversationItem } from "@assistant/contracts";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function post(origin: string, path: string, data: unknown = {}) {
  const response = await fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  });
  const raw = await response.text();
  if (!raw) throw new Error("接口返回空响应：" + path + " HTTP " + response.status);
  const body = JSON.parse(raw);
  assert.equal(response.status < 400, true, JSON.stringify(body));
  return body;
}

async function launch(dataDir: string, port: number) {
  let logs = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../apps/server/dist/main.js", import.meta.url))], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LLM_API: "faux",
      DATA_DIR: dataDir,
      PORT: String(port),
      NODE_ENV: "test",
      DEMO_PASSWORD: "",
      NOTIFY_MODE: "off",
      OBSIDIAN_ROOT: "",
      OBSIDIAN_ALLOW: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const origin = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error("服务启动失败：" + logs);
    try {
      const ready = await fetch(origin + "/api/info");
      if (ready.ok || ready.status === 401) return { child, origin, getLogs: () => logs };
    } catch { /* 还在启动 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("服务启动超时：" + logs);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref();
  });
}

test("会话可以归档、恢复，并从列表移除", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shelf-"));
  let app;
  try {
    app = await launch(dir, await freePort());
    const first = await post(app.origin, "/api/conversations");
    const second = await post(app.origin, "/api/conversations");
    const prefix = "/api/conversations/" + first.id;
    const created = await post(app.origin, prefix + "/schedules", {
      text: "归档前的计划", minutesFromNow: 10, everyMinutes: 0, requestId: "shelf-schedule",
    });
    assert.equal(created.item.status, "active");

    const archived = await post(app.origin, prefix + "/archive", {});
    assert.equal(typeof archived.archivedAt, "string");
    const again = await post(app.origin, prefix + "/archive", {});
    assert.equal(again.archivedAt, archived.archivedAt);

    const afterArchive: ConversationItem[] = await (await fetch(app.origin + "/api/conversations")).json();
    const archivedItem = afterArchive.find((item) => item.id === first.id);
    assert.equal(archivedItem!.archivedAt, archived.archivedAt);
    assert.equal(afterArchive.find((item) => item.id === second.id)!.archivedAt ?? null, null);

    const management = await (await fetch(app.origin + prefix + "/management")).json();
    assert.equal(management.schedules.length, 1);
    assert.equal(management.schedules[0].status, "cancelled");

    const restored = await post(app.origin, prefix + "/restore", {});
    assert.equal(restored.archivedAt, null);
    const afterRestore: ConversationItem[] = await (await fetch(app.origin + "/api/conversations")).json();
    assert.equal(afterRestore.find((item) => item.id === first.id)!.archivedAt, null);

    await post(app.origin, "/api/conversations/" + second.id + "/remove", {});
    const afterRemove: ConversationItem[] = await (await fetch(app.origin + "/api/conversations")).json();
    assert.equal(afterRemove.some((item) => item.id === second.id), false);
    assert.equal(afterRemove.some((item) => item.id === first.id), true);
    // 删除只拿掉列表项，会话本身还在。
    const stillThere = await fetch(app.origin + "/api/conversations/" + second.id + "/management");
    assert.equal(stillThere.status, 200);

    const missing = await fetch(app.origin + "/api/conversations/999999/archive", { method: "POST" });
    const missingBody = await missing.json();
    assert.equal(missing.status, 400);
    assert.match(missingBody.error, /不在列表/);

    const removedAgain = await fetch(app.origin + "/api/conversations/" + second.id + "/remove", { method: "POST" });
    assert.equal(removedAgain.status, 400);
  } finally {
    if (app) await stop(app.child);
    await rm(dir, { recursive: true, force: true });
  }
});
