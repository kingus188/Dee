import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, startServer } from "../dist/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerInfo } from "@assistant/contracts";

test("普通和生产启动拒绝模拟模型，自动化测试仍可使用", () => {
  for (const NODE_ENV of [undefined, "development", "production"]) {
    assert.throws(() => readConfig({ NODE_ENV, LLM_API: "faux", ENABLE_CRASH_DEMO: "1" }), /模拟体验已停用/);
  }
  assert.equal(readConfig({ NODE_ENV: "test", LLM_API: "faux" }).model.api, "faux");
});

test("缺少模型配置时提供设置入口，聊天不会回退到模拟剧本", async () => {
  assert.equal(readConfig({}).model.api, "openai-completions");
  const directory = await mkdtemp(join(tmpdir(), "pi-setup-"));
  const service = await startServer(readConfig({ DATA_DIR: directory, PORT: "0" }));
  try {
    const info = await (await fetch(service.origin + "/api/info")).json() as ServerInfo;
    assert.equal(info.configured, false);
    assert.equal(info.model, "未配置模型");
    assert.equal((await fetch(service.origin)).status, 200);
    assert.equal((await fetch(service.origin + "/api/settings/model")).status, 200);
    assert.equal((await fetch(service.origin + "/api/conversations/direct", { method: "POST" })).status, 409);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
