import type { DatabaseSync } from "node:sqlite";
import type { TeamsConversationReplyResult } from "@assistant/contracts";
import { HttpError } from "./errors.js";

/** Keep request fingerprints, not a second copy of private message text. */
export function createTeamsDirectReplies(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS teams_direct_replies (
    request_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    state TEXT NOT NULL, error TEXT);
    UPDATE teams_direct_replies SET state='unknown' WHERE state='sending'`);
  function find(requestId: string, chatId: string, fingerprint: string): TeamsConversationReplyResult | undefined {
    const row = db.prepare("SELECT * FROM teams_direct_replies WHERE request_id=?").get(requestId);
    if (!row) return;
    if (row.chat_id !== chatId || row.fingerprint !== fingerprint) throw new HttpError(409, "发送请求编号已用于另一份回复，请重新编辑后发送");
    return { requestId, chatId, state: row.state as TeamsConversationReplyResult["state"], ...(row.error ? { error: String(row.error) } : {}) };
  }
  return {
    find,
    claim(requestId: string, chatId: string, fingerprint: string) {
      return Number(db.prepare("INSERT OR IGNORE INTO teams_direct_replies(request_id,chat_id,fingerprint,state) VALUES (?,?,?,'sending')")
        .run(requestId, chatId, fingerprint).changes) === 1;
    },
    finish(requestId: string, state: "sent" | "rejected" | "unknown", error?: string) {
      db.prepare("UPDATE teams_direct_replies SET state=?,error=? WHERE request_id=? AND state='sending'").run(state, error ?? null, requestId);
    },
  };
}
