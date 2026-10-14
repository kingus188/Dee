import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WechatSettings } from "@assistant/contracts";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";

type Saved = { enabled: boolean; sendUrl: string; webhookKey: string; sendToken: string };

function parse(input: Record<string, unknown>, previous: Saved): Saved {
  if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled 格式不正确");
  const sendUrl = typeof input.sendUrl === "string" ? input.sendUrl.trim() : "";
  let endpoint: URL;
  try { endpoint = new URL(sendUrl); } catch { throw new HttpError(400, "发送地址必须是完整的 HTTP 地址"); }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new HttpError(400, "发送地址只能是本机 HTTP 地址，不能包含账号、密码、查询参数或片段");
  }
  const fresh = input.regenerate === true || !previous.webhookKey;
  return { enabled: input.enabled, sendUrl, webhookKey: fresh ? randomBytes(32).toString("hex") : previous.webhookKey,
    sendToken: fresh ? randomBytes(32).toString("hex") : previous.sendToken };
}

// 微信通道配置与模型配置同库保存；密钥由服务端生成，用户只需把它们填进 wx-bot。
export function openWechatSettings(dataDir: string, fallback: AppConfig["wechat"]) {
  const database = new DatabaseSync(join(dataDir, "agent.sqlite"));
  let saved: Saved;
  try {
    database.exec("PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS app_wechat_settings (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL)");
    const row = database.prepare("SELECT config FROM app_wechat_settings WHERE id = 1").get();
    if (row) {
      try { saved = JSON.parse(String(row.config)); } catch { throw new Error("SQLite 中的微信配置无效"); }
    } else saved = { enabled: fallback.enabled, sendUrl: fallback.sendURL, webhookKey: fallback.webhookKey, sendToken: fallback.sendToken };
  } catch (error) { database.close(); throw error; }
  const active = { ...saved };
  const get = (): WechatSettings => ({ ...saved, restartRequired: JSON.stringify(saved) !== JSON.stringify(active) });
  function save(input: Record<string, unknown>) {
    const next = parse(input, saved);
    database.prepare("INSERT INTO app_wechat_settings (id, config) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config").run(JSON.stringify(next));
    saved = next;
    return get();
  }
  return { active: { enabled: active.enabled, sendURL: active.sendUrl, webhookKey: active.webhookKey, sendToken: active.sendToken },
    get, save, close: () => database.close() };
}
