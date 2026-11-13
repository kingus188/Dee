import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type SelfChatRecoveryAction = "retry" | "skip";

/** Local operator control only: never sends or labels an unverified delivery as sent. */
export function openSelfChatRecovery(dir: string, accountId: string) {
  const file = join(dir, "teams-self-chat.sqlite");
  if (!existsSync(file)) throw new Error("自聊状态库不存在");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const account = db.prepare("SELECT user_id FROM account WHERE id=1").get();
    if (!accountId || account?.user_id !== accountId) throw new Error("自聊账号不匹配");
    db.exec(`CREATE TABLE IF NOT EXISTS recovery_audit (
      id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, previous_state TEXT NOT NULL,
      action TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  } catch (error) { db.close(); throw error; }
  return {
    status: () => db.prepare("SELECT source_id,state,reply_id FROM replies ORDER BY rowid DESC").all(),
    resolve: (sourceId: string, expectedState: string, action: SelfChatRecoveryAction) => {
      if (action !== "retry" && action !== "skip") throw new Error("未知恢复操作");
      // sending/processing may still be active: first stop and restart the host to classify them.
      const allowed = action === "retry" ? ["failed"] : ["failed", "unknown", "retry"];
      if (!allowed.includes(expectedState)) throw new Error("该状态不能执行此恢复操作；发送结果未知不得重试");
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = db.prepare("UPDATE replies SET state=? WHERE source_id=? AND state=?")
          .run(action === "retry" ? "retry" : "skipped", sourceId, expectedState);
        if (!result.changes) throw new Error("自聊状态已变化或消息不存在，请重新查询");
        db.prepare("INSERT INTO recovery_audit(source_id,previous_state,action,created_at) VALUES(?,?,?,?)")
          .run(sourceId, expectedState, action, Date.now());
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close: () => db.close(),
  };
}
