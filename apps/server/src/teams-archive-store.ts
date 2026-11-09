import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createSourceLifecycle } from "./source-lifecycle.js";
import { messageText } from "./teams-message-text.js";

export type ArchivedMessage = {
  id: string; createdDateTime: string; lastModifiedDateTime?: string; deletedDateTime?: string;
  from?: { user?: { id?: string; displayName?: string }; application?: { displayName?: string } }; webUrl?: string; body?: { content?: string; contentType?: string };
  attachments?: { id?: string; name?: string; contentType?: string; contentUrl?: string }[];
};
export type ArchiveMedia = { id: string; name: string; kind: "image" | "file"; status: string; url?: string; previewUrl?: string; error?: string };
export type ArchivedChat = { id: string; topic?: string; chatType?: string; members?: { displayName?: string }[] };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const mediaId = (chat: string, message: string, source: string) => digest(JSON.stringify([chat, message, source]));
const textOf = (message: ArchivedMessage) => (message.body?.content ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const imageSignature = (message: ArchivedMessage) => JSON.stringify((message.body?.content ?? "").match(/<img\b[^>]*>/gi) ?? []);
export function hostedImageIds(message: ArchivedMessage) {
  const ids = new Set<string>();
  for (const match of (message.body?.content ?? "").matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)) {
    const reference = (match[1] ?? match[2] ?? match[3]).match(/\/hostedContents\/([^/?#]+)\/(?:\$value|%24value)(?:[?#]|$)/i);
    if (reference) { try { ids.add(decodeURIComponent(reference[1])); } catch { /* Unknown references cannot retain old image bytes. */ } }
  }
  return [...ids];
}
const safeLink = (value?: string) => { try { const u = new URL(value ?? ""); return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined; } catch { return undefined; } };

export function openTeamsArchive(db: DatabaseSync) {
  const sources = createSourceLifecycle(db);
  const knownAccess = (chat: string) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teams_chat_access'").get() || db.prepare("SELECT available FROM teams_chat_access WHERE chat_id=?").get(chat)?.available !== 0;
  const allowed = (chat: string, id: string) => sources.allowed(`teams:${chat}`, undefined, [`${chat}:${id}`]);
  db.exec(`CREATE TABLE IF NOT EXISTS teams_archive_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS teams_archive_chats (id TEXT PRIMARY KEY, value TEXT NOT NULL, cursor TEXT, complete INTEGER NOT NULL DEFAULT 0,
      newest TEXT, scan_floor TEXT, scanned_at TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', retry_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS teams_archive_messages (chat_id TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL,
      sender TEXT NOT NULL, text TEXT NOT NULL, value TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(chat_id,id));
    CREATE INDEX IF NOT EXISTS teams_archive_time ON teams_archive_messages(chat_id,created_at,id);
    CREATE TABLE IF NOT EXISTS teams_archive_media (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
      source TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, url TEXT, mime TEXT, bytes BLOB,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS teams_archive_media_message ON teams_archive_media(chat_id,message_id);`);
  // Upgrade old archives before any reader can see them. Deletion markers
  // predate the shared ledger and must not become live just because it is new.
  for (const item of db.prepare("SELECT chat_id,id FROM teams_archive_messages WHERE json_valid(value) AND COALESCE(json_extract(value,'$.deletedDateTime'),'')!=''").all()) {
    sources.revoke(`teams:${String(item.chat_id)}`, `${String(item.chat_id)}:${String(item.id)}`);
  }
  const saveChat = db.prepare("INSERT INTO teams_archive_chats(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value");
  const saveMessage = db.prepare(`INSERT INTO teams_archive_messages(chat_id,id,created_at,sender,text,value,saved_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,id) DO UPDATE SET created_at=excluded.created_at,sender=excluded.sender,text=excluded.text,value=excluded.value,saved_at=excluded.saved_at`);
  const insertMedia = db.prepare(`INSERT INTO teams_archive_media(id,chat_id,message_id,source,name,kind,url,status) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url`);
  const mediaRows = (chatId: string, messageId: string): ArchiveMedia[] => (!knownAccess(chatId) || !allowed(chatId, messageId)) ? [] : (db.prepare("SELECT id,name,kind,url,status,error FROM teams_archive_media WHERE chat_id=? AND message_id=? ORDER BY id").all(chatId, messageId) as Record<string, string>[])
    .map(r => ({ id: r.id, name: r.name, kind: r.kind as "image" | "file", status: r.status, ...(r.url ? { url: r.url } : {}),
      ...(r.status === "ready" ? { previewUrl: `/api/teams/media/${r.id}` } : {}), ...(r.error ? { error: r.error } : {}) }));
  return {
    sourceRevision: (chatId: string) => sources.revision(`teams:${chatId}`),
    bindAccount(identity: string) {
      const key = digest(identity);
      const row = db.prepare("SELECT value FROM teams_archive_meta WHERE key='owner'").get() as { value: string } | undefined;
      if (row && row.value !== key) throw new Error("Teams 账号已变化，停止归档以免混入其他账号；请先处理原账号归档");
      db.prepare("INSERT OR IGNORE INTO teams_archive_meta(key,value) VALUES ('owner',?)").run(key);
    },
    messageDirection(senderId?: string): "in" | "out" | "unknown" {
      const owner = db.prepare("SELECT value FROM teams_archive_meta WHERE key='owner'").get()?.value;
      return senderId && owner ? digest(senderId) === owner ? "out" : "in" : "unknown";
    },
    chats(items: ArchivedChat[]) {
      for (const chat of items) { if (!chat.id) throw new Error("Teams 聊天缺少标识"); saveChat.run(chat.id, JSON.stringify(chat)); }
    },
    save(chatId: string, messages: ArchivedMessage[], expectedRevision?: number) {
      if (messages.some(m => !m.id || !Number.isFinite(Date.parse(m.createdDateTime)))) throw new Error("Teams 归档消息标识或时间无效");
      db.exec("BEGIN IMMEDIATE");
      try {
        const staleSnapshot = expectedRevision !== undefined && sources.revision(`teams:${chatId}`) !== expectedRevision;
        const hasCache = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='teams_messages'").get();
        for (const message of messages) {
          const previous = db.prepare("SELECT text,value FROM teams_archive_messages WHERE chat_id=? AND id=?").get(chatId, message.id);
          const previousMessage = previous ? JSON.parse(String(previous.value)) as ArchivedMessage : undefined;
          const incomingAt = Date.parse(message.lastModifiedDateTime ?? message.createdDateTime);
          const previousAt = previousMessage ? Date.parse(previousMessage.lastModifiedDateTime ?? previousMessage.createdDateTime) : -Infinity;
          // Deletion is monotonic. For ordinary content, reject known older
          // versions and network reads that crossed a source change.
          if (!message.deletedDateTime && (incomingAt < previousAt || (staleSnapshot && !(incomingAt > previousAt)))) continue;
          const filesChanged = !!previousMessage && JSON.stringify(previousMessage.attachments ?? []) !== JSON.stringify(message.attachments ?? []);
          const imagesChanged = !!previousMessage && imageSignature(previousMessage) !== imageSignature(message);
          // Media belongs to the current original, not to the message ID forever.
          // Clear removed/replaced references and bytes in the same transaction.
          const fileSources = (message.attachments ?? []).map((file, index) => `attachment:${file.id ?? index}`);
          // Reconcile on every accepted read, including old databases where the
          // original was already edited but obsolete media rows survived.
          const removedFiles = db.prepare(`DELETE FROM teams_archive_media WHERE chat_id=? AND message_id=? AND kind='file'${!filesChanged && fileSources.length ? ` AND source NOT IN (${fileSources.map(() => "?").join(",")})` : ""}`)
            .run(chatId, message.id, ...(!filesChanged ? fileSources : [])).changes;
          const imageSources = hostedImageIds(message);
          const removedImages = db.prepare(`DELETE FROM teams_archive_media WHERE chat_id=? AND message_id=? AND kind='image'${!imagesChanged && imageSources.length ? ` AND source NOT IN (${imageSources.map(() => "?").join(",")})` : ""}`)
            .run(chatId, message.id, ...(!imagesChanged ? imageSources : [])).changes;
          const cached = hasCache ? db.prepare("SELECT text,source_stale FROM teams_messages WHERE id=?").get(`${chatId}:${message.id}`) : undefined;
          if (message.deletedDateTime || filesChanged || imagesChanged || removedFiles || removedImages || (previous && previous.text !== textOf(message)) || (cached && !cached.source_stale && cached.text !== messageText(message))) {
            if (message.deletedDateTime) sources.revoke(`teams:${chatId}`, `${chatId}:${message.id}`);
            else sources.invalidate(`teams:${chatId}`);
            if (hasCache) {
              db.prepare("UPDATE teams_messages SET notification_cancelled_at=COALESCE(notification_cancelled_at,?),source_stale=1 WHERE id=?")
                .run(new Date().toISOString(), `${chatId}:${message.id}`);
            }
          }
          saveMessage.run(chatId, message.id, message.createdDateTime, message.from?.user?.displayName ?? "", textOf(message), JSON.stringify(message), new Date().toISOString());
          for (const [index, file] of (message.attachments ?? []).entries()) {
            const source = `attachment:${file.id ?? index}`;
            const url = safeLink(file.contentUrl);
            insertMedia.run(mediaId(chatId, message.id, source), chatId, message.id, source, file.name || "附件", "file", url ?? null, url ? "reference" : "unavailable");
          }
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    hosted(chatId: string, messageId: string, ids: string[], expectedRevision?: number) {
      if (!sources.allowed(`teams:${chatId}`, expectedRevision, [`${chatId}:${messageId}`])) return;
      if (expectedRevision !== undefined) {
        const current = db.prepare("SELECT value FROM teams_archive_messages WHERE chat_id=? AND id=?").get(chatId, messageId);
        const referenced = current ? new Set(hostedImageIds(JSON.parse(String(current.value)))) : new Set<string>();
        ids = ids.filter(id => referenced.has(id));
      }
      db.prepare(`DELETE FROM teams_archive_media WHERE chat_id=? AND message_id=? AND kind='image'${ids.length ? ` AND source NOT IN (${ids.map(() => "?").join(",")})` : ""}`).run(chatId, messageId, ...ids);
      for (const [index, id] of ids.entries()) insertMedia.run(mediaId(chatId, messageId, id), chatId, messageId, id, `截图 ${index + 1}`, "image", null, "pending");
    },
    hostedFailure(chatId: string, messageId: string, expectedRevision?: number) {
      if (!sources.allowed(`teams:${chatId}`, expectedRevision, [`${chatId}:${messageId}`])) return;
      const id = mediaId(chatId, messageId, "__discovery__");
      insertMedia.run(id, chatId, messageId, "__discovery__", "截图", "image", null, "failed");
      db.prepare("UPDATE teams_archive_media SET status='failed',attempts=3,error='截图列表读取失败，需检查权限或重新读取原消息' WHERE id=?").run(id);
    },
    mediaRows,
    messageReadable(chatId: string, id: string) {
      return knownAccess(chatId) && allowed(chatId, id);
    },
    chatLabel(chatId: string) {
      const row = db.prepare("SELECT value FROM teams_archive_chats WHERE id=?").get(chatId) as { value: string } | undefined;
      const chat = row ? JSON.parse(row.value) as ArchivedChat : undefined;
      return chat?.topic || chat?.members?.map(m => m.displayName).filter(Boolean).join("、") || "聊天记录";
    },
    message(chatId: string, id: string): ArchivedMessage | undefined {
      if (!allowed(chatId, id)) return;
      const row = db.prepare("SELECT value FROM teams_archive_messages WHERE chat_id=? AND id=?").get(chatId, id) as { value: string } | undefined;
      return row ? JSON.parse(row.value) as ArchivedMessage : undefined;
    },
    media(id: string) {
      const origin = db.prepare("SELECT chat_id,message_id FROM teams_archive_media WHERE id=?").get(id);
      if (!origin || !knownAccess(String(origin.chat_id)) || !allowed(String(origin.chat_id), String(origin.message_id))) return;
      return db.prepare("SELECT name,mime,bytes,status FROM teams_archive_media WHERE id=?").get(id) as { name: string; mime: string | null; bytes: Uint8Array | null; status: string } | undefined;
    },
    saveBytes(id: string, mime: string, bytes: Uint8Array, expectedRevision?: number) {
      const origin = db.prepare("SELECT chat_id,message_id FROM teams_archive_media WHERE id=?").get(id);
      if (!origin || !sources.allowed(`teams:${String(origin.chat_id)}`, expectedRevision, [`${String(origin.chat_id)}:${String(origin.message_id)}`])) return;
      if (bytes.length > 10 * 1024 * 1024) throw new Error("Teams 附件超过归档大小上限");
      db.prepare("UPDATE teams_archive_media SET mime=?,bytes=?,status='ready',error='',attempts=0,retry_at='' WHERE id=?").run(mime, bytes, id);
    },
    mediaFailure(id: string, error: string, expectedRevision?: number) {
      const origin = db.prepare("SELECT chat_id,message_id FROM teams_archive_media WHERE id=?").get(id);
      if (!origin || !sources.allowed(`teams:${String(origin.chat_id)}`, expectedRevision, [`${String(origin.chat_id)}:${String(origin.message_id)}`])) return;
      db.prepare("UPDATE teams_archive_media SET status='failed',error=?,attempts=attempts+1,retry_at=? WHERE id=?")
        .run(error, new Date(Date.now() + 5 * 60_000).toISOString(), id);
    },
    pendingMedia(limit: number) {
      return db.prepare(`SELECT id,chat_id,message_id,source FROM teams_archive_media m WHERE kind='image' AND status IN ('pending','failed') AND attempts<3 AND retry_at<=?
        AND NOT EXISTS (SELECT 1 FROM source_message_revocations r WHERE r.source='teams:'||m.chat_id AND r.message_id=m.chat_id||':'||m.message_id)
        AND NOT EXISTS (SELECT 1 FROM source_lifecycle s WHERE s.source='teams:'||m.chat_id AND s.revoked_at IS NOT NULL) LIMIT ?`)
        .all(new Date().toISOString(), limit) as { id: string; chat_id: string; message_id: string; source: string }[];
    },
    discoveryCursor(value?: string | null) {
      if (value !== undefined) db.prepare("INSERT INTO teams_archive_meta(key,value) VALUES ('discovery',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value ?? "");
      return (db.prepare("SELECT value FROM teams_archive_meta WHERE key='discovery'").get() as { value: string } | undefined)?.value || undefined;
    },
    nextChat(excluded: string[] = []) {
      return db.prepare(`SELECT id,cursor,complete,newest,scan_floor FROM teams_archive_chats WHERE retry_at<=? ${excluded.length ? `AND id NOT IN (${excluded.map(() => "?").join(",")})` : ""} ORDER BY complete,scanned_at,id LIMIT 1`)
        .get(new Date().toISOString(), ...excluded) as { id: string; cursor: string | null; complete: number; newest: string | null; scan_floor: string | null } | undefined;
    },
    progress(chatId: string, cursor: string | null, newest: string | null) {
      db.prepare("UPDATE teams_archive_chats SET scan_floor=CASE WHEN cursor IS NULL THEN newest ELSE scan_floor END,cursor=?,complete=CASE WHEN ? IS NULL THEN 1 ELSE complete END,newest=?,scanned_at=?,error='',retry_at='' WHERE id=?")
        .run(cursor, cursor, newest, new Date().toISOString(), chatId);
    },
    failure(chatId: string, reason: string) {
      db.prepare("UPDATE teams_archive_chats SET error=?,retry_at=?,scanned_at=? WHERE id=?")
        .run(reason, new Date(Date.now() + 5 * 60_000).toISOString(), new Date().toISOString(), chatId);
    },
    search(query: { chatId?: string; text?: string; before?: string; limit: number }) {
      const conditions: string[] = ["NOT EXISTS (SELECT 1 FROM source_message_revocations r WHERE r.source='teams:'||teams_archive_messages.chat_id AND r.message_id=teams_archive_messages.chat_id||':'||teams_archive_messages.id)",
        "NOT EXISTS (SELECT 1 FROM source_lifecycle s WHERE s.source='teams:'||teams_archive_messages.chat_id AND s.revoked_at IS NOT NULL)"], values: (string | number)[] = [];
      if (query.chatId) { conditions.push("chat_id=?"); values.push(query.chatId); }
      if (query.text) { conditions.push("(instr(lower(text),lower(?))>0 OR instr(lower(sender),lower(?))>0)"); values.push(query.text, query.text); }
      if (query.before) {
        let cursor: { at: string; id: string; chat: string };
        try { cursor = JSON.parse(Buffer.from(query.before, "base64url").toString()); } catch { throw new Error("Teams 归档分页无效"); }
        if (!cursor.at || !cursor.id || !cursor.chat) throw new Error("Teams 归档分页无效");
        conditions.push("(created_at,chat_id,id)<(?,?,?)"); values.push(cursor.at, cursor.chat, cursor.id);
      }
      const rows = db.prepare(`SELECT chat_id,id,value,created_at FROM teams_archive_messages ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY created_at DESC,chat_id DESC,id DESC LIMIT ?`)
        .all(...values, query.limit + 1) as { chat_id: string; id: string; value: string; created_at: string }[];
      const more = rows.length > query.limit, page = rows.slice(0, query.limit), last = page.at(-1);
      return { items: page.map(r => ({ chatId: r.chat_id, ...JSON.parse(r.value), archiveMedia: mediaRows(r.chat_id, r.id) })),
        nextCursor: more && last ? Buffer.from(JSON.stringify({ at: last.created_at, chat: last.chat_id, id: last.id })).toString("base64url") : null };
    },
    status() {
      const messages = db.prepare("SELECT COUNT(*) AS count FROM teams_archive_messages").get() as { count: number };
      const chats = db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(complete),0) AS complete,COALESCE(SUM(error!=''),0) AS failed FROM teams_archive_chats").get();
      const media = db.prepare("SELECT kind,status,COUNT(*) AS count FROM teams_archive_media GROUP BY kind,status").all();
      const discovery = db.prepare("SELECT value FROM teams_archive_meta WHERE key='discovery'").get() as { value: string } | undefined;
      return { messages: messages.count, chats, media, discoveryPending: !!discovery?.value, retention: "归档原文和已保存截图不按 90 天自动删除；未完成同步不能视为全部历史" };
    },
  };
}
export type TeamsArchive = ReturnType<typeof openTeamsArchive>;
