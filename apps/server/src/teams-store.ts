import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TeamsChatRef, TeamsDraft, TeamsDraftDelivery, TeamsDraftInput, TeamsAutoReplyDelivery, AwayStatus, TeamsInboxQuery, TeamsMessageRow } from "@assistant/features";
import { messageText } from "./teams-message-text.js";
import { createSourceLifecycle } from "./source-lifecycle.js";
import { openTeamsArchive } from "./teams-archive-store.js";
import { teamsRecords } from "./teams-records.js";
import { createTeamsNotificationBatches, type TeamsNotice } from "./teams-notification-batches.js";
import { createTeamsTriageStore } from "./teams-triage-store.js";

export type TeamsMessage = {
  id: string; chatId: string; chatType: string; senderId: string; senderName: string;
  direction: "in" | "out"; text: string; createdAt: string; important: boolean; chatTopic?: string; notificationPriority?: "normal" | "urgent" | "approval";
  addressedToMe?: boolean; sourceUrl?: string;
};
const RETENTION_DAYS = 90;
const iso = (ms: number) => new Date(ms).toISOString();

// Teams 聊天记录与「已推送 / 已回复」标记，与 Agent 同库（agent.sqlite）。
export function openTeamsStore(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "agent.sqlite"));
  let archive: ReturnType<typeof openTeamsArchive>;
  let sources: ReturnType<typeof createSourceLifecycle>;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    archive = openTeamsArchive(db);
    sources = createSourceLifecycle(db);
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS teams_messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, chat_type TEXT NOT NULL,
        sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        text TEXT NOT NULL, created_at TEXT NOT NULL, important INTEGER NOT NULL DEFAULT 0, pushed_at TEXT, replied_at TEXT);
      CREATE INDEX IF NOT EXISTS teams_messages_chat ON teams_messages (chat_id, created_at);
      CREATE TABLE IF NOT EXISTS teams_away (
        id INTEGER PRIMARY KEY CHECK (id = 1), status TEXT NOT NULL, reply TEXT NOT NULL, since TEXT NOT NULL, until TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS teams_auto_replies (
        message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, at TEXT NOT NULL, away_version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS teams_auto_reply_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, away_version INTEGER NOT NULL,
        source_message_id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL, candidate_message_id TEXT,
        UNIQUE (chat_id, away_version));
      CREATE TABLE IF NOT EXISTS teams_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL, chat_id TEXT NOT NULL, label TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, explicit INTEGER NOT NULL DEFAULT 0)`);
    if (!(db.prepare("PRAGMA table_info(teams_drafts)").all() as { name: string }[]).some(column => column.name === "explicit")) db.exec("ALTER TABLE teams_drafts ADD COLUMN explicit INTEGER NOT NULL DEFAULT 0");
    if (!(db.prepare("PRAGMA table_info(teams_drafts)").all() as { name: string }[]).some(column => column.name === "source_entry_id")) db.exec("ALTER TABLE teams_drafts ADD COLUMN source_entry_id INTEGER");
    if (!(db.prepare("PRAGMA table_info(teams_drafts)").all() as { name: string }[]).some(column => column.name === "confirmation_after_entry_id")) db.exec("ALTER TABLE teams_drafts ADD COLUMN confirmation_after_entry_id INTEGER");
    if (!(db.prepare("PRAGMA table_info(teams_drafts)").all() as { name: string }[]).some(column => column.name === "delivery_state")) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec("ALTER TABLE teams_drafts ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'");
        // 旧 sent_at 混用了占用和成功。仍可重放的近期占用锁聊天；已过期旧稿只封存，
        // 不伪称成功，也不让整段历史阻断新的授权。新版 unknown 永不按时间解锁。
        db.prepare("UPDATE teams_drafts SET delivery_state = CASE WHEN created_at >= ? THEN 'unknown' ELSE 'legacy_unknown' END WHERE sent_at IS NOT NULL")
          .run(iso(Date.now() - 30 * 60_000));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    // 进程中断时没有可靠发送回执；重启只改为未知，绝不恢复为可发送。
    db.exec("UPDATE teams_drafts SET delivery_state = 'unknown' WHERE delivery_state = 'sending'");
    db.exec("UPDATE teams_auto_reply_attempts SET state = 'unknown' WHERE state = 'sending'");
    db.exec("CREATE INDEX IF NOT EXISTS teams_drafts_chat ON teams_drafts (conversation_id, chat_id, id)");
    // 旧库没有群名列：一次性补上，历史行保持为空。
    if (!(db.prepare("PRAGMA table_info(teams_messages)").all() as { name: string }[]).some(column => column.name === "chat_topic")) db.exec("ALTER TABLE teams_messages ADD COLUMN chat_topic TEXT");
    for (const column of ["notification_priority", "notification_note", "notification_cancelled_at"]) if (!(db.prepare("PRAGMA table_info(teams_messages)").all() as { name: string }[]).some(item => item.name === column)) db.exec(`ALTER TABLE teams_messages ADD COLUMN ${column} TEXT`);
    for (const column of ["addressed_to_me", "source_url"]) if (!(db.prepare("PRAGMA table_info(teams_messages)").all() as { name: string }[]).some(item => item.name === column)) db.exec(`ALTER TABLE teams_messages ADD COLUMN ${column} ${column === "addressed_to_me" ? "INTEGER NOT NULL DEFAULT 0" : "TEXT"}`);
    if (!(db.prepare("PRAGMA table_info(teams_messages)").all() as { name: string }[]).some(column => column.name === "source_stale")) db.exec("ALTER TABLE teams_messages ADD COLUMN source_stale INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE TEMP VIEW visible_teams_messages AS SELECT m.* FROM teams_messages m
      WHERE m.source_stale=0 AND NOT EXISTS (SELECT 1 FROM source_message_revocations r WHERE r.source='teams:'||m.chat_id AND r.message_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM source_lifecycle s WHERE s.source='teams:'||m.chat_id AND s.revoked_at IS NOT NULL)`);
    db.prepare("DELETE FROM teams_messages WHERE created_at < ?").run(iso(Date.now() - RETENTION_DAYS * 86_400_000));
  } catch (error) { db.close(); throw error; }

  const insert = db.prepare("INSERT OR IGNORE INTO teams_messages (id, chat_id, chat_type, sender_id, sender_name, direction, text, created_at, important, chat_topic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  // 两种到达顺序都归一为第一条晚于来信的自己发出的消息；启动时也修复旧库。
  // 状态自动回复是代发的安抚语，不是用户处理过这件事：算已推送，但不能把来信标成已回复。
  const replyTime = `(SELECT MIN(o.created_at) FROM visible_teams_messages o
    WHERE o.chat_id = teams_messages.chat_id AND o.direction = 'out' AND o.created_at > teams_messages.created_at
      AND o.id NOT IN (SELECT message_id FROM teams_auto_replies)
      AND o.id NOT IN (SELECT candidate_message_id FROM teams_auto_reply_attempts WHERE candidate_message_id IS NOT NULL))`;
  const reconcile = `UPDATE teams_messages SET replied_at = ${replyTime}
    WHERE direction = 'in' AND ${replyTime} IS NOT NULL AND (replied_at IS NULL OR replied_at > ${replyTime})`;
  try { db.exec(reconcile); } catch (error) { db.close(); throw error; }
  const markReplied = db.prepare(reconcile + " AND chat_id = ?");
  // 代发的安抚语先入库、后登记，所以登记后要按该聊天重算（可能回到未回复）。
  const recompute = db.prepare(`UPDATE teams_messages SET replied_at = ${replyTime} WHERE direction = 'in' AND chat_id = ?`);
  const row = (r: Record<string, unknown>): TeamsMessageRow & TeamsNotice => ({
    id: String(r.id), chatId: String(r.chat_id), chatTopic: (r.chat_topic as string | null) ?? null, chatType: String(r.chat_type), senderName: String(r.sender_name), direction: r.direction as "in" | "out", text: String(r.text),
    createdAt: String(r.created_at), important: r.important === 1, pushedAt: (r.pushed_at as string | null) ?? null, repliedAt: (r.replied_at as string | null) ?? null,
    notificationPriority: (r.notification_priority as TeamsNotice["notificationPriority"]) ?? undefined,
    notificationNote: r.notification_note == null ? undefined : String(r.notification_note),
    notificationCancelledAt: r.notification_cancelled_at == null ? undefined : String(r.notification_cancelled_at),
    media: archive.mediaRows(String(r.chat_id), String(r.id).slice(String(r.chat_id).length + 1)),
  });

  const autoReplyRow = (r: Record<string, unknown>): TeamsAutoReplyDelivery => ({
    id: Number(r.id), chatId: String(r.chat_id), label: String(r.label), text: String(r.text),
    sourceMessageId: String(r.source_message_id), state: r.state as TeamsAutoReplyDelivery["state"],
  });
  const draftRow = (r: Record<string, unknown>): TeamsDraftDelivery => ({
    id: Number(r.id), chatId: String(r.chat_id), label: String(r.label), text: String(r.text), explicit: r.explicit === 1,
    sourceEntryId: (r.confirmation_after_entry_id ?? r.source_entry_id) == null ? null : Number(r.confirmation_after_entry_id ?? r.source_entry_id), state: r.delivery_state as TeamsDraftDelivery["state"],
  });

  let notifications: ReturnType<typeof createTeamsNotificationBatches<ReturnType<typeof row>>>;
  let triage: ReturnType<typeof createTeamsTriageStore>;
  try { triage = createTeamsTriageStore(db); } catch (error) { db.close(); throw error; }
  try { notifications = createTeamsNotificationBatches(db, row, () => triage.settings().normalDigestMinutes * 60_000); } catch (error) { db.close(); throw error; }
  return {
    archive,
    notifications,
    triage,
    sourceRevision: sources.revision,
    sourceAllowed: sources.allowed,
    revokeMessage(chatId: string, messageId: string) {
      db.exec("BEGIN IMMEDIATE");
      try {
        sources.revoke(`teams:${chatId}`, messageId);
        notifications.cancelSource(messageId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    records(rows: TeamsMessageRow[]) {
      const messages = rows.flatMap(row => {
        if (!row.id || !row.chatId) return [];
        const message = archive.message(row.chatId, row.id.slice(row.chatId.length + 1));
        return message ? [{ ...message, chatId: row.chatId }] : [];
      });
      return messages.length === rows.length ? teamsRecords(archive, messages) : [];
    },
    // 重复写入同一条消息无副作用；用户自己发出的消息会把此前该聊天里的未回复来信标为已回复。
    record(message: TeamsMessage) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!sources.allowed(`teams:${message.chatId}`, undefined, [message.id])) { db.exec("COMMIT"); return; }
        const prior = db.prepare("SELECT source_stale,text FROM teams_messages WHERE id=?").get(message.id);
        const latest = archive.message(message.chatId, message.id.slice(message.chatId.length + 1));
        // A sync that started before an archive edit can finish afterwards,
        // even after a newer sync already cleared the fence. Conflicting cached
        // text stays unavailable until it agrees with the current archive.
        if ((latest && messageText(latest) !== message.text) || (prior?.source_stale && !latest)) {
          if (!prior?.source_stale) {
            sources.invalidate(`teams:${message.chatId}`);
            notifications.cancelSource(message.id);
            db.prepare("UPDATE teams_messages SET source_stale=1 WHERE id=?").run(message.id);
          }
          db.exec("COMMIT"); return;
        }
        if (prior && prior.text !== message.text) {
          sources.invalidate(`teams:${message.chatId}`);
          notifications.cancelSource(message.id);
        }
        const inserted = insert.run(message.id, message.chatId, message.chatType, message.senderId, message.senderName, message.direction, message.text, message.createdAt, message.important ? 1 : 0, message.chatTopic ?? null);
        if (!inserted.changes) db.prepare("UPDATE teams_messages SET text=?,source_stale=0 WHERE id=?").run(message.text, message.id);
        if (message.notificationPriority) db.prepare("UPDATE teams_messages SET notification_priority = ? WHERE id = ?").run(message.notificationPriority, message.id);
        if (message.addressedToMe !== undefined) db.prepare("UPDATE teams_messages SET addressed_to_me=? WHERE id=?").run(message.addressedToMe ? 1 : 0, message.id);
        if (message.sourceUrl !== undefined) db.prepare("UPDATE teams_messages SET source_url=? WHERE id=?").run(message.sourceUrl, message.id);
        // 回执丢失后同步到的首条同正文消息可能是自动代回。保守保留待办，
        // 不据此认定发送成功或解除未知锁定；真实回执到达后改用确切 ID。
        let candidate = false;
        if (message.direction === "out") {
          const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
          const attempts = db.prepare(`SELECT id, text FROM teams_auto_reply_attempts WHERE chat_id = ?
            AND state IN ('sending', 'sent', 'unknown') AND candidate_message_id IS NULL
            AND julianday(at) <= julianday(?) + 5.0 / 86400 ORDER BY at DESC`).all(message.chatId, message.createdAt) as { id: number; text: string }[];
          const attempt = attempts.find(item => normalize(item.text) === normalize(message.text));
          if (attempt) {
            db.prepare("UPDATE teams_auto_reply_attempts SET candidate_message_id = ? WHERE id = ?").run(message.id, attempt.id);
            candidate = true;
          }
        }
        if (candidate) recompute.run(message.chatId);
        else if (inserted.changes) markReplied.run(message.chatId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    // 重要且尚未推送的来信（最近 24 小时，最多 100 条，按时间正序）。
    pendingPush() {
      return db.prepare("SELECT * FROM visible_teams_messages WHERE important = 1 AND direction = 'in' AND pushed_at IS NULL AND replied_at IS NULL AND notification_cancelled_at IS NULL AND created_at >= ? ORDER BY created_at LIMIT 100")
        .all(iso(Date.now() - 86_400_000)).map(row);
    },
    notificationIds() {
      return (db.prepare("SELECT id FROM visible_teams_messages WHERE direction = 'in' AND important = 1").all() as { id: string }[]).map(row => row.id);
    },
    notificationHistoryIds() {
      return (db.prepare(`SELECT id FROM teams_messages WHERE direction = 'in' AND important = 1
        UNION SELECT chat_id || ':' || id AS id FROM teams_archive_messages
        UNION SELECT message_id AS id FROM source_message_revocations WHERE source LIKE 'teams:%'`).all() as { id: string }[]).map(row => row.id);
    },
    notificationHistorySources() {
      return (db.prepare("SELECT message_ids FROM teams_notification_batches").all() as { message_ids: string }[]).map(row => JSON.parse(row.message_ids) as string[]);
    },
    message(id: string) {
      const found = db.prepare("SELECT * FROM visible_teams_messages WHERE id = ?").get(id);
      return found ? row(found) : undefined;
    },
    earliestNotificationAt(chatId: string) {
      return (db.prepare("SELECT MIN(created_at) AS at FROM visible_teams_messages WHERE chat_id = ? AND direction = 'in' AND important = 1 AND replied_at IS NULL AND notification_cancelled_at IS NULL AND created_at >= ?")
        .get(chatId, iso(Date.now() - 86400_000)) as { at: string | null }).at;
    },
    earliestUnrepliedAt(chatId: string) {
      return (db.prepare("SELECT MIN(created_at) AS at FROM visible_teams_messages WHERE chat_id = ? AND direction = 'in' AND replied_at IS NULL").get(chatId) as { at: string | null }).at;
    },
    // 同一聊天中早于 before 的最近 limit 条消息（含自己发出的），按时间正序，用作新消息的上下文。
    recentInChat(chatId: string, before: string, limit: number) {
      return db.prepare("SELECT * FROM visible_teams_messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?")
        .all(chatId, before, limit).map(row).reverse();
    },
    // 晚于 after 的全部消息（含自己发出的），按时间正序，供整理情景摘要。
    messagesSince(after: string, limit: number) {
      return db.prepare("SELECT * FROM visible_teams_messages WHERE created_at > ? ORDER BY created_at LIMIT ?").all(after, limit).map(row);
    },
    // Read body and privacy revision in one SQLite statement/snapshot. Reading
    // the revision later could incorrectly stamp old text with a newer version.
    episodeMessagesSince(after: string, limit: number) {
      return db.prepare(`SELECT m.*,COALESCE(s.revision,0) AS source_revision FROM visible_teams_messages m
        LEFT JOIN source_lifecycle s ON s.source='teams:'||m.chat_id WHERE m.created_at>? ORDER BY m.created_at LIMIT ?`)
        .all(after, limit).map(item => ({ ...row(item), sourceRevision: Number(item.source_revision) }));
    },
    // 工作状态：到点自动失效，用户不再交代就恢复正常流程，不需要定时清理。
    away() {
      const found = db.prepare("SELECT status, reply, since, until, version FROM teams_away WHERE id = 1 AND until > ?").get(iso(Date.now())) as Record<string, string | number> | undefined;
      return found && { status: String(found.status), reply: String(found.reply), since: String(found.since), until: String(found.until), version: Number(found.version) };
    },
    // version 每次设置自增，用来区分状态期，不依赖时间精度。
    setAway(input: { status: string; reply: string; until: string }) {
      db.prepare(`INSERT INTO teams_away (id, status, reply, since, until, version) VALUES (1, ?, ?, ?, ?,
        (SELECT COALESCE(MAX(version), 0) + 1 FROM (SELECT away_version AS version FROM teams_auto_replies UNION ALL SELECT away_version AS version FROM teams_auto_reply_attempts)))
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, reply = excluded.reply, since = excluded.since, until = excluded.until,
          version = teams_away.version + 1`)
        .run(input.status, input.reply, iso(Date.now()), input.until);
    },
    clearAway(expected?: AwayStatus) {
      const now = iso(Date.now());
      if (!expected) return Number(db.prepare("UPDATE teams_away SET until = ? WHERE id = 1 AND until > ?").run(now, now).changes) === 1;
      // 重放停止只清除当时的版本，不能取消用户后来新开的状态；保留版本供下次递增。
      return Number(db.prepare("UPDATE teams_away SET until = ? WHERE id = 1 AND version = ? AND since = ? AND status = ? AND reply = ? AND until = ?")
        .run(now, expected.version, expected.since, expected.status, expected.reply, expected.until).changes) === 1;
    },
    // 同一状态期内每个聊天只自动回一次；用户换状态后可以再回一次。
    autoRepliedIn(chatId: string, version: number) {
      return !!db.prepare("SELECT 1 FROM teams_auto_replies WHERE chat_id = ? AND away_version = ? LIMIT 1").get(chatId, version);
    },
    autoReplyAttempt(chatId: string, version: number) {
      return (db.prepare("SELECT state FROM teams_auto_reply_attempts WHERE chat_id = ? AND away_version = ?").get(chatId, version) as { state: TeamsAutoReplyDelivery["state"] } | undefined)?.state;
    },
    unresolvedAutoReplies() {
      return db.prepare("SELECT * FROM teams_auto_reply_attempts WHERE state IN ('sending', 'unknown') ORDER BY id").all().map(autoReplyRow);
    },
    blockedAutoReply(chatId: string) {
      const found = db.prepare("SELECT * FROM teams_auto_reply_attempts WHERE chat_id = ? AND state IN ('sending', 'unknown') ORDER BY id LIMIT 1").get(chatId);
      return found ? autoReplyRow(found) : undefined;
    },
    resolveAutoReply(id: number, state: "sent" | "cancelled") {
      return Number(db.prepare("UPDATE teams_auto_reply_attempts SET state = ? WHERE id = ? AND state = 'unknown'").run(state, id).changes) === 1;
    },
    claimAutoReply(chatId: string, version: number, sourceMessageId: string, label: string, text: string) {
      return Number(db.prepare(`INSERT OR IGNORE INTO teams_auto_reply_attempts (chat_id, away_version, source_message_id, label, text, state, at)
        SELECT ?, ?, ?, ?, ?, 'sending', ?
        WHERE NOT EXISTS (SELECT 1 FROM teams_auto_replies WHERE chat_id = ? AND away_version = ?)
        AND NOT EXISTS (SELECT 1 FROM teams_auto_reply_attempts WHERE chat_id = ? AND state IN ('sending', 'unknown'))
        AND NOT EXISTS (SELECT 1 FROM teams_drafts WHERE chat_id = ? AND delivery_state IN ('sending', 'unknown'))`)
        .run(chatId, version, sourceMessageId, label, text, iso(Date.now()), chatId, version, chatId, chatId).changes) === 1;
    },
    releaseAutoReply(chatId: string, version: number) {
      db.prepare("DELETE FROM teams_auto_reply_attempts WHERE chat_id = ? AND away_version = ? AND state = 'sending'").run(chatId, version);
    },
    markAutoReplyUnknown(chatId: string, version: number) {
      db.prepare("UPDATE teams_auto_reply_attempts SET state = 'unknown' WHERE chat_id = ? AND away_version = ? AND state = 'sending'").run(chatId, version);
    },
    recordAutoReply(chatId: string, messageId: string, version: number, receiptKnown = true) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO teams_auto_replies (message_id, chat_id, at, away_version) VALUES (?, ?, ?, ?)").run(messageId, chatId, iso(Date.now()), version);
        db.prepare("UPDATE teams_auto_reply_attempts SET state = 'sent', candidate_message_id = CASE WHEN ? THEN ? ELSE candidate_message_id END WHERE chat_id = ? AND away_version = ?")
          .run(receiptKnown ? 1 : 0, messageId, chatId, version);
        recompute.run(chatId);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
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
        where.push("(chat_topic LIKE ? ESCAPE '\\' OR chat_id IN (SELECT chat_id FROM visible_teams_messages WHERE chat_type = 'oneOnOne' AND direction = 'in' AND sender_name LIKE ? ESCAPE '\\'))");
        params.push(like, like);
      }
      if (query.sinceHours && query.sinceHours > 0) { where.push("created_at >= ?"); params.push(iso(Date.now() - query.sinceHours * 3_600_000)); }
      const sql = `SELECT * FROM visible_teams_messages ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
      return db.prepare(sql).all(...params, query.limit).map(row);
    },
    // 按群名（群聊）或对方姓名（私聊）找聊天；完全同名的优先，避免「张三」误匹配「张三丰」。
    findChats(name: string): TeamsChatRef[] {
      const like = `%${name.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = db.prepare("SELECT chat_id, chat_type, chat_topic, sender_name FROM visible_teams_messages WHERE chat_topic LIKE ? ESCAPE '\\' OR (chat_type = 'oneOnOne' AND direction = 'in' AND sender_name LIKE ? ESCAPE '\\') ORDER BY created_at DESC").all(like, like) as Record<string, string | null>[];
      const found = new Map<string, TeamsChatRef & { name: string }>();
      for (const r of rows) {
        const id = String(r.chat_id);
        if (found.has(id)) continue;
        const oneOnOne = r.chat_type === "oneOnOne";
        const label = String(oneOnOne ? r.sender_name : r.chat_topic);
        found.set(id, { chatId: id, label: oneOnOne ? `私聊「${label}」` : `群聊「${label}」`, name: label });
      }
      const all = [...found.values()];
      const exact = all.filter((chat) => chat.name.toLowerCase() === name.toLowerCase());
      return (exact.length ? exact : all).map(({ chatId, label }) => ({ chatId, label }));
    },
    saveDraft(draft: TeamsDraftInput) {
      // 安全重放：同一用户输入的同一版草稿复用 ID，已发送的也不能重新创建。
      const existing = db.prepare("SELECT id FROM teams_drafts WHERE conversation_id = ? AND source_entry_id = ? AND chat_id = ? AND label = ? AND text = ? ORDER BY id DESC LIMIT 1")
        .get(draft.conversationId, draft.sourceEntryId, draft.chatId, draft.label, draft.text) as { id: number } | undefined;
      if (existing) return existing.id;
      return Number(db.prepare("INSERT INTO teams_drafts (conversation_id, chat_id, label, text, created_at, explicit, source_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(draft.conversationId, draft.chatId, draft.label, draft.text, iso(Date.now()), draft.explicit ? 1 : 0, draft.sourceEntryId).lastInsertRowid);
    },
    // 用户在该聊天里最近一次来信之后自己发出的消息；没有则说明还没回复。
    alreadyReplied(chatId: string) {
      const r = db.prepare("SELECT text, created_at FROM visible_teams_messages WHERE chat_id = ? AND direction = 'out' AND created_at > COALESCE((SELECT MAX(created_at) FROM visible_teams_messages WHERE chat_id = ? AND direction = 'in'), '') ORDER BY created_at DESC LIMIT 1").get(chatId, chatId) as { text: string; created_at: string } | undefined;
      return r && { text: r.text, at: r.created_at };
    },
    // 每个聊天只保留最新版本供发送；新版本发出或过期后，旧版本也不会复活。
    pendingDrafts(conversationId: number, maxAgeMs: number): TeamsDraft[] {
      return db.prepare(`SELECT * FROM teams_drafts WHERE conversation_id = ? AND delivery_state = 'pending' AND sent_at IS NULL AND created_at >= ?
        AND id IN (SELECT MAX(id) FROM teams_drafts WHERE conversation_id = ? GROUP BY chat_id) ORDER BY id DESC`)
        .all(conversationId, iso(Date.now() - maxAgeMs), conversationId).map(r => ({
          id: Number(r.id), chatId: String(r.chat_id), label: String(r.label), text: String(r.text), explicit: r.explicit === 1,
          sourceEntryId: (r.confirmation_after_entry_id ?? r.source_entry_id) == null ? null : Number(r.confirmation_after_entry_id ?? r.source_entry_id),
        }));
    },
    claim: (id: number, conversationId: number, maxAgeMs: number) => Number(db.prepare(`UPDATE teams_drafts SET sent_at = ?, delivery_state = 'sending'
      WHERE id = ? AND conversation_id = ? AND delivery_state = 'pending' AND sent_at IS NULL AND created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM teams_drafts blocked WHERE blocked.chat_id = teams_drafts.chat_id AND blocked.delivery_state IN ('sending', 'unknown'))
      AND NOT EXISTS (SELECT 1 FROM teams_auto_reply_attempts blocked WHERE blocked.chat_id = teams_drafts.chat_id AND blocked.state IN ('sending', 'unknown'))
      AND id = (SELECT MAX(newest.id) FROM teams_drafts AS newest WHERE newest.conversation_id = teams_drafts.conversation_id AND newest.chat_id = teams_drafts.chat_id)`)
      .run(iso(Date.now()), id, conversationId, iso(Date.now() - maxAgeMs)).changes) === 1,
    // 只有明确拒绝的正在发送请求允许释放；unknown / sent 永远不能经此路径复活。
    release(id: number) { db.prepare("UPDATE teams_drafts SET sent_at = NULL, delivery_state = 'pending' WHERE id = ? AND delivery_state = 'sending'").run(id); },
    markDelivery(id: number, state: "sent" | "unknown") {
      db.prepare("UPDATE teams_drafts SET delivery_state = ? WHERE id = ? AND delivery_state = 'sending'").run(state, id);
    },
    delivery(id: number, conversationId: number) {
      const found = db.prepare("SELECT * FROM teams_drafts WHERE id = ? AND conversation_id = ?").get(id, conversationId);
      return found ? draftRow(found) : undefined;
    },
    unresolvedDrafts(conversationId: number) {
      return db.prepare("SELECT * FROM teams_drafts WHERE conversation_id = ? AND delivery_state IN ('sending', 'unknown') ORDER BY id").all(conversationId).map(draftRow);
    },
    blockedDraft(chatId: string) {
      const found = db.prepare("SELECT * FROM teams_drafts WHERE chat_id = ? AND delivery_state IN ('sending', 'unknown') ORDER BY id LIMIT 1").get(chatId);
      return found ? draftRow(found) : undefined;
    },
    resolveDelivery(id: number, conversationId: number, state: "pending" | "sent" | "cancelled", sourceEntryId: number) {
      // 恢复待发时提高确认水位，但保留原始 source_entry_id 供重放防重；旧确认不能重用。
      return Number(db.prepare(`UPDATE teams_drafts SET delivery_state = ?, sent_at = CASE WHEN ? = 'pending' THEN NULL ELSE sent_at END,
        confirmation_after_entry_id = CASE WHEN ? = 'pending' THEN ? ELSE confirmation_after_entry_id END
        WHERE id = ? AND conversation_id = ? AND delivery_state IN ('unknown', 'legacy_unknown')`)
        .run(state, state, state, sourceEntryId, id, conversationId).changes) === 1;
    },
    close: () => db.close(),
  };
}
export type TeamsStore = ReturnType<typeof openTeamsStore>;
