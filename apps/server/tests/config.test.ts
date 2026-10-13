import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, startServer } from "../dist/index.js";

test("普通和生产启动拒绝模拟模型，自动化测试仍可使用", () => {
  for (const NODE_ENV of [undefined, "development", "production"]) {
    assert.throws(() => readConfig({ NODE_ENV, LLM_API: "faux", ENABLE_CRASH_DEMO: "1" }), /模拟体验已停用/);
  }
  assert.equal(readConfig({ NODE_ENV: "test", LLM_API: "faux" }).model.api, "faux");
});

test("缺少真实模型配置时启动失败，不回退到模拟剧本", async () => {
  assert.equal(readConfig({}).model.api, "openai-completions");
  await assert.rejects(startServer(readConfig({})), /LLM_BASE_URL.*LLM_MODEL/);
});
