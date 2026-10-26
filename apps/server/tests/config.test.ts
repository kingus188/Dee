import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, startServer } from "../dist/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSettings, ServerInfo } from "@assistant/contracts";
import { DatabaseSync } from "node:sqlite";

test("模型目录路径由服务器环境配置，单模型环境仍保留", () => {
  const config = readConfig({ LLM_MODELS_FILE: "/server/models.json", LLM_API: "openai-responses", LLM_MODEL: "test-model", LLM_CONTEXT_WINDOW: "200000", LLM_MAX_TOKENS: "4096" });
  assert.equal(config.modelCatalogFile, "/server/models.json");
  assert.equal(config.model.api, "openai-responses");
  assert.equal(config.model.model, "test-model");
  assert.equal(config.model.contextWindow, 200000);
  assert.equal(config.model.maxTokens, 4096);
  assert.equal(readConfig({}).modelCatalogFile, "");
});

test("HTTP 只返回公开目录并仅保存合法选择，旧凭据与额外键均未写入，重启应用选择", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-http-"));
  const catalogFile = join(directory, "models.json");
  const models = [
    { id: "one", name: "第一模型", provider: "openai-completions", baseUrl: "https://first.example/v1", model: "upstream-one", apiKey: "http-first-test-key" },
    { id: "two", name: "第二模型", provider: "openai-responses", baseUrl: "https://second.example/v1", model: "upstream-two", apiKey: "http-second-test-key" },
  ];
  await writeFile(catalogFile, JSON.stringify(models));
  const config = readConfig({ NODE_ENV: "test", PI_OFFLINE: "1", DATA_DIR: directory, PORT: "0", NOTIFY_MODE: "off", LLM_MODELS_FILE: catalogFile });
  let service: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    service = await startServer(config);
    const origin = service.origin;
    const before = await (await fetch(origin + "/api/settings/model")).json() as ModelSettings;
    assert.deepEqual(before, { models: models.map(({ id, name }) => ({ id, name })), selectedModel: "one", activeModel: "one", restartRequired: false });
    for (const input of [
      { provider: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", model: "injected", apiKey: "http-injected-test-key" },
      { modelId: "two", provider: "openai-responses" }, { modelId: "two", baseUrl: "http://127.0.0.1:1/v1" },
      { modelId: "two", model: "injected" }, { modelId: "two", apiKey: "http-injected-test-key" },
      { modelId: "missing" }, { modelId: "" }, { modelId: 1 }, { modelId: "two", extra: true }, {},
    ]) {
      const response = await fetch(origin + "/api/settings/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(response.status, 400);
      assert.equal((await response.text()).includes("http-injected-test-key"), false);
    }
    assert.deepEqual(await (await fetch(origin + "/api/settings/model")).json(), before);
    const crossOrigin = await fetch(origin + "/api/settings/model", { method: "POST", headers: { "content-type": "application/json", origin: "https://other.example" }, body: JSON.stringify({ modelId: "two" }) });
    assert.equal(crossOrigin.status, 403);
    const response = await fetch(origin + "/api/settings/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modelId: "two" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...before, selectedModel: "two", restartRequired: true });
    const info = await (await fetch(origin + "/api/info")).json() as ServerInfo;
    assert.equal(info.model, "upstream-one");
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_model_settings").get()?.count, 0);
      assert.equal(database.prepare("SELECT model_id FROM app_model_selection").get()?.model_id, "two");
    } finally { database.close(); }
    await service.close();
    service = await startServer(config);
    assert.deepEqual(await (await fetch(service.origin + "/api/settings/model")).json(), { ...before, selectedModel: "two", activeModel: "two" });
    assert.equal(service.modelLabel, "upstream-two");
  } finally { await service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("普通和生产启动拒绝模拟模型，自动化测试仍可使用", () => {
  for (const NODE_ENV of [undefined, "development", "production"]) {
    assert.throws(() => readConfig({ NODE_ENV, LLM_API: "faux", ENABLE_CRASH_DEMO: "1" }), /模拟体验已停用/);
  }
  assert.equal(readConfig({ NODE_ENV: "test", LLM_API: "faux" }).model.api, "faux");
});

test("缺少模型配置时聊天提示服务器配置和重启后端，不回退模拟剧本", async () => {
  assert.equal(readConfig({}).model.api, "openai-completions");
  const directory = await mkdtemp(join(tmpdir(), "pi-setup-"));
  const service = await startServer(readConfig({ NODE_ENV: "test", PI_OFFLINE: "1", DATA_DIR: directory, PORT: "0", NOTIFY_MODE: "off" }));
  try {
    const info = await (await fetch(service.origin + "/api/info")).json() as ServerInfo;
    assert.equal(info.configured, false);
    assert.equal(info.model, "未配置模型");
    const page = await fetch(service.origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") || "", /text\/html/);
    assert.match(await page.text(), /app\.js/);
    assert.equal((await fetch(service.origin + "/app.js")).status, 200);
    assert.equal((await fetch(service.origin + "/api/settings/model")).status, 200);
    const direct = await fetch(service.origin + "/api/conversations/direct", { method: "POST" });
    assert.equal(direct.status, 200);
    const conversation = await direct.json() as { id: number };
    const blocked = await fetch(`${service.origin}/api/conversations/${conversation.id}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "不应生成模拟回复" }) });
    assert.equal(blocked.status, 409);
    assert.deepEqual(await blocked.json(), { error: "请在服务器配置模型，然后重启后端" });
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
