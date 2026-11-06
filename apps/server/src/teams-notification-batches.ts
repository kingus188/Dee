import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { NotificationPriority } from "@assistant/contracts";
import { createNotificationPreferences } from "./notification-preferences.js";
import { notificationDeliveryAt } from "./notification-policy.js";
import { createSourceLifecycle } from "./source-lifecycle.js";

export type TeamsNotice = {
  id: string; chatId: string; chatType: string; chatTopic: string | null; senderName: string;
  direction: "in" | "out"; text: string; createdAt: string; repliedAt: string | null; pushedAt: string | null;
  notificationPriority?: NotificationPriority; notificationNote?: string; notificationCancelledAt?: string;
};
export type TeamsNotificationBatch = { id: string; messageIds: string[]; sourceRevisions: { source: string; revision: number }[]; prompt: string; text: string; priority: NotificationPriority; nextAt: number };
export const teamsNoticePriority = (items: readonly Pick<TeamsNotice, "notificationPriority">[]): NotificationPriority =>
  items.some(item => item.notificationPriority === "approval") ? "approval" :
    items.some(item => item.notificationPriority === "urgent") ? "urgent" : "normal";

// Batches freeze membership and generated input before asynchronous injection. A restart,
// new arrival or unknown injection result must retry that same source set, not regroup it.
export function createTeamsNotificationBatches<T extends TeamsNotice>(db: DatabaseSync, row: (value: Record<string, unknown>) => T, normalDelay = () => 30 * 60_000) {
  db.exec(`CREATE TABLE IF NOT EXISTS teams_notification_batches (
    id TEXT PRIMARY KEY, message_ids TEXT NOT NULL, prompt TEXT NOT NULL, text TEXT NOT NULL,
    priority TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
    next_at INTEGER NOT NULL, finished_at INTEGER);
    CREATE TABLE IF NOT EXISTS teams_notification_members (message_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL);`);
  if (!(db.prepare("PRAGMA table_info(teams_notification_batches)").all() as { name: string }[]).some(column => column.name === "source_revisions")) db.exec("ALTER TABLE teams_notification_batches ADD COLUMN source_revisions TEXT");
  const sources = createSourceLifecycle(db);
  const preferences = createNotificationPreferences(db);
  const unpack = (value: Record<string, unknown>): TeamsNotificationBatch => ({ id: String(value.id), messageIds: JSON.parse(String(value.message_ids)),
    sourceRevisions: value.source_revisions ? JSON.parse(String(value.source_revisions)) : [],
    prompt: String(value.prompt), text: String(value.text), priority: value.priority as NotificationPriority, nextAt: Number(value.next_at) });
  const quietHours = () => preferences.get().quietHours;
  const candidates = `FROM visible_teams_messages m WHERE important = 1 AND direction = 'in' AND pushed_at IS NULL AND replied_at IS NULL
    AND notification_cancelled_at IS NULL AND created_at >= ? AND NOT EXISTS (SELECT 1 FROM teams_chat_access a WHERE a.chat_id=m.chat_id AND a.available=0)
    AND NOT EXISTS (SELECT 1 FROM teams_notification_members n WHERE n.message_id = m.id)`;
  const current = (batch: TeamsNotificationBatch) => batch.sourceRevisions.length > 0 && batch.sourceRevisions.every(ref => sources.allowed(ref.source, ref.revision));
  const cancel = (id: string) => { db.prepare("UPDATE teams_notification_batches SET status='cancelled',finished_at=? WHERE id=? AND status='pending'").run(Date.now(), id); };
  return {
    quietHours,
    cancelSource(id: string) { db.prepare("UPDATE teams_messages SET notification_cancelled_at = COALESCE(notification_cancelled_at, ?) WHERE id = ?").run(new Date().toISOString(), id); },
    note(id: string, text: string) { db.prepare("UPDATE teams_messages SET notification_note = ? WHERE id = ?").run(text, id); },
    create(merge: boolean, render: (items: T[]) => { prompt: string; text: string }): TeamsNotificationBatch | undefined {
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now(), cutoff = new Date(now - 86400_000).toISOString();
        const items = db.prepare("SELECT * " + candidates + " ORDER BY CASE notification_priority WHEN 'approval' THEN 0 WHEN 'urgent' THEN 1 WHEN 'normal' THEN 3 ELSE 2 END, created_at, id LIMIT ?")
          .all(cutoff, merge ? 12 : 1).map(row);
        if (!items.length) { db.exec("COMMIT"); return; }
        const priority = teamsNoticePriority([items[0]]);
        const selected = items.filter(item => teamsNoticePriority([item]) === priority);
        if (priority === "normal") {
          const latest = db.prepare("SELECT MAX(MAX(created_at, COALESCE(finished_at, 0))) AS at FROM teams_notification_batches WHERE priority = 'normal'").get();
          const pending = db.prepare("SELECT 1 FROM teams_notification_batches WHERE priority = 'normal' AND status = 'pending' LIMIT 1").get();
          if (pending || notificationDeliveryAt(quietHours(), now, priority, Math.max(Date.parse(selected[0].createdAt) + normalDelay(), merge ? Number(latest?.at ?? 0) + normalDelay() : 0)) > now) {
            db.exec("COMMIT"); return;
          }
        }
        const messageIds = selected.map(item => item.id);
        // Single-message prompts also quote older chat context. Bind the whole
        // chat revision, not just the latest primary notification message.
        const sourceRevisions = [...new Set(selected.map(item => `teams:${item.chatId}`))].map(source => ({ source, revision: sources.revision(source) }));
        const id = "teams-digest:" + createHash("sha256").update(JSON.stringify([...messageIds].sort())).digest("hex");
        const body = render(selected);
        db.prepare("INSERT INTO teams_notification_batches(id,message_ids,source_revisions,prompt,text,priority,created_at,next_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(id, JSON.stringify(messageIds), JSON.stringify(sourceRevisions), body.prompt, body.text, priority, now, now);
        for (const messageId of messageIds) db.prepare("INSERT INTO teams_notification_members(message_id,batch_id) VALUES (?,?)").run(messageId, id);
        db.exec("COMMIT");
        return { id, messageIds, sourceRevisions, ...body, priority, nextAt: now };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    ready() {
      return db.prepare("SELECT * FROM teams_notification_batches WHERE status = 'pending' AND next_at <= ? ORDER BY CASE WHEN priority = 'normal' THEN 1 ELSE 0 END, created_at LIMIT 20")
        .all(Date.now()).map(unpack).filter(batch => { if (current(batch)) return true; cancel(batch.id); return false; });
    },
    claim(id: string) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT * FROM teams_notification_batches WHERE id=?").get(id);
        if (!row || !current(unpack(row))) { cancel(id); db.exec("COMMIT"); return false; }
        const claimed = !!db.prepare("UPDATE teams_notification_batches SET next_at = ? WHERE id = ? AND status = 'pending' AND next_at <= ?")
          .run(Date.now() + 60_000, id, Date.now()).changes;
        db.exec("COMMIT"); return claimed;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    defer(id: string, at = Date.now() + 45_000) { db.prepare("UPDATE teams_notification_batches SET next_at = ? WHERE id = ? AND status = 'pending'").run(at, id); },
    finish(id: string, cancelled = false) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const changed = db.prepare("UPDATE teams_notification_batches SET status = ?, finished_at = ? WHERE id = ? AND status = 'pending'")
          .run(cancelled ? "cancelled" : "injected", Date.now(), id);
        if (changed.changes) db.prepare("UPDATE teams_messages SET pushed_at = ? WHERE id IN (SELECT message_id FROM teams_notification_members WHERE batch_id = ?)").run(new Date().toISOString(), id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
