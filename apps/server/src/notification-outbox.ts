import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NotificationConfig } from "@assistant/features";
import type { NotificationAttentionClass, NotificationDeliveryReason, NotificationPriority, NotificationRecord, NotificationStatus } from "@assistant/contracts";
import { createNotificationPreferences } from "./notification-preferences.js";
import { notificationDeliveryAt } from "./notification-policy.js";
import { createSourceLifecycle, type SourceReference } from "./source-lifecycle.js";
import { createNotificationAttention } from "./notification-attention.js";

const delays = [15000, 60000, 300000, 900000];
// Budgets apply to the complete serialized UTF-8 JSON body, not character counts.
// They do not truncate source events or promise compatibility with every receiver.
export const WEBHOOK_DIGEST_MAX_BYTES = { feishu: 16 * 1024, generic: 32 * 1024 } as const;
const DIGEST_MAX_MEMBERS = 100;

function retryAfterAt(value: string | null, now: number): number {
  if (!value) return now;
  const header = value.trim();
  const at = /^\d+$/.test(header) ? now + Number(header) * 1000
    : /^[A-Za-z]{3}(?:,| )/.test(header) ? Date.parse(header) : NaN;
  return Number.isSafeInteger(at) && at > now ? at : now;
}

export function openNotificationOutbox(dir: string, config: NotificationConfig, send: typeof fetch = fetch, now = Date.now) {
  const db = new DatabaseSync(join(dir, "agent.sqlite"));
  let preferences: ReturnType<typeof createNotificationPreferences>;
  let sources: ReturnType<typeof createSourceLifecycle>;
  let attention: ReturnType<typeof createNotificationAttention>;
  // Bind queued messages to the configured destination without persisting its credentials.
  const target = createHash("sha256").update(JSON.stringify([config.url, config.kind || "generic"])).digest("hex");
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS notification_outbox (
        target TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER,
        last_error TEXT, PRIMARY KEY(target, id));
      CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(target, status, next_at);`);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!(db.prepare("PRAGMA table_info(notification_outbox)").all() as { name: string }[]).some(column => column.name === "priority")) {
        db.exec("ALTER TABLE notification_outbox ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
        // Old generic payloads retain their structured failure/approval signal. Feishu bodies
        // contain no such metadata and cannot safely be reclassified from prose.
        db.exec(`UPDATE notification_outbox SET priority = CASE WHEN json_valid(body) THEN
          CASE WHEN json_extract(body, '$.type') = 'approval' THEN 'approval'
            WHEN json_extract(body, '$.failed') = 1 THEN 'urgent' ELSE 'normal' END ELSE 'normal' END`);
      }
      const columns = db.prepare("PRAGMA table_info(notification_outbox)").all() as { name: string }[];
      if (!columns.some(column => column.name === "digest_id")) db.exec("ALTER TABLE notification_outbox ADD COLUMN digest_id TEXT");
      if (!columns.some(column => column.name === "digest_eligible")) db.exec("ALTER TABLE notification_outbox ADD COLUMN digest_eligible INTEGER NOT NULL DEFAULT 0");
      if (!columns.some(column => column.name === "member_ids")) db.exec("ALTER TABLE notification_outbox ADD COLUMN member_ids TEXT");
      if (!columns.some(column => column.name === "sources_json")) db.exec("ALTER TABLE notification_outbox ADD COLUMN sources_json TEXT");
      if (!columns.some(column => column.name === "attention_class")) {
        db.exec("ALTER TABLE notification_outbox ADD COLUMN attention_class TEXT NOT NULL DEFAULT 'normal'");
        // Legacy Feishu/opaque payloads cannot prove whether they are a requested
        // reminder. Preserve their timing rather than infer intent from prose.
        db.exec(`UPDATE notification_outbox SET attention_class = CASE WHEN json_valid(body) THEN
          CASE WHEN json_extract(body, '$.type') IN ('reminder','schedule') THEN 'requested'
            WHEN json_extract(body, '$.msg_type') IS NOT NULL THEN 'unclassified' ELSE 'normal' END ELSE 'unclassified' END`);
        db.exec(`UPDATE notification_outbox SET attention_class = 'unclassified' WHERE member_ids IS NOT NULL AND EXISTS
          (SELECT 1 FROM notification_outbox member WHERE member.target = notification_outbox.target
            AND member.digest_id = notification_outbox.id AND member.attention_class != 'normal')`);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    preferences = createNotificationPreferences(db);
    sources = createSourceLifecycle(db);
    attention = createNotificationAttention(db, target);
  } catch (error) { db.close(); throw error; }
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  async function enqueue(event: { id: string; body: string; priority?: NotificationPriority; attentionClass?: NotificationAttentionClass; sources?: SourceReference[] }) {
    if (stopped) throw new Error("通知队列已关闭");
    let priority = event.priority ?? "normal", category = event.attentionClass ?? "normal";
    try {
      const payload = JSON.parse(event.body);
      if (payload?.failed === true) priority = "urgent";
      else if (payload?.type === "approval") priority = "approval";
      if (payload?.type === "reminder" || payload?.type === "schedule") category = "requested";
    } catch { /* Opaque provider payloads use the producer's structured metadata. */ }
    const at = now(), digest = preferences.get().webhookDigest;
    const due = priority === "normal" && digest?.enabled
      ? (Math.floor(at / (digest.windowSeconds * 1000)) + 1) * digest.windowSeconds * 1000 : at;
    db.prepare("INSERT OR IGNORE INTO notification_outbox(target, id, body, priority, next_at, created_at, digest_eligible, sources_json, attention_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(target, event.id, event.body, priority, due, at, priority === "normal" && digest?.enabled ? 1 : 0, JSON.stringify((event.sources ?? []).map(ref => ({ ...ref, revision: ref.revision ?? sources.revision(ref.source) }))), category);
  }
  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  // Copy the delivery unit's state to its immutable source members in the same transaction.
  function syncMembers(id: string) {
    db.prepare(`UPDATE notification_outbox SET (status, attempts, next_at, finished_at, last_error) =
      (SELECT status, attempts, next_at, finished_at, last_error FROM notification_outbox WHERE target = ? AND id = ?)
      WHERE target = ? AND digest_id = ?`).run(target, id, target, id);
  }
  function sourceInvalidReason(id: string): string | undefined {
    const row = db.prepare("SELECT sources_json, member_ids FROM notification_outbox WHERE target=? AND id=?").get(target, id);
    if (!row) return "Source provenance unavailable";
    try {
      if (row.member_ids) {
        const members = JSON.parse(String(row.member_ids)) as unknown;
        if (!Array.isArray(members) || !members.length || members.some(member => typeof member !== "string")) return "Source provenance unavailable";
        for (const member of members) { const reason = sourceInvalidReason(member); if (reason) return reason; }
        return;
      }
      // A short or previously deleted source may never have produced a stored
      // episode/tombstone. Missing provenance cannot prove permission to send.
      if (row.sources_json == null) return "Source provenance unavailable";
      const refs = JSON.parse(String(row.sources_json)) as SourceReference[];
      if (!Array.isArray(refs) || refs.some(ref => !ref || typeof ref.source !== "string")) return "Source provenance unavailable";
      if (!refs.every(ref => sources.allowed(ref.source, ref.revision, ref.messageIds))) return "Source revoked or changed";
      return;
    } catch { return "Source provenance unavailable"; }
  }
  const sourceAllowed = (id: string) => sourceInvalidReason(id) === undefined;
  function cancelRevoked(id: string) {
    const reason = sourceInvalidReason(id) ?? "Source revoked or changed";
    db.prepare(`UPDATE notification_outbox SET status='cancelled',finished_at=?,
      last_error = ? || CASE WHEN attempts > 0 THEN '; in-flight delivery may already have occurred' ELSE '' END
      WHERE target=? AND (id=? OR digest_id=?) AND status IN ('pending','failed')`)
      .run(now(), reason, target, id, id);
  }
  function cancelRevokedPending() {
    for (const row of db.prepare("SELECT id FROM notification_outbox WHERE target=? AND status IN ('pending','failed') AND digest_id IS NULL").all(target)) {
      if (!sourceAllowed(String(row.id))) cancelRevoked(String(row.id));
    }
  }
  function assembleDigest(at: number) {
    if (!preferences.get().webhookDigest?.enabled) return;
    transaction(() => {
      cancelRevokedPending();
      const candidates = db.prepare(`SELECT id, body, attention_class FROM notification_outbox WHERE target = ? AND status = 'pending'
        AND priority = 'normal' AND digest_eligible = 1 AND attempts = 0 AND digest_id IS NULL AND member_ids IS NULL AND next_at <= ?
        ORDER BY CASE WHEN attention_class != 'normal' THEN 0 ELSE 1 END, created_at, id LIMIT ?`).all(target, at, DIGEST_MAX_MEMBERS);
      if (!candidates.length) return;
      type Member = typeof candidates[number];
      function serialize(members: Member[]) {
        const memberIds = members.map(row => String(row.id));
        const id = "digest:" + createHash("sha256").update(JSON.stringify([target, memberIds])).digest("hex");
        const events = members.map(row => {
          try { return JSON.parse(String(row.body)) as unknown; }
          catch { return { id: String(row.id), text: String(row.body) }; }
        });
        const lines = events.map(event => {
          if (event && typeof event === "object") {
            const value = event as { text?: unknown; content?: { text?: unknown } };
            const text = value.text ?? value.content?.text;
            if (typeof text === "string") return text;
          }
          return JSON.stringify(event);
        });
        const text = `通知摘要（${members.length} 条）\n` + lines.map(line => "• " + line).join("\n");
        const body = JSON.stringify(config.kind === "feishu" ? { msg_type: "text", content: { text } }
          : { id, type: "digest", text, failed: false, at: new Date(at).toISOString(), events });
        return { id, body, memberIds };
      }
      const budget = config.kind === "feishu" ? WEBHOOK_DIGEST_MAX_BYTES.feishu : WEBHOOK_DIGEST_MAX_BYTES.generic;
      const members: Member[] = [];
      let snapshot: ReturnType<typeof serialize> | undefined;
      for (const candidate of candidates) {
        const next = serialize([...members, candidate]);
        if (Buffer.byteLength(next.body, "utf8") <= budget) {
          members.push(candidate); snapshot = next;
        } else if (members.length) {
          // Leave this and later members eligible for the next independent digest.
          break;
        } else {
          // A wrapper alone makes this event too large: send its unchanged original
          // protocol and ID instead. Persist fallback so it cannot block the queue.
          db.prepare("UPDATE notification_outbox SET digest_eligible = 0 WHERE target = ? AND id = ?")
            .run(target, String(candidate.id));
        }
      }
      if (!snapshot) return;
      const { id, body, memberIds } = snapshot;
      const category = members.some(member => member.attention_class === "requested") ? "requested"
        : members.some(member => member.attention_class === "unclassified") ? "unclassified" : "normal";
      db.prepare(`INSERT INTO notification_outbox(target,id,body,priority,next_at,created_at,member_ids,attention_class)
        VALUES (?,?,?,'normal',?,?,?,?)`).run(target, id, body, at, at, JSON.stringify(memberIds), category);
      const attach = db.prepare("UPDATE notification_outbox SET digest_id = ? WHERE target = ? AND id = ?");
      for (const memberId of memberIds) attach.run(id, target, memberId);
      syncMembers(id);
    });
  }
  async function drain() {
    if (stopped || !config.url || config.mode === "off") return;
    for (let count = 0; count < 20 && !stopped; count++) {
      transaction(cancelRevokedPending);
      const at = now();
      const quiet = notificationDeliveryAt(preferences.get().quietHours, at) > at;
      // An older deferred normal event must not block an urgent or approval event.
      // Always select urgent work before assembling or delivering normal backlog.
      const select = (urgentOnly: boolean) => db.prepare(`SELECT id, body, attempts, priority, attention_class FROM notification_outbox
        WHERE target = ? AND status = 'pending' AND digest_id IS NULL AND next_at <= ?
        AND (? = 0 OR priority IN ('urgent', 'approval'))
        AND (? = 0 OR priority != 'normal' OR digest_eligible = 0 OR attempts > 0 OR member_ids IS NOT NULL)
        ORDER BY CASE WHEN priority IN ('urgent', 'approval') THEN 0
          WHEN attention_class != 'normal' OR attempts > 0 OR EXISTS (SELECT 1 FROM notification_attention_claims c WHERE c.target = notification_outbox.target AND c.event_id = notification_outbox.id) THEN 1 ELSE 2 END,
          next_at, id LIMIT 1`).get(target, at, urgentOnly ? 1 : 0, preferences.get().webhookDigest?.enabled ? 1 : 0);
      let row = select(true);
      if (!row && !quiet) { assembleDigest(at); row = select(false); }
      if (!row) return;
      const id = String(row.id), attempts = Number(row.attempts);
      if (attempts >= 5) {
        transaction(() => {
          db.prepare("UPDATE notification_outbox SET status = 'failed', finished_at = ?, last_error = 'Delivery interrupted at attempt limit' WHERE target = ? AND id = ? AND status = 'pending' AND attempts >= 5")
            .run(now(), target, id);
          syncMembers(id);
        });
        continue;
      }
      // Reserve before I/O. A crashed attempt counts, and becomes eligible again after its lease.
      const claimed = transaction(() => {
        if (!sourceAllowed(id)) { cancelRevoked(id); return { changes: 0 }; }
        const at = now(), normal = row.priority === "normal" && row.attention_class === "normal";
        // Do not overwrite transport deadlines: disabling the policy releases
        // eligible work immediately, without shortening network retry backoff.
        if (normal && attempts === 0 && attention.decision(id, preferences.get().webhookAttention, at).at > at) return { changes: 0, deferred: true };
        const result = db.prepare("UPDATE notification_outbox SET attempts = attempts + 1, next_at = ? WHERE target = ? AND id = ? AND status = 'pending' AND attempts = ? AND next_at <= ? AND digest_id IS NULL")
          .run(now() + 30000, target, id, attempts, now());
        if (result.changes) { if (normal) attention.reserve(id, at); syncMembers(id); }
        return result;
      });
      if ("deferred" in claimed) return;
      if (!claimed.changes) continue;
      let error: string | null = null, retryable = true, retryAt = 0;
      try {
        const response = await send(config.url, {
          method: "POST", headers: { "content-type": "application/json", "x-pi-event-id": id },
          body: String(row.body), signal: AbortSignal.timeout(8000), redirect: "error",
        });
        if (!response.ok) {
          error = "HTTP " + response.status;
          retryable = response.status === 408 || response.status === 429 || response.status >= 500;
          if (retryable) retryAt = retryAfterAt(response.headers.get("retry-after"), now());
          // Releasing an unread response stream must not replace an already
          // received HTTP result with a misleading network-unknown outcome.
          await response.body?.cancel().catch(() => {});
        } else if (config.kind === "feishu") {
          const result: unknown = await response.json();
          if (!result || typeof result !== "object" || !("code" in result) || result.code !== 0) error = "Feishu rejected notification";
        } else { await response.body?.cancel().catch(() => {}); }
      } catch { error = "Network error or timeout"; }
      const status = !error ? "sent" : !retryable || attempts + 1 >= 5 ? "failed" : "pending";
      transaction(() => {
        // Revocation stops future attempts, but cannot undo an HTTP request
        // already in flight. Preserve a matching successful acknowledgement
        // even if another connection/list() cancelled this delivery meanwhile.
        if (!sourceAllowed(id)) cancelRevoked(id);
        const current = db.prepare("SELECT status, attempts, last_error FROM notification_outbox WHERE target=? AND id=?").get(target, id);
        if (current?.status === "cancelled" && Number(current.attempts) === attempts + 1) {
          const reason = String(current.last_error).startsWith("Source provenance unavailable") ? "Source provenance unavailable" : "Source revoked or changed";
          db.prepare("UPDATE notification_outbox SET status=?,finished_at=?,last_error=? WHERE target=? AND id=? AND status='cancelled' AND attempts=?")
            .run(error ? "cancelled" : "sent", now(), error
              ? `${reason}; ${error}; delivery not confirmed and may already have occurred`
              : `${reason}; delivery succeeded after cancellation`, target, id, attempts + 1);
          syncMembers(id);
          return;
        }
        db.prepare("UPDATE notification_outbox SET status = ?, next_at = ?, finished_at = ?, last_error = ? WHERE target = ? AND id = ? AND status = 'pending' AND attempts = ?")
          .run(status, Math.max(now() + (delays[attempts] ?? 0), retryAt), status === "pending" ? null : now(), error, target, id, attempts + 1);
        syncMembers(id);
      });
      if (status === "failed") console.error("Webhook 通知投递失败，已保留记录；事件 ID：", id);
    }
  }
  function flush(): Promise<void> {
    if (stopped) return Promise.resolve();
    return active ??= drain().finally(() => { active = undefined; });
  }
  function start() {
    if (timer || stopped) return;
    const tick = () => { void flush().catch(() => console.error("通知队列处理失败；记录仍保留，等待下次处理。")); };
    timer = setInterval(tick, 1000); timer.unref(); tick();
  }
  function list(status?: NotificationStatus): NotificationRecord[] {
    transaction(cancelRevokedPending);
    const fields = "SELECT id, priority, attention_class AS category, digest_eligible AS digestEligible, member_ids AS memberIdsJson, status, attempts, next_at AS nextAt, created_at AS createdAt, finished_at AS finishedAt, last_error AS lastError FROM notification_outbox WHERE target = ? AND digest_id IS NULL";
    const order = " ORDER BY created_at DESC, id LIMIT 100";
    const rows = (status ? db.prepare(fields + " AND status = ?" + order).all(target, status)
      : db.prepare(fields + order).all(target)) as unknown as (NotificationRecord & { priority: NotificationPriority; category: NotificationAttentionClass; digestEligible: number; memberIdsJson: string | null })[];
    const policy = preferences.get(), at = now();
    // Explain the effective deadline without persisting policy deferrals as failures.
    return rows.map(({ priority, category, digestEligible, memberIdsJson, ...row }) => {
      const members = memberIdsJson ? { memberIds: JSON.parse(memberIdsJson) as string[] } : {};
      if (row.status !== "pending") return { ...row, ...members };
      let nextAt = Math.max(at, row.nextAt);
      let reason: NotificationDeliveryReason = row.nextAt > at ? row.attempts > 0 ? "retry_backoff" : digestEligible ? "digest_window" : "ready" : "ready";
      if (priority === "normal" && category === "normal" && row.attempts === 0) {
        const decision = attention.decision(row.id, policy.webhookAttention, at);
        if (decision.at > nextAt) { nextAt = decision.at; reason = decision.reason; }
      }
      const quietAt = notificationDeliveryAt(policy.quietHours, nextAt, priority);
      if (quietAt > nextAt) { nextAt = quietAt; reason = "quiet_hours"; }
      return { ...row, ...members, nextAt, delivery: { priority, category, reason } };
    });
  }
  function retry(id: string): "queued" | "missing" | "conflict" | "disabled" {
    if (stopped || !config.url || config.mode === "off") return "disabled";
    return transaction(() => {
      const row = db.prepare("SELECT digest_id FROM notification_outbox WHERE target = ? AND id = ?").get(target, id);
      if (!row) return "missing";
      const deliveryId = row.digest_id ? String(row.digest_id) : id;
      if (!sourceAllowed(deliveryId)) { cancelRevoked(deliveryId); return "conflict"; }
      // Retry the entire immutable digest even when a caller supplies a member ID.
      const changed = db.prepare("UPDATE notification_outbox SET status = 'pending', attempts = 0, digest_eligible = 0, next_at = ?, finished_at = NULL, last_error = NULL WHERE target = ? AND id = ? AND status = 'failed'")
        .run(now(), target, deliveryId);
      if (!changed.changes) return "conflict";
      syncMembers(deliveryId);
      return "queued";
    });
  }

  function close() {
    return closing ??= (async () => { stopped = true; clearInterval(timer); try { await active; } finally { db.close(); } })();
  }
  return { enqueue, flush, start, list, retry, preferences, close };
}
