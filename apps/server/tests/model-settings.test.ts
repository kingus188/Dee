import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openModelSettings } from "../dist/model-settings.js";

const initial = { api: "openai-completions", baseUrl: "https://provider.example/v1", model: "model-a", apiKey: "test-only-key", contextWindow: 128000, maxTokens: 8192 };
const input = { provider: initial.api, baseUrl: initial.baseUrl, model: "model-b" };

test("模型配置持久保存、留空保留 Key、重启生效且对外不回显秘密", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-settings-"));
  const opened: Awaited<ReturnType<typeof openModelSettings>>[] = [];
  try {
    const settings = await openModelSettings(directory, initial); opened.push(settings);
    assert.equal(settings.get().restartRequired, false);
    const result = await settings.save(input);
    assert.equal(result.restartRequired, true);
    assert.equal(result.activeModel, "model-a");
    assert.equal(settings.model.model, "model-a");
    assert.equal(Object.hasOwn(result, "apiKey"), false);
    assert.equal(JSON.stringify(result).includes(initial.apiKey), false);
    assert.equal((await stat(join(directory, "agent.sqlite"))).mode & 0o777, 0o600);
    const restarted = await openModelSettings(directory, { ...initial, baseUrl: "", model: "", apiKey: "" }); opened.push(restarted);
    assert.equal(restarted.model.model, "model-b");
    assert.equal(restarted.model.apiKey, initial.apiKey);
    assert.equal(restarted.get().restartRequired, false);
    await settings.save({ ...input, apiKey: "replacement-test-key" });
    assert.equal(settings.redact(initial.apiKey + " replacement-test-key"), "*** ***");
    for (const connection of opened) connection.close();
    assert.deepEqual(await readdir(directory), ["agent.sqlite"]);
  } finally { for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("模型配置拒绝非法输入，更换目标必须重新提供 Key，损坏文件不静默回退", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-validation-"));
  const opened: Awaited<ReturnType<typeof openModelSettings>>[] = [];
  try {
    const settings = await openModelSettings(directory, initial); opened.push(settings);
    for (const change of [
      { provider: "faux" }, { baseUrl: "file:///private" }, { baseUrl: "https://user:password@provider.example" },
      { baseUrl: "https://provider.example?key=secret" }, { baseUrl: "https://provider.example/#secret" },
      { baseUrl: "https://another.example" }, { provider: "anthropic-messages" }, { model: "" }, { model: [] }, { apiKey: 123 }, { apiKey: "a\nb" },
    ]) await assert.rejects(settings.save({ ...input, ...change }), { status: 400 });
    assert.deepEqual(settings.get(), { provider: initial.api, baseUrl: initial.baseUrl, model: initial.model, hasKey: true, restartRequired: false, activeModel: initial.model });
    await settings.save({ ...input, provider: "anthropic-messages", apiKey: "new-provider-test-key" });
    const restarted = await openModelSettings(directory, initial); opened.push(restarted);
    assert.equal(restarted.model.api, "anthropic-messages");
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    try { database.prepare("UPDATE app_model_settings SET config = ? WHERE id = 1").run("bad-json-test-key"); }
    finally { database.close(); }
    await assert.rejects(openModelSettings(directory, initial), /SQLite 中的模型配置无效/);
  } finally { for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("环境配置中的 URL 凭据不会回显到设置页面", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-url-"));
  let settings;
  try {
    settings = await openModelSettings(directory, { ...initial, apiKey: "", baseUrl: "https://user:test-password@provider.example/v1?key=test-token#test-fragment" });
    assert.equal(settings.get().baseUrl, "https://provider.example/v1");
  } finally { settings?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("有效环境配置自动入库，旧 JSON 迁移后删除，其他 SQLite 数据保留", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-migration-"));
  const opened: Awaited<ReturnType<typeof openModelSettings>>[] = [];
  try {
    const environment = await openModelSettings(directory, initial); opened.push(environment);
    environment.close();
    const persisted = await openModelSettings(directory, { ...initial, baseUrl: "", model: "", apiKey: "" }); opened.push(persisted);
    assert.equal(persisted.model.apiKey, initial.apiKey);
    persisted.close();
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    try {
      database.exec("DELETE FROM app_model_settings; CREATE TABLE existing_notes (text TEXT); INSERT INTO existing_notes VALUES ('keep this note')");
    } finally { database.close(); }
    await writeFile(join(directory, "model-settings.json"), JSON.stringify({ ...input, apiKey: "legacy-test-key" }));
    const migrated = await openModelSettings(directory, initial); opened.push(migrated);
    assert.equal(migrated.model.apiKey, "legacy-test-key");
    assert.equal(migrated.model.model, "model-b");
    assert.equal((await readdir(directory)).includes("model-settings.json"), false);
    const check = new DatabaseSync(join(directory, "agent.sqlite"));
    try {
      assert.equal(check.prepare("SELECT text FROM existing_notes").get()?.text, "keep this note");
      check.exec("CREATE TRIGGER fail_save BEFORE UPDATE ON app_model_settings BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
      await assert.rejects(migrated.save({ ...input, model: "model-c" }), /test write failure/);
      assert.equal(migrated.get().model, "model-b");
      assert.equal(JSON.parse(String(check.prepare("SELECT config FROM app_model_settings WHERE id = 1").get()?.config)).model, "model-b");
    } finally { check.close(); }
  } finally { for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("无效旧 JSON 不会被删除，也不会创建配置记录", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-bad-migration-"));
  try {
    await writeFile(join(directory, "model-settings.json"), "bad legacy settings");
    await assert.rejects(openModelSettings(directory, initial), /未迁移/);
    assert.equal((await readdir(directory)).includes("model-settings.json"), true);
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_model_settings").get()?.count, 0); }
    finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
