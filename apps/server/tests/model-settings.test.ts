import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openModelSettings } from "../dist/model-settings.js";

const initial = { api: "openai-completions", baseUrl: "https://provider.example/v1", model: "upstream-a", apiKey: "test-only-key", contextWindow: 128000, maxTokens: 8192 };
const empty = { ...initial, baseUrl: "", model: "", apiKey: "" };
const catalog = [
  { id: "fast", name: "快速模型", provider: initial.api, baseUrl: initial.baseUrl, model: initial.model, apiKey: initial.apiKey },
  { id: "quality", provider: "anthropic-messages", baseUrl: "https://second.example/v1", model: "upstream-b", apiKey: "second-test-key", contextWindow: 200000, maxTokens: 4096 },
];
const openSettings = openModelSettings as (directory: string, fallback: typeof initial, catalogFile?: string) => ReturnType<typeof openModelSettings>;

test("目录选择独立持久化、重启生效，目录 id 与上游模型分离，响应只含公开字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-catalog-"));
  const opened: Awaited<ReturnType<typeof openModelSettings>>[] = [];
  try {
    const file = join(directory, "models.json");
    await writeFile(file, JSON.stringify(catalog));
    const settings = await openSettings(directory, empty, file); opened.push(settings);
    const models = [{ id: "fast", name: "快速模型" }, { id: "quality", name: "quality" }];
    assert.deepEqual(settings.get(), { models, selectedModel: "fast", activeModel: "fast", restartRequired: false });
    const result = await settings.save({ modelId: "quality" });
    assert.deepEqual(result, { models, selectedModel: "quality", activeModel: "fast", restartRequired: true });
    assert.equal(settings.model.model, initial.model);
    assert.equal(settings.model.apiKey, initial.apiKey);
    assert.equal(settings.redact(initial.apiKey + " second-test-key"), "*** ***");
    assert.equal((await stat(join(directory, "agent.sqlite"))).mode & 0o777, 0o600);
    result.models[0].name = "客户端修改";
    assert.equal(settings.get().models[0].name, "快速模型");
    settings.close();
    const restarted = await openSettings(directory, empty, file); opened.push(restarted);
    assert.equal(restarted.get().activeModel, "quality");
    assert.equal(restarted.get().restartRequired, false);
    assert.equal(restarted.model.model, "upstream-b");
    assert.equal(restarted.model.contextWindow, 200000);
    assert.equal(restarted.model.maxTokens, 4096);
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    try {
      assert.equal(database.prepare("SELECT model_id FROM app_model_selection WHERE id = 1").get()?.model_id, "quality");
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_model_settings").get()?.count, 0);
    } finally { database.close(); }
    await restarted.save({ modelId: "quality" });
    assert.equal(restarted.get().restartRequired, false);
    await restarted.save({ modelId: "fast" });
    assert.equal(restarted.get().restartRequired, true);
    await restarted.save({ modelId: "quality" });
    assert.equal(restarted.get().restartRequired, false);
    assert.equal(await readFile(file, "utf8"), JSON.stringify(catalog));
  } finally { for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("旧凭据请求、额外键及不存在的目录 id 均失败且没有写入；选择写入失败不改变内存", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-selection-"));
  let settings: Awaited<ReturnType<typeof openModelSettings>> | undefined;
  try {
    settings = await openModelSettings(directory, initial);
    const before = settings.get();
    for (const input of [
      { provider: initial.api, baseUrl: initial.baseUrl, model: "changed", apiKey: "injected-test-key" },
      { modelId: "default", provider: initial.api }, { modelId: "default", baseUrl: initial.baseUrl },
      { modelId: "default", model: initial.model }, { modelId: "default", apiKey: "injected-test-key" },
      { modelId: "default", extra: true }, { modelId: "missing" }, { modelId: "" }, { modelId: 1 },
      { modelId: " default " }, { modelId: "default\n" }, {},
    ]) await assert.rejects(settings.save(input), { status: 400 });
    assert.deepEqual(settings.get(), before);
    assert.equal(settings.model.apiKey, initial.apiKey);
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    try {
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_model_settings").get()?.count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_model_selection").get()?.count, 0);
      database.exec("CREATE TRIGGER fail_selection BEFORE INSERT ON app_model_selection BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
      await assert.rejects(settings.save({ modelId: "default" }), /test write failure/);
      assert.deepEqual(settings.get(), before);
    } finally { database.close(); }
  } finally { settings?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("显式目录逐项严格校验，错误不包含配置值，不回退环境或旧配置", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-validation-"));
  const file = join(directory, "models.json");
  try {
    await assert.rejects(openSettings(directory, initial, file), /模型目录/);
    const invalid: unknown[] = [null, {}, "not-an-array", [null], ["model"], [{ ...catalog[0], id: "" }],
      [{ ...catalog[0], id: "bad\nid" }], [{ ...catalog[0], id: " padded " }], [catalog[0], catalog[0]],
      [{ ...catalog[0], name: "" }], [{ ...catalog[0], name: "name\n" }], [{ ...catalog[0], provider: "faux" }],
      [{ ...catalog[0], provider: "unsupported-test-provider" }], [{ ...catalog[0], baseUrl: "file:///private" }],
      [{ ...catalog[0], baseUrl: "https://user:test-url-key@provider.example" }],
      [{ ...catalog[0], baseUrl: "https://:test-url-key@provider.example" }],
      [{ ...catalog[0], baseUrl: "https://provider.example?key=test-url-key" }],
      [{ ...catalog[0], baseUrl: "https://provider.example/#test-url-key" }],
      [{ ...catalog[0], model: "" }], [{ ...catalog[0], apiKey: "" }], [{ ...catalog[0], apiKey: "test\nkey" }],
      [{ ...catalog[0], apiKey: 123 }], [{ ...catalog[0], contextWindow: "128000" }],
      [{ ...catalog[0], contextWindow: 0 }], [{ ...catalog[0], maxTokens: -1 }],
      [{ ...catalog[0], maxTokens: 1.5 }], [{ ...catalog[0], contextWindow: 1024, maxTokens: 2048 }],
      [{ ...catalog[0], extra: "test-unexpected-key" }],
    ];
    for (const input of invalid) {
      await writeFile(file, JSON.stringify(input));
      await assert.rejects(openSettings(directory, initial, file), error => {
        assert.match(String(error), /模型目录/);
        for (const value of [initial.apiKey, "test-url-key", "unsupported-test-provider", "test-unexpected-key"]) assert.equal(String(error).includes(value), false);
        return true;
      });
    }
    await writeFile(file, '{"bad":"test-malformed-secret"');
    await assert.rejects(openSettings(directory, initial, file), error => {
      assert.equal(String(error).includes("test-malformed-secret"), false);
      return true;
    });
    await writeFile(file, "[]");
    const emptyCatalog = await openSettings(directory, initial, file);
    try {
      assert.deepEqual(emptyCatalog.get(), { models: [], selectedModel: "", activeModel: "", restartRequired: false });
      assert.equal(emptyCatalog.model.apiKey, "");
      await assert.rejects(emptyCatalog.save({ modelId: "default" }), { status: 400 });
    } finally { emptyCatalog.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("目录是唯一配置源，有效环境优先旧 SQLite，服务器配置不覆盖旧凭据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-priority-"));
  const opened: Awaited<ReturnType<typeof openModelSettings>>[] = [];
  const legacy = { provider: initial.api, baseUrl: "https://legacy.example/v1", model: "legacy-model", apiKey: "legacy-test-key" };
  try {
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    database.exec("CREATE TABLE app_model_settings (id INTEGER PRIMARY KEY, config TEXT NOT NULL); CREATE TABLE existing_notes (text TEXT); INSERT INTO existing_notes VALUES ('keep this note')");
    database.prepare("INSERT INTO app_model_settings VALUES (1, ?)").run(JSON.stringify(legacy));
    database.close();
    const environment = await openModelSettings(directory, initial); opened.push(environment);
    assert.equal(environment.model.model, initial.model);
    assert.equal(environment.get().activeModel, "default");
    const file = join(directory, "models.json");
    await writeFile(file, JSON.stringify([catalog[1]]));
    const explicit = await openSettings(directory, initial, file); opened.push(explicit);
    assert.equal(explicit.model.model, "upstream-b");
    assert.deepEqual(explicit.get().models, [{ id: "quality", name: "quality" }]);
    await explicit.save({ modelId: "quality" });
    await assert.rejects(explicit.save({ modelId: "default" }), { status: 400 });
    const old = await openModelSettings(directory, empty); opened.push(old);
    assert.equal(old.model.model, legacy.model);
    assert.equal(old.model.apiKey, legacy.apiKey);
    assert.equal(old.get().activeModel, "default");
    const check = new DatabaseSync(join(directory, "agent.sqlite"));
    try {
      assert.equal(JSON.parse(String(check.prepare("SELECT config FROM app_model_settings").get()?.config)).apiKey, legacy.apiKey);
      assert.equal(check.prepare("SELECT text FROM existing_notes").get()?.text, "keep this note");
      check.exec("UPDATE app_model_settings SET config = 'bad-json-test-key'");
    } finally { check.close(); }
    const trusted = await openModelSettings(directory, initial); opened.push(trusted);
    assert.equal(trusted.model.model, initial.model);
    await assert.rejects(openModelSettings(directory, empty), /SQLite 中的模型配置无效/);
  } finally { for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("旧 JSON 仅在缺少服务器配置时迁移，迁移成功后删除且保留其他 SQLite 数据", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-migration-"));
  const opened: Awaited<ReturnType<typeof openModelSettings>>[] = [];
  try {
    const legacy = join(directory, "model-settings.json");
    await writeFile(legacy, JSON.stringify({ provider: initial.api, baseUrl: initial.baseUrl, model: initial.model, apiKey: "legacy-test-key" }));
    const environment = await openModelSettings(directory, initial); opened.push(environment);
    assert.equal(environment.model.apiKey, initial.apiKey);
    assert.equal((await readdir(directory)).includes("model-settings.json"), true);
    const migrated = await openModelSettings(directory, empty); opened.push(migrated);
    assert.equal(migrated.model.apiKey, "legacy-test-key");
    assert.equal(migrated.get().activeModel, "default");
    assert.equal((await readdir(directory)).includes("model-settings.json"), false);
    const restarted = await openModelSettings(directory, empty); opened.push(restarted);
    assert.equal(restarted.model.apiKey, "legacy-test-key");
    for (const connection of opened) connection.close();
    assert.deepEqual(await readdir(directory), ["agent.sqlite"]);
  } finally { for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("无效旧 JSON 保留原文件且没有配置写入，可信服务器配置可忽略损坏旧文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-bad-migration-"));
  try {
    await writeFile(join(directory, "model-settings.json"), "bad legacy settings");
    await assert.rejects(openModelSettings(directory, empty), /未迁移/);
    assert.equal((await readdir(directory)).includes("model-settings.json"), true);
    const trusted = await openModelSettings(directory, initial);
    try { assert.equal(trusted.model.model, initial.model); } finally { trusted.close(); }
    const database = new DatabaseSync(join(directory, "agent.sqlite"));
    try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM app_model_settings").get()?.count, 0); }
    finally { database.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("已选目录项被移除后重启回到首项，目录内容修改也只在重启生效", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-catalog-restart-"));
  const opened: Awaited<ReturnType<typeof openModelSettings>>[] = [];
  try {
    const file = join(directory, "models.json");
    await writeFile(file, JSON.stringify(catalog));
    const first = await openSettings(directory, empty, file); opened.push(first);
    await first.save({ modelId: "quality" });
    await writeFile(file, JSON.stringify([{ ...catalog[0], model: "upstream-updated", apiKey: "updated-test-key" }]));
    assert.equal(first.model.model, initial.model);
    assert.equal(first.get().activeModel, "fast");
    const restarted = await openSettings(directory, empty, file); opened.push(restarted);
    assert.deepEqual(restarted.get(), { models: [{ id: "fast", name: "快速模型" }], selectedModel: "fast", activeModel: "fast", restartRequired: false });
    assert.equal(restarted.model.model, "upstream-updated");
    assert.equal(restarted.model.apiKey, "updated-test-key");
  } finally { for (const connection of opened) connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("faux 仅作为内部测试目录兼容，未配置模型不返回任何连接字段", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-model-faux-"));
  try {
    const faux = await openModelSettings(directory, { ...empty, api: "faux" });
    try {
      assert.equal(faux.model.api, "faux");
      assert.equal(faux.get().activeModel, "faux");
      assert.equal(faux.get().models.length, 1);
    } finally { faux.close(); }
    const missing = await openModelSettings(directory, empty);
    try { assert.deepEqual(missing.get(), { models: [], selectedModel: "", activeModel: "", restartRequired: false }); }
    finally { missing.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
