import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TeamsInboxQuery, TeamsMessageRow } from "@assistant/features";

export type TeamsMessage = {
  id: string; chatId: string; chatType: string; senderId: string; senderName: string;
  direction: "in" | "out"; text: string; createdAt: string; important: boolean;
};
const RETENTION_DAYS = 90;
const iso = (ms: number) => new Date(ms).toISOString();

// Teams 聊天记录与「已推送 / 已回复」标记，与 Agent 同库（agent.sqlite）。
export function openTeamsStore(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "agent.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS teams_messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, chat_type TEXT NOT NULL,
        sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        text TEXT NOT NULL, created_at TEXT NOT NULL, important INTEGER NOT NULL DEFAULT 0, pushed_at TEXT, replied_at TEXT);
      CREATE INDEX IF NOT EXISTS teams_messages_chat ON teams_messages (chat_id, created_at)`);
    db.prepare("DELETE FROM teams_messages WHERE created_at < ?").run(iso(Date.now() - RETENTION_DAYS * 86_400_000));
  } catch (error) { db.close(); throw error; }

  const insert = db.prepare("INSERT OR IGNORE INTO teams_messages (id, chat_id, chat_type, sender_id, sender_name, direction, text, created_at, important) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const markReplied = db.prepare("UPDATE teams_messages SET replied_at = ? WHERE chat_id = ? AND direction = 'in' AND replied_at IS NULL AND created_at < ?");
  const row = (r: Record<string, unknown>): TeamsMessageRow & { id: string } => ({
    id: String(r.id), chatType: String(r.chat_type), senderName: String(r.sender_name), direction: r.direction as "in" | "out", text: String(r.text),
    createdAt: String(r.created_at), important: r.important === 1, pushedAt: (r.pushed_at as string | null) ?? null, repliedAt: (r.replied_at as string | null) ?? null,
  });

  return {
    // 重复写入同一条消息无副作用；用户自己发出的消息会把此前该聊天里的未回复来信标为已回复。
    record(message: TeamsMessage) {
      insert.run(message.id, message.chatId, message.chatType, message.senderId, message.senderName, message.direction, message.text, message.createdAt, message.important ? 1 : 0);
      if (message.direction === "out") markReplied.run(message.createdAt, message.chatId, message.createdAt);
    },
    // 重要且尚未推送的来信（最近 24 小时，最多 100 条，按时间正序）。
    pendingPush() {
      return db.prepare("SELECT * FROM teams_messages WHERE important = 1 AND direction = 'in' AND pushed_at IS NULL AND created_at >= ? ORDER BY created_at LIMIT 100")
        .all(iso(Date.now() - 86_400_000)).map(row);
    },
    markPushed(id: string) { db.prepare("UPDATE teams_messages SET pushed_at = ? WHERE id = ?").run(iso(Date.now()), id); },
    list(query: TeamsInboxQuery): TeamsMessageRow[] {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.unreplied) where.push("direction = 'in' AND replied_at IS NULL");
      if (query.sender) { where.push("sender_name LIKE ? ESCAPE '\\'"); params.push(`%${query.sender.replace(/[\\%_]/g, "\\$&")}%`); }
      if (query.sinceHours && query.sinceHours > 0) { where.push("created_at >= ?"); params.push(iso(Date.now() - query.sinceHours * 3_600_000)); }
      const sql = `SELECT * FROM teams_messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
      return db.prepare(sql).all(...params, query.limit).map(row);
    },
    close: () => db.close(),
  };
}
export type TeamsStore = ReturnType<typeof openTeamsStore>;
