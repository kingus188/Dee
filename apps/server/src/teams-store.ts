import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TeamsChatRef, TeamsDraft, TeamsInboxQuery, TeamsMessageRow } from "@assistant/features";

export type TeamsMessage = {
  id: string; chatId: string; chatType: string; senderId: string; senderName: string;
  direction: "in" | "out"; text: string; createdAt: string; important: boolean; chatTopic?: string;
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
      CREATE INDEX IF NOT EXISTS teams_messages_chat ON teams_messages (chat_id, created_at);
      CREATE TABLE IF NOT EXISTS teams_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, chat_id TEXT NOT NULL, label TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT)`);
    // 旧库没有群名列：一次性补上，历史行保持为空。
    if (!(db.prepare("PRAGMA table_info(teams_messages)").all() as { name: string }[]).some(column => column.name === "chat_topic")) db.exec("ALTER TABLE teams_messages ADD COLUMN chat_topic TEXT");
    db.prepare("DELETE FROM teams_messages WHERE created_at < ?").run(iso(Date.now() - RETENTION_DAYS * 86_400_000));
  } catch (error) { db.close(); throw error; }

  const insert = db.prepare("INSERT OR IGNORE INTO teams_messages (id, chat_id, chat_type, sender_id, sender_name, direction, text, created_at, important, chat_topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const markReplied = db.prepare("UPDATE teams_messages SET replied_at = ? WHERE chat_id = ? AND direction = 'in' AND replied_at IS NULL AND created_at < ?");
  const row = (r: Record<string, unknown>): TeamsMessageRow & { id: string; chatId: string; chatTopic: string | null } => ({
    id: String(r.id), chatId: String(r.chat_id), chatTopic: (r.chat_topic as string | null) ?? null, chatType: String(r.chat_type), senderName: String(r.sender_name), direction: r.direction as "in" | "out", text: String(r.text),
    createdAt: String(r.created_at), important: r.important === 1, pushedAt: (r.pushed_at as string | null) ?? null, repliedAt: (r.replied_at as string | null) ?? null,
  });

  return {
    // 重复写入同一条消息无副作用；用户自己发出的消息会把此前该聊天里的未回复来信标为已回复。
    record(message: TeamsMessage) {
      insert.run(message.id, message.chatId, message.chatType, message.senderId, message.senderName, message.direction, message.text, message.createdAt, message.important ? 1 : 0, message.chatTopic ?? null);
      if (message.direction === "out") markReplied.run(message.createdAt, message.chatId, message.createdAt);
    },
    // 重要且尚未推送的来信（最近 24 小时，最多 100 条，按时间正序）。
    pendingPush() {
      return db.prepare("SELECT * FROM teams_messages WHERE important = 1 AND direction = 'in' AND pushed_at IS NULL AND created_at >= ? ORDER BY created_at LIMIT 100")
        .all(iso(Date.now() - 86_400_000)).map(row);
    },
    // 同一聊天中早于 before 的最近 limit 条消息（含自己发出的），按时间正序，用作新消息的上下文。
    recentInChat(chatId: string, before: string, limit: number) {
      return db.prepare("SELECT * FROM teams_messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
        .all(chatId, before, limit).map(row).reverse();
    },
    // 晚于 after 的全部消息（含自己发出的），按时间正序，供整理情景摘要。
    messagesSince(after: string, limit: number) {
      return db.prepare("SELECT * FROM teams_messages WHERE created_at > ? ORDER BY created_at LIMIT ?").all(after, limit).map(row);
    },
    markPushed(id: string) { db.prepare("UPDATE teams_messages SET pushed_at = ? WHERE id = ?").run(iso(Date.now()), id); },
    list(query: TeamsInboxQuery): TeamsMessageRow[] {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.unreplied) where.push("direction = 'in' AND replied_at IS NULL");
      if (query.sender) { where.push("sender_name LIKE ? ESCAPE '\\'"); params.push(`%${query.sender.replace(/[\\%_]/g, "\\$&")}%`); }
      if (query.chat) {
        // 群聊按群名匹配；私聊按对方姓名匹配，取整段对话（含我发出的）。
        const like = `%${query.chat.replace(/[\\%_]/g, "\\$&")}%`;
        where.push("(chat_topic LIKE ? ESCAPE '\\' OR chat_id IN (SELECT chat_id FROM teams_messages WHERE chat_type = 'oneOnOne' AND direction = 'in' AND sender_name LIKE ? ESCAPE '\\'))");
        params.push(like, like);
      }
      if (query.sinceHours && query.sinceHours > 0) { where.push("created_at >= ?"); params.push(iso(Date.now() - query.sinceHours * 3_600_000)); }
      const sql = `SELECT * FROM teams_messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
      return db.prepare(sql).all(...params, query.limit).map(row);
    },
    // 按群名（群聊）或对方姓名（私聊）找聊天；完全同名的优先，避免「张三」误匹配「张三丰」。
    findChats(name: string): TeamsChatRef[] {
      const like = `%${name.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = db.prepare("SELECT chat_id, chat_type, chat_topic, sender_name FROM teams_messages WHERE chat_topic LIKE ? ESCAPE '\\' OR (chat_type = 'oneOnOne' AND direction = 'in' AND sender_name LIKE ? ESCAPE '\\') ORDER BY created_at DESC").all(like, like) as Record<string, string | null>[];
      const found = new Map<string, TeamsChatRef & { name: string }>();
      for (const r of rows) {
        const id = String(r.chat_id);
        if (found.has(id)) continue;
        const oneOnOne = r.chat_type === "oneOnOne";
        const label = String(oneOnOne ? r.sender_name : r.chat_topic);
        found.set(id, { chatId: id, label: oneOnOne ? `私聊「${label}」` : `群聊「${label}」`, name: label });
      }
      const all = [...found.values()];
      const exact = all.filter((chat) => chat.name === name);
      return (exact.length === 1 ? exact : all).map(({ chatId, label }) => ({ chatId, label }));
    },
    saveDraft(draft: TeamsChatRef & { conversationId: number; text: string }) {
      return Number(db.prepare("INSERT INTO teams_drafts (conversation_id, chat_id, label, text, created_at) VALUES (?, ?, ?, ?, ?)").run(draft.conversationId, draft.chatId, draft.label, draft.text, iso(Date.now())).lastInsertRowid);
    },
    latestDraft(conversationId: number, maxAgeMs: number): TeamsDraft | undefined {
      const r = db.prepare("SELECT * FROM teams_drafts WHERE conversation_id = ? AND sent_at IS NULL AND created_at >= ? ORDER BY id DESC LIMIT 1").get(conversationId, iso(Date.now() - maxAgeMs)) as Record<string, unknown> | undefined;
      return r && { id: Number(r.id), chatId: String(r.chat_id), label: String(r.label), text: String(r.text) };
    },
    claim: (id: number) => Number(db.prepare("UPDATE teams_drafts SET sent_at = ? WHERE id = ? AND sent_at IS NULL").run(iso(Date.now()), id).changes) === 1,
    release(id: number) { db.prepare("UPDATE teams_drafts SET sent_at = NULL WHERE id = ?").run(id); },
    close: () => db.close(),
  };
}
export type TeamsStore = ReturnType<typeof openTeamsStore>;
