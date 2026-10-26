import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, startServer } from "../dist/index.js";

test("API backend serves the built UI while keeping private files inaccessible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-backend-ui-test-"));
  const service = await startServer(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: directory, PORT: "0", NOTIFY_MODE: "off", PI_OFFLINE: "1" }));
  try {
    for (const path of ["/", "/index.html", "/app.js", "/style.css"]) {
      assert.equal((await fetch(service.origin + path)).status, 200, path);
    }
    for (const path of ["/api-client.js", "/settings/ModelSettings.js", "/app.js.map", "/.env"]) {
      assert.equal((await fetch(service.origin + path)).status, 404, path);
    }
    assert.equal((await fetch(service.origin + "/api/info")).status, 200);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("API server authenticates, closes and reopens persisted data", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-test-"));
  const config = readConfig({ LLM_API: "openai-completions", LLM_BASE_URL: "http://127.0.0.1:1/v1", LLM_MODEL: "test-unused", DATA_DIR: dataDir, PORT: "0", NODE_ENV: "production", DEMO_PASSWORD: "test-only-password", NOTIFY_MODE: "off" });
  const headers = { authorization: "Basic " + Buffer.from("demo:test-only-password").toString("base64") };
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    running = await startServer(config, "127.0.0.1");
    assert.match(running.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(running.origin + "/api/info")).status, 401);
    const info = await (await fetch(running.origin + "/api/info", { headers })).json() as { boots: number };
    assert.equal((await fetch(running.origin)).status, 401);
    const page = await fetch(running.origin, { headers });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.equal((await fetch(running.origin + "/api/crash", { method: "POST", headers })).status, 404);
    const origin = running.origin;
    await Promise.all([running.close(), running.close()]);
    await assert.rejects(fetch(origin + "/api/info"));
    running = await startServer(config, "127.0.0.1");
    const reopened = await (await fetch(running.origin + "/api/info", { headers })).json() as { boots: number };
    assert.equal(reopened.boots, info.boots + 1);
  } finally { await running?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("a port conflict releases storage before reporting the startup failure", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "pi-listener-test-"));
  const secondDir = await mkdtemp(join(tmpdir(), "pi-conflict-test-"));
  let first: Awaited<ReturnType<typeof startServer>> | undefined;
  let second: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const config = readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: firstDir, PORT: "0", NOTIFY_MODE: "off" });
    first = await startServer(config);
    await assert.rejects(startServer({ ...config, dataDir: secondDir, port: Number(new URL(first.origin).port) }), { code: "EADDRINUSE" });
    second = await startServer({ ...config, dataDir: secondDir });
    assert.equal((await fetch(second.origin + "/api/info")).status, 200);
  } finally {
    await Promise.all([first?.close(), second?.close()]);
    await Promise.all([rm(firstDir, { recursive: true, force: true }), rm(secondDir, { recursive: true, force: true })]);
  }
});
