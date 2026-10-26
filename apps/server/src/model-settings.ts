import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelConfig } from "@assistant/runtime";
import type { ModelSettings } from "@assistant/contracts";
import { HttpError } from "./errors.js";

type CatalogEntry = { id: string; name: string; config: ModelConfig };
const providers = ["openai-completions", "openai-responses", "anthropic-messages"];
const defaults = { contextWindow: 128000, maxTokens: 8192 };

function field(input: Record<string, unknown>, name: string, limit: number): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} 格式不正确`);
  return value.trim();
}

function parseConfig(input: Record<string, unknown>, limits = defaults): ModelConfig {
  const api = field(input, "provider", 50), baseUrl = field(input, "baseUrl", 2048);
  const model = field(input, "model", 200), apiKey = field(input, "apiKey", 8192);
  if (!providers.includes(api)) throw new Error("provider 格式不正确");
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new Error("baseUrl 格式不正确"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("baseUrl 格式不正确");
  const positiveInteger = (name: "contextWindow" | "maxTokens") => {
    const value = input[name] === undefined ? limits[name] : input[name];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 格式不正确`);
    return value;
  };
  const contextWindow = positiveInteger("contextWindow"), maxTokens = positiveInteger("maxTokens");
  if (maxTokens > contextWindow) throw new Error("maxTokens 超出 contextWindow");
  return { api, baseUrl, model, apiKey, contextWindow, maxTokens };
}

async function readCatalog(file: string): Promise<CatalogEntry[]> {
  let input: unknown;
  try { input = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new Error("服务器模型目录读取失败，请检查 LLM_MODELS_FILE 指向的 JSON 文件"); }
  if (!Array.isArray(input)) throw new Error("服务器模型目录必须是数组");
  const ids = new Set<string>();
  const allowed = ["id", "name", "provider", "baseUrl", "model", "apiKey", "contextWindow", "maxTokens"];
  return input.map((value: unknown, index) => {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("条目必须是对象");
      const entry = value as Record<string, unknown>;
      if (Object.keys(entry).some(key => !allowed.includes(key))) throw new Error("条目含有未知字段");
      const id = field(entry, "id", 200);
      if (id !== entry.id || ids.has(id)) throw new Error("id 重复或格式不正确");
      ids.add(id);
      const name = entry.name === undefined ? id : field(entry, "name", 200);
      return { id, name, config: parseConfig(entry) };
    } catch (error) {
      // Validation errors describe fields, never values from the credential file.
      throw new Error(`服务器模型目录第 ${index + 1} 项无效：${(error as Error).message}`);
    }
  });
}

function singleModel(config: ModelConfig): CatalogEntry[] {
  return [{ id: "default", name: "默认模型", config }];
}

export async function openModelSettings(dataDir: string, fallback: ModelConfig, catalogFile = "") {
  // An explicit file is the entire catalog, even when empty. Server configuration
  // takes precedence without reading or overwriting old credential records.
  let catalog: CatalogEntry[] | undefined;
  if (catalogFile) catalog = await readCatalog(catalogFile);
  else if (fallback.api === "faux") catalog = [{ id: "faux", name: "faux（自动化测试）", config: { ...fallback } }];
  else if (fallback.baseUrl && fallback.model && fallback.apiKey) {
    try { catalog = singleModel(parseConfig({ ...fallback, provider: fallback.api })); }
    catch { throw new Error("服务器模型配置无效，请检查 LLM_* 环境变量"); }
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "agent.sqlite"), legacy = join(dataDir, "model-settings.json");
  const handle = await open(file, "a", 0o600);
  try { await handle.chmod(0o600); } finally { await handle.close(); }
  for (const suffix of ["-wal", "-shm"]) {
    try { await chmod(file + suffix, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const database = new DatabaseSync(file);
  let selectedModel: string;
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS app_model_settings (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_model_selection (id INTEGER PRIMARY KEY CHECK (id = 1), model_id TEXT NOT NULL)");
    if (catalog === undefined) {
      const row = database.prepare("SELECT config FROM app_model_settings WHERE id = 1").get();
      if (row) {
        try { catalog = singleModel(parseConfig(JSON.parse(String(row.config)), fallback)); }
        catch { throw new Error("SQLite 中的模型配置无效"); }
      } else {
        let input: unknown;
        try { input = JSON.parse(await readFile(legacy, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("旧模型配置文件无效，未迁移"); }
        if (input !== undefined) {
          let config: ModelConfig;
          try {
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("模型配置必须是对象");
            config = parseConfig(input as Record<string, unknown>, fallback);
          } catch { throw new Error("旧模型配置文件无效，未迁移"); }
          const value = JSON.stringify({ ...config, provider: config.api });
          database.prepare("INSERT INTO app_model_settings (id, config) VALUES (1, ?)").run(value);
          // Remove the old credential file only after the SQLite write succeeds.
          await rm(legacy, { force: true });
          catalog = singleModel(config);
        } else catalog = [];
      }
    }
    const selection = database.prepare("SELECT model_id FROM app_model_selection WHERE id = 1").get();
    selectedModel = catalog.find(entry => entry.id === selection?.model_id)?.id ?? catalog[0]?.id ?? "";
  } catch (error) {
    database.close();
    throw error;
  }
  const entries = catalog;
  const activeModel = selectedModel;
  const active = { ...(entries.find(entry => entry.id === activeModel)?.config ?? { api: "openai-completions", baseUrl: "", model: "", apiKey: "", ...defaults }) };
  const secrets = new Set([fallback.apiKey, ...entries.map(entry => entry.config.apiKey)].filter(Boolean));
  let closed = false;
  function get(): ModelSettings {
    return { models: entries.map(({ id, name }) => ({ id, name })), selectedModel, activeModel, restartRequired: selectedModel !== activeModel };
  }
  async function save(input: Record<string, unknown>): Promise<ModelSettings> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, "modelId")) throw new HttpError(400, "模型设置只接受 modelId，请在服务器配置模型");
    const modelId = input.modelId;
    if (typeof modelId !== "string" || !entries.some(entry => entry.id === modelId)) throw new HttpError(400, "请选择服务器目录中的模型");
    database.prepare("INSERT INTO app_model_selection (id, model_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET model_id = excluded.model_id").run(modelId);
    selectedModel = modelId;
    return get();
  }
  function redact(value: unknown) {
    let text = String(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "***");
    return text;
  }
  function close() { if (!closed) { database.close(); closed = true; } }
  return { model: active, get, save, redact, close };
}
