import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, startServer } from "../../apps/server/dist/index.js";
import { post, readView } from "./helpers.js";

test("设置接口鉴权和同源保护，重启后原会话使用新地址、Key 和模型", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-http-"));
  const calls: { path: string; key: string | undefined; model: string }[] = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ path: req.url!, key: req.headers.authorization, model: JSON.parse(body).model });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: "local-test", object: "chat.completion.chunk", created: 1, model: "model-b", choices: [{ index: 0, delta: { role: "assistant", content: "已使用新连接" }, finish_reason: null }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const address = provider.address(); assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const config = readConfig({ LLM_API: "openai-completions", LLM_BASE_URL: endpoint + "/old/v1", LLM_API_KEY: "old-test-key", LLM_MODEL: "model-a", DATA_DIR: directory, PORT: "0", NOTIFY_MODE: "off", DEMO_PASSWORD: "test-password" });
  const headers = { authorization: "Basic " + Buffer.from("demo:test-password").toString("base64"), "content-type": "application/json" };
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    service = await startServer(config, "127.0.0.1");
    const path = "/api/settings/model";
    assert.equal((await fetch(service.origin + path)).status, 401);
    assert.equal((await fetch(service.origin + path, { method: "POST", body: "{}" })).status, 401);
    const get = () => fetch(service!.origin + path, { headers });
    const before = await get();
    assert.equal(before.headers.get("cache-control"), "no-store");
    assert.equal((await before.json()).hasKey, true);
    const id = (await (await fetch(service.origin + "/api/conversations/direct", { method: "POST", headers })).json()).id;
    await fetch(service.origin + `/api/conversations/${id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "旧连接的对话" }) });
    let completed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const exported = await fetch(service.origin + `/api/conversations/${id}/export.md`, { headers });
      if ((await exported.text()).includes("已使用新连接")) { completed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(completed, true, "旧连接应在切换前完成回复");
    const body = JSON.stringify({ provider: "openai-completions", baseUrl: endpoint + "/new/v1", model: "model-b", apiKey: "new-test-key" });
    assert.equal((await fetch(service.origin + path, { method: "POST", headers: { ...headers, origin: "https://another.example" }, body })).status, 403);
    assert.equal((await fetch(service.origin + path, { method: "POST", headers, body: JSON.stringify({ provider: "faux" }) })).status, 400);
    const result = await fetch(service.origin + path, { method: "POST", headers, body });
    assert.equal(result.status, 200);
    const saved = await result.text();
    assert.equal(saved.includes("test-key"), false);
    assert.equal(JSON.parse(saved).restartRequired, true);
    const unchanged = await (await fetch(service.origin + "/api/info", { headers })).json();
    assert.equal(unchanged.model, "model-a");
    await service.close();
    service = await startServer({ ...config, password: "", model: { ...config.model, baseUrl: "", model: "", apiKey: "" } }, "127.0.0.1");
    assert.equal((await (await get()).json()).restartRequired, false);
    assert.equal((await post(service.origin, "/api/conversations/direct")).id, id);
    const oldView = await readView(service.origin, id, view => !view.busy);
    const oldEntry = oldView.entries.find(entry => entry.kind === "assistant")?.id;
    assert.ok(oldEntry);
    await post(service.origin, `/api/conversations/${id}/messages`, { text: "检查连接" });
    await readView(service.origin, id, view => view.entries.filter(entry => entry.kind === "assistant").length === 2 && !view.busy);
    const fork = await post(service.origin, `/api/conversations/${id}/fork`, { entryId: oldEntry });
    await post(service.origin, `/api/conversations/${fork.id}/messages`, { text: "从旧记录继续" });
    await readView(service.origin, fork.id, view => view.entries.filter(entry => entry.kind === "assistant").length === 2 && !view.busy);
    assert.deepEqual(calls, [
      { path: "/old/v1/chat/completions", key: "Bearer old-test-key", model: "model-a" },
      { path: "/new/v1/chat/completions", key: "Bearer new-test-key", model: "model-b" },
      { path: "/new/v1/chat/completions", key: "Bearer new-test-key", model: "model-b" },
    ]);
  } finally {
    await service?.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
