import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig, startServer } from "../dist/index.js";

test("embedded hosts can serve web assets independently of the server package location", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-root-test-"));
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await writeFile(join(directory, "index.html"), "<h1>Desktop assets</h1>");
    const config = readConfig({ LLM_API: "faux", DATA_DIR: join(directory, "data"), PORT: "0", NOTIFY_MODE: "off" });
    service = await startServer(config, "127.0.0.1", pathToFileURL(directory + "/"));
    const response = await fetch(service.origin);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<h1>Desktop assets</h1>");
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("embedded server authenticates, serves web assets, closes and reopens persisted data", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-test-"));
  const config = readConfig({ LLM_API: "faux", DATA_DIR: dataDir, PORT: "0", NODE_ENV: "production", DEMO_PASSWORD: "test-only-password", NOTIFY_MODE: "off" });
  const headers = { authorization: "Basic " + Buffer.from("demo:test-only-password").toString("base64") };
  let running: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    running = await startServer(config, "127.0.0.1");
    assert.match(running.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(running.origin + "/api/info")).status, 401);
    const info = await (await fetch(running.origin + "/api/info", { headers })).json() as { boots: number };
    const page = await fetch(running.origin, { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /\/app\.js/);
    assert.equal((await fetch(running.origin + "/api/crash", { method: "POST", headers })).status, 403);
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
    const config = readConfig({ LLM_API: "faux", DATA_DIR: firstDir, PORT: "0", NOTIFY_MODE: "off" });
    first = await startServer(config);
    await assert.rejects(startServer({ ...config, dataDir: secondDir, port: Number(new URL(first.origin).port) }), { code: "EADDRINUSE" });
    second = await startServer({ ...config, dataDir: secondDir });
    assert.equal((await fetch(second.origin + "/api/info")).status, 200);
  } finally {
    await Promise.all([first?.close(), second?.close()]);
    await Promise.all([rm(firstDir, { recursive: true, force: true }), rm(secondDir, { recursive: true, force: true })]);
  }
});
