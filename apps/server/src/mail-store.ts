import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MailMessage, MailNotices, MailSettingsInput } from "@assistant/contracts";
import type { MailQuery } from "@assistant/features";
import { createNotificationPreferences } from "./notification-preferences.js";
import { notificationDeliveryAt } from "./notification-policy.js";

import { createMailDelivery } from "./mail-delivery.js";

const DIGEST_WINDOW_MS = 60_000;

export type MailRecord = MailMessage & { text: string };
export type MailTokens = { refreshToken: string; accessToken: string; expiresAt: number };
export type MailState = {
  settings: MailSettingsInput; tokens: MailTokens | null; cursor: string | null;
  initialComplete: boolean; initialSince: string; lastSuccessAt: string | null;
  accountKey?: string | null; accountLoginBlocked?: boolean;
};
export function openMailStore(dir: string) {
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  let state: MailState;
  let preferences: ReturnType<typeof createNotificationPreferences>;
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS outlook_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outlook_messages (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outlook_messages_time ON outlook_messages(received_at);
      CREATE TABLE IF NOT EXISTS outlook_notices (sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);`);
    if (!(db.prepare("PRAGMA table_info(outlook_notices)").all() as { name: string }[]).some(column => column.name === "cancelled_at")) {
      db.exec("ALTER TABLE outlook_notices ADD COLUMN cancelled_at TEXT");
    }
    preferences = createNotificationPreferences(db);
    // A later unread flag must not revive a notice the user already handled.
    db.prepare(`UPDATE outlook_notices SET cancelled_at = ? WHERE cancelled_at IS NULL AND message_id IN
      (SELECT id FROM outlook_messages WHERE json_extract(value, '$.isRead') = 1)`).run(new Date().toISOString());
    const row = db.prepare("SELECT value FROM outlook_state WHERE id = 1").get();
    state = row ? JSON.parse(String(row.value)) as MailState : {
      settings: { enabled: false, tenantId: "", clientId: "" }, tokens: null, cursor: null,
      initialComplete: false, initialSince: new Date(Date.now() - 30 * 86400000).toISOString(), lastSuccessAt: null,
    };
  } catch (error) { db.close(); throw error; }
  function persist(next: MailState) {
    db.prepare("INSERT INTO outlook_state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  }
  function update(patch: Partial<MailState>) { const next = { ...state, ...patch }; persist(next); state = next; }
  const unpack = (value: unknown) => JSON.parse(String(value)) as MailRecord;
  function list(query: MailQuery): MailMessage[] {
    // 数据先用 SQL 按时间限界；关键词使用 instr，% 和 _ 不作为通配符。
    const conditions: string[] = [], params: (string | number)[] = [];
    for (const [key, columns] of [["sender", ["sender", "address"]], ["subject", ["subject"]]] as const) {
      const text = query[key]?.trim();
      if (text) { conditions.push(`(${columns.map(c => `instr(lower(json_extract(value, '$.${c}')), lower(?)) > 0`).join(" OR ")})`); params.push(...columns.map(() => text)); }
    }
    if (query.unread) conditions.push("json_extract(value, '$.isRead') = 0");
    if (query.sinceHours) { conditions.push("received_at >= ?"); params.push(new Date(Date.now() - query.sinceHours * 3600000).toISOString()); }
    return db.prepare(`SELECT value FROM outlook_messages ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY received_at DESC, id LIMIT ?`)
      .all(...params, query.limit).map(r => { const { text: _, ...message } = unpack(r.value); return message; });
  }
  function reset(settings = state.settings, tokens: MailTokens | null = null, accountKey = state.accountKey ?? null) {
    const next: MailState = { settings, tokens, accountKey, accountLoginBlocked: false, cursor: null, initialComplete: false,
      initialSince: new Date(Date.now() - 30 * 86400000).toISOString(), lastSuccessAt: null };
    db.exec("BEGIN IMMEDIATE");
    try { db.exec("DELETE FROM outlook_messages; DELETE FROM outlook_notices; DELETE FROM outlook_deliveries; DELETE FROM outlook_delivery_members; DELETE FROM outlook_delivery_clients; DELETE FROM outlook_delivery_activation"); persist(next); db.exec("COMMIT"); state = next; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function page(messages: MailRecord[], removed: string[], cursor: string, complete: boolean) {
    const next = { ...state, cursor, initialComplete: state.initialComplete || complete,
      lastSuccessAt: complete ? new Date().toISOString() : state.lastSuccessAt };
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of removed) {
        db.prepare("DELETE FROM outlook_messages WHERE id = ?").run(id);
        db.prepare("UPDATE outlook_notices SET cancelled_at = COALESCE(cancelled_at, ?) WHERE message_id = ?").run(new Date().toISOString(), id);
      }
      for (const message of messages) {
        const exists = db.prepare("SELECT 1 FROM outlook_messages WHERE id = ?").get(message.id);
        db.prepare("INSERT INTO outlook_messages (id, received_at, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET received_at = excluded.received_at, value = excluded.value")
          .run(message.id, message.receivedAt, JSON.stringify(message));
        if (!exists && state.initialComplete) db.prepare("INSERT OR IGNORE INTO outlook_notices(message_id, created_at) VALUES (?, ?)").run(message.id, new Date().toISOString());
        if (message.isRead) db.prepare("UPDATE outlook_notices SET cancelled_at = COALESCE(cancelled_at, ?) WHERE message_id = ?").run(new Date().toISOString(), message.id);
      }
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      db.prepare("DELETE FROM outlook_messages WHERE received_at < ?").run(cutoff);
      db.prepare("DELETE FROM outlook_notices WHERE created_at < ?").run(new Date(Date.now() - 7 * 86400000).toISOString());
      persist(next); db.exec("COMMIT"); state = next;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  // AUTOINCREMENT's high water survives cancellation/pruning and account resets.
  const noticeSequence = () => Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'outlook_notices'").get()?.seq ?? 0);
  const pendingNotices = "FROM outlook_notices n JOIN outlook_messages m ON m.id = n.message_id WHERE n.sequence > ? AND n.cancelled_at IS NULL";
  function notices(after: number): MailNotices {
    const latest = noticeSequence();
    const items = db.prepare("SELECT n.sequence, m.value " + pendingNotices + " ORDER BY n.sequence LIMIT 50").all(after)
      .map(r => { const { text: _, ...message } = unpack(r.value); return { sequence: Number(r.sequence), message }; });
    return { latest, items };
  }
  function deliveryNotices(after: number): MailNotices {
    const latest = noticeSequence();
    const pending = db.prepare(`SELECT COUNT(*) AS total, MIN(n.created_at) AS first,
      MAX(CASE WHEN json_extract(m.value, '$.importance') = 'high' THEN 1 ELSE 0 END) AS urgent,
      MAX(CASE WHEN json_extract(m.value, '$.importance') IS NULL THEN 1 ELSE 0 END) AS unclassified ` + pendingNotices).get(after)!;
    const total = Number(pending.total), urgent = pending.urgent === 1;
    if (!total) return { latest, items: [], cursor: Math.max(after, latest), total: 0, urgent: false };
    const now = Date.now();
    // Existing Graph delta tokens may omit the newly selected importance field.
    // Unknown priority fails open rather than delaying a potentially urgent message.
    if (notificationDeliveryAt(preferences.get().quietHours, now, urgent || pending.unclassified === 1 ? "urgent" : "normal", Date.parse(String(pending.first)) + DIGEST_WINDOW_MS) > now) {
      return { latest, items: [], cursor: after, total: 0, urgent: false };
    }
    // One urgent item releases one combined digest, not a sequence of overdue toasts.
    // Prioritize urgent previews so a large normal backlog cannot hide their subjects.
    const items = db.prepare("SELECT n.sequence, m.value " + pendingNotices +
      " ORDER BY CASE WHEN json_extract(m.value, '$.importance') = 'high' THEN 1 ELSE 0 END DESC, n.sequence DESC LIMIT 50").all(after)
      .map(r => { const { text: _, ...message } = unpack(r.value); return { sequence: Number(r.sequence), message }; })
      .sort((a, b) => a.sequence - b.sequence);
    return { latest, items, cursor: latest, total, urgent };
  }
  const delivery = createMailDelivery(db, preferences);
  return { claimDelivery: delivery.claim, acknowledgeDelivery: delivery.acknowledge, state: () => state, configured: () => !!db.prepare("SELECT 1 FROM outlook_state WHERE id = 1").get(), update, reset, page, list, notices, deliveryNotices,
    read(id: string) { const row = db.prepare("SELECT value FROM outlook_messages WHERE id = ?").get(id); if (!row) return; const { text, ...message } = unpack(row.value); return { message, text }; },
    close: () => db.close() };
}
export type MailStore = ReturnType<typeof openMailStore>;
