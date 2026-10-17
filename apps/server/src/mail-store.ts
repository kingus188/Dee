import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MailMessage, MailNotices, MailSettingsInput } from "@assistant/contracts";
import type { MailQuery } from "@assistant/features";

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
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS outlook_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outlook_messages (id TEXT PRIMARY KEY, received_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outlook_messages_time ON outlook_messages(received_at);
      CREATE TABLE IF NOT EXISTS outlook_notices (sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);`);
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
    try { db.exec("DELETE FROM outlook_messages; DELETE FROM outlook_notices"); persist(next); db.exec("COMMIT"); state = next; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function page(messages: MailRecord[], removed: string[], cursor: string, complete: boolean) {
    const next = { ...state, cursor, initialComplete: state.initialComplete || complete,
      lastSuccessAt: complete ? new Date().toISOString() : state.lastSuccessAt };
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of removed) {
        db.prepare("DELETE FROM outlook_messages WHERE id = ?").run(id);
        db.prepare("DELETE FROM outlook_notices WHERE message_id = ?").run(id);
      }
      for (const message of messages) {
        const exists = db.prepare("SELECT 1 FROM outlook_messages WHERE id = ?").get(message.id);
        db.prepare("INSERT INTO outlook_messages (id, received_at, value) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET received_at = excluded.received_at, value = excluded.value")
          .run(message.id, message.receivedAt, JSON.stringify(message));
        if (!exists && state.initialComplete) db.prepare("INSERT OR IGNORE INTO outlook_notices(message_id, created_at) VALUES (?, ?)").run(message.id, new Date().toISOString());
      }
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      db.prepare("DELETE FROM outlook_messages WHERE received_at < ?").run(cutoff);
      db.prepare("DELETE FROM outlook_notices WHERE message_id NOT IN (SELECT id FROM outlook_messages) OR created_at < ?").run(new Date(Date.now() - 7 * 86400000).toISOString());
      persist(next); db.exec("COMMIT"); state = next;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function notices(after: number): MailNotices {
    const latest = Number(db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM outlook_notices").get()!.n);
    const items = db.prepare("SELECT n.sequence, m.value FROM outlook_notices n JOIN outlook_messages m ON m.id = n.message_id WHERE n.sequence > ? ORDER BY n.sequence LIMIT 50").all(after)
      .map(r => { const { text: _, ...message } = unpack(r.value); return { sequence: Number(r.sequence), message }; });
    return { latest, items };
  }
  return { state: () => state, configured: () => !!db.prepare("SELECT 1 FROM outlook_state WHERE id = 1").get(), update, reset, page, list, notices,
    read(id: string) { const row = db.prepare("SELECT value FROM outlook_messages WHERE id = ?").get(id); if (!row) return; const { text, ...message } = unpack(row.value); return { message, text }; },
    close: () => db.close() };
}
export type MailStore = ReturnType<typeof openMailStore>;
