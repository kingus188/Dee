import type { DatabaseSync } from "node:sqlite";
import type { NotificationPreferences, NotificationReadState } from "@assistant/contracts";
import { HttpError } from "./errors.js";
import { validateQuietHours } from "./notification-quiet-hours.js";

const defaults: NotificationPreferences = { quietHours: { enabled: false, start: "22:00", end: "08:00", timeZone: "Asia/Shanghai" } };

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
    return { quietHours: row ? validateQuietHours(JSON.parse(String(row.value))) : { ...defaults.quietHours } };
  }
  function save(input: Record<string, unknown>): NotificationPreferences {
    const quietHours = validateQuietHours(input.quietHours);
    db.prepare("INSERT INTO notification_preferences(key, value) VALUES ('quiet-hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(quietHours));
    return { quietHours };
  }
  return { reads, mark, get, save };
}
