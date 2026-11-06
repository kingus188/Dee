import type { DatabaseSync } from "node:sqlite";
import type { NotificationPreferences, NotificationReadState, WebhookAttentionPreferences, WebhookDigestPreferences } from "@assistant/contracts";
import { HttpError } from "./errors.js";
import { validateQuietHours } from "./notification-quiet-hours.js";

const defaults: NotificationPreferences = { quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "Asia/Shanghai" } };

const defaultDigest: WebhookDigestPreferences = { enabled: false, windowSeconds: 60 };
const defaultAttention: WebhookAttentionPreferences = { enabled: false, maxPerHour: 6, cooldownSeconds: 300 };
function validateAttention(input: unknown): WebhookAttentionPreferences {
  if (!input || typeof input !== "object") throw new HttpError(400, "Webhook 减少打扰设置无效");
  const { enabled, maxPerHour, cooldownSeconds } = input as Record<string, unknown>;
  if (typeof enabled !== "boolean" || typeof maxPerHour !== "number" || !Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > 60 ||
    typeof cooldownSeconds !== "number" || !Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 3600) {
    throw new HttpError(400, "普通 Webhook 每小时预算须为 1–60，冷却须为 0–3600 秒的整数");
  }
  return { enabled, maxPerHour, cooldownSeconds };
}
function validateDigest(input: unknown): WebhookDigestPreferences {
  if (!input || typeof input !== "object") throw new HttpError(400, "Webhook 摘要设置无效");
  const { enabled, windowSeconds } = input as Record<string, unknown>;
  if (typeof enabled !== "boolean" || typeof windowSeconds !== "number" || !Number.isInteger(windowSeconds) || windowSeconds < 10 || windowSeconds > 3600) {
    throw new HttpError(400, "Webhook 摘要窗口须为 10–3600 秒的整数");
  }
  return { enabled, windowSeconds };
}

// Shares the outbox connection and its shutdown path; no separate lifecycle resource.
export function createNotificationPreferences(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_read_marks (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, version_key TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS notification_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  function reads(): NotificationReadState {
    const rows = db.prepare("SELECT version_key FROM notification_read_marks ORDER BY sequence").all();
    return { keys: rows.map(row => String(row.version_key)) };
  }
  function mark(input: Record<string, unknown>): NotificationReadState {
    const { keys, read } = input;
    if (typeof read !== "boolean" || !Array.isArray(keys) || keys.length > 500 || keys.some(key => typeof key !== "string" || !key.trim() || key.length > 1024 || /[\u0000-\u001f\u007f]/.test(key))) {
      throw new HttpError(400, "阅读标记须为最多 500 条有效版本键和布尔状态");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const remove = db.prepare("DELETE FROM notification_read_marks WHERE version_key = ?");
      const add = db.prepare("INSERT INTO notification_read_marks(version_key) VALUES (?)");
      for (const key of new Set(keys as string[])) { remove.run(key); if (read) add.run(key); }
      db.exec("DELETE FROM notification_read_marks WHERE sequence NOT IN (SELECT sequence FROM notification_read_marks ORDER BY sequence DESC LIMIT 500)");
      const state = reads(); db.exec("COMMIT"); return state;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function get(): NotificationPreferences {
    const row = db.prepare("SELECT value FROM notification_preferences WHERE key = 'quiet-hours'").get();
    const digest = db.prepare("SELECT value FROM notification_preferences WHERE key = 'webhook-digest'").get();
    const attention = db.prepare("SELECT value FROM notification_preferences WHERE key = 'webhook-attention'").get();
    return { quietHours: row ? validateQuietHours(JSON.parse(String(row.value))) : { ...defaults.quietHours },
      webhookDigest: digest ? validateDigest(JSON.parse(String(digest.value))) : { ...defaultDigest },
      webhookAttention: attention ? validateAttention(JSON.parse(String(attention.value))) : { ...defaultAttention } };
  }
  function save(input: Record<string, unknown>): NotificationPreferences {
    const quietHours = validateQuietHours(input.quietHours);
    const webhookDigest = input.webhookDigest === undefined ? undefined : validateDigest(input.webhookDigest);
    const webhookAttention = input.webhookAttention === undefined ? undefined : validateAttention(input.webhookAttention);
    db.exec("BEGIN IMMEDIATE");
    try {
      const put = db.prepare("INSERT INTO notification_preferences(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      put.run("quiet-hours", JSON.stringify(quietHours));
      if (webhookDigest) put.run("webhook-digest", JSON.stringify(webhookDigest));
      if (webhookAttention) put.run("webhook-attention", JSON.stringify(webhookAttention));
      const result = get(); db.exec("COMMIT"); return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return { reads, mark, get, save };
}
