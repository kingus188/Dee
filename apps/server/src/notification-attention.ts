import type { DatabaseSync } from "node:sqlite";
import type { NotificationDeliveryReason, WebhookAttentionPreferences } from "@assistant/contracts";

const HOUR = 3600_000;

/** A first delivery attempt reserves attention, even when the network outcome is unknown.
 * Retries retain that reservation and their existing transport backoff. The caller must
 * evaluate and reserve inside the same SQLite write transaction as the outbox claim. */
export function createNotificationAttention(db: DatabaseSync, target: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS notification_attention_claims (
    target TEXT NOT NULL, event_id TEXT NOT NULL, attempted_at INTEGER NOT NULL,
    PRIMARY KEY (target, event_id));
    CREATE INDEX IF NOT EXISTS notification_attention_recent ON notification_attention_claims(target, attempted_at);`);
  function decision(id: string, policy: WebhookAttentionPreferences | undefined, at: number): { at: number; reason: NotificationDeliveryReason } {
    if (!policy?.enabled || db.prepare("SELECT 1 FROM notification_attention_claims WHERE target = ? AND event_id = ?").get(target, id)) return { at, reason: "ready" };
    const latest = db.prepare("SELECT MAX(attempted_at) AS at FROM notification_attention_claims WHERE target = ?").get(target);
    const cooldownAt = latest?.at == null ? at : Number(latest.at) + policy.cooldownSeconds * 1000;
    // Only the Nth most recent claim matters, even if a previously disabled
    // policy admitted a large backlog. The target/time index bounds this read.
    const boundary = db.prepare("SELECT attempted_at FROM notification_attention_claims WHERE target = ? AND attempted_at > ? ORDER BY attempted_at DESC LIMIT 1 OFFSET ?")
      .get(target, at - HOUR, policy.maxPerHour - 1);
    const budgetAt = boundary ? Number(boundary.attempted_at) + HOUR : at;
    if (budgetAt > at && budgetAt >= cooldownAt) return { at: budgetAt, reason: "hourly_budget" };
    return cooldownAt > at ? { at: cooldownAt, reason: "cooldown" } : { at, reason: "ready" };
  }
  function reserve(id: string, at: number) {
    db.prepare("INSERT OR IGNORE INTO notification_attention_claims(target,event_id,attempted_at) VALUES (?,?,?)").run(target, id, at);
  }
  return { decision, reserve };
}
