import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelConfig } from "@assistant/runtime";
import type { ModelSettings } from "@assistant/contracts";
import { HttpError } from "./errors.js";

function parseSettings(input: Record<string, unknown>, previous: ModelConfig): ModelConfig {
  const field = (name: string, limit: number) => {
    const value = input[name];
    if (typeof value !== "string" || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, `${name} 格式不正确`);
    return value.trim();
  };
  const api = field("provider", 50), baseUrl = field("baseUrl", 2048), model = field("model", 200);
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api)) throw new HttpError(400, "请选择支持的 Provider");
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new HttpError(400, "Base URL 必须是完整的 HTTP 或 HTTPS 地址"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new HttpError(400, "Base URL 必须是 HTTP 或 HTTPS 地址，不能包含账号、密码、查询参数或片段");
  }
  if (!model) throw new HttpError(400, "请填写模型 ID");
  const suppliedKey = input.apiKey === undefined ? "" : field("apiKey", 8192);
  if (!suppliedKey && (api !== previous.api || baseUrl !== previous.baseUrl)) throw new HttpError(400, "更换 Provider 或 Base URL 时，请重新填写 API Key");
  const apiKey = suppliedKey || previous.apiKey;
  if (!apiKey) throw new HttpError(400, "请填写 API Key");
  return { ...previous, api, baseUrl, model, apiKey };
}

export async function openModelSettings(dataDir: string, fallback: ModelConfig) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "agent.sqlite"), legacy = join(dataDir, "model-settings.json");
  const handle = await open(file, "a", 0o600);
  try { await handle.chmod(0o600); } finally { await handle.close(); }
  for (const suffix of ["-wal", "-shm"]) {
    try { await chmod(file + suffix, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const database = new DatabaseSync(file);
  let saved = { ...fallback };
  try {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS app_model_settings (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL)");
    const row = database.prepare("SELECT config FROM app_model_settings WHERE id = 1").get();
    let input: unknown;
    if (row) {
      try { input = JSON.parse(String(row.config)); }
      catch { throw new Error("SQLite 中的模型配置无效"); }
    } else {
      try { input = JSON.parse(await readFile(legacy, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("旧模型配置文件无效，未迁移"); }
      if (input === undefined && fallback.api !== "faux" && fallback.baseUrl && fallback.model && fallback.apiKey) {
        input = { provider: fallback.api, baseUrl: fallback.baseUrl, model: fallback.model, apiKey: fallback.apiKey };
      }
    }
    if (input !== undefined) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("模型配置必须是对象");
      saved = parseSettings(input as Record<string, unknown>, fallback);
      if (!row) persist(saved);
      // Remove the old credential file only after the SQLite write has succeeded.
      await rm(legacy, { force: true });
    }
  } catch (error) {
    database.close();
    throw error;
  }
  const active = { ...saved }, secrets = new Set([fallback.apiKey, saved.apiKey].filter(Boolean));
  let closed = false;
  function persist(config: ModelConfig) {
    const value = JSON.stringify({ provider: config.api, baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey });
    database.prepare("INSERT INTO app_model_settings (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config").run(value);
  }
  function get(): ModelSettings {
    let baseUrl = "";
    if (URL.canParse(saved.baseUrl)) {
      const endpoint = new URL(saved.baseUrl);
      if (["http:", "https:"].includes(endpoint.protocol)) {
        if (!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash) baseUrl = saved.baseUrl;
        else {
          endpoint.username = ""; endpoint.password = ""; endpoint.search = ""; endpoint.hash = "";
          baseUrl = endpoint.href;
        }
      }
    }
    return { provider: saved.api, baseUrl, model: saved.model, hasKey: Boolean(saved.apiKey), activeModel: active.baseUrl && active.model && active.apiKey ? active.model : "",
      restartRequired: saved.api !== active.api || saved.baseUrl !== active.baseUrl || saved.model !== active.model || saved.apiKey !== active.apiKey };
  }
  async function save(input: Record<string, unknown>) {
    const next = parseSettings(input, saved);
    persist(next);
    saved = next;
    secrets.add(next.apiKey);
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
