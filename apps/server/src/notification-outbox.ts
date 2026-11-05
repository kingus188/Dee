import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NotificationConfig } from "@assistant/features";
import type { NotificationPriority, NotificationRecord, NotificationStatus } from "@assistant/contracts";
import { createNotificationPreferences } from "./notification-preferences.js";
import { notificationDeliveryAt } from "./notification-policy.js";

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
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    preferences = createNotificationPreferences(db);
  } catch (error) { db.close(); throw error; }
  // Bind queued messages to the configured destination without persisting its credentials.
  const target = createHash("sha256").update(JSON.stringify([config.url, config.kind || "generic"])).digest("hex");
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  async function enqueue(event: { id: string; body: string; priority?: NotificationPriority }) {
    if (stopped) throw new Error("通知队列已关闭");
    let priority = event.priority;
    if (!priority) {
      try {
        const payload = JSON.parse(event.body);
        priority = payload?.type === "approval" ? "approval" : payload?.failed === true ? "urgent" : "normal";
      } catch { priority = "normal"; }
    }
    const at = now(), digest = preferences.get().webhookDigest;
    const due = priority === "normal" && digest?.enabled
      ? (Math.floor(at / (digest.windowSeconds * 1000)) + 1) * digest.windowSeconds * 1000 : at;
    db.prepare("INSERT OR IGNORE INTO notification_outbox(target, id, body, priority, next_at, created_at, digest_eligible) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(target, event.id, event.body, priority, due, at, priority === "normal" && digest?.enabled ? 1 : 0);
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
  function assembleDigest(at: number) {
    if (!preferences.get().webhookDigest?.enabled) return;
    transaction(() => {
      const candidates = db.prepare(`SELECT id, body FROM notification_outbox WHERE target = ? AND status = 'pending'
        AND priority = 'normal' AND digest_eligible = 1 AND attempts = 0 AND digest_id IS NULL AND member_ids IS NULL AND next_at <= ?
        ORDER BY created_at, id LIMIT ?`).all(target, at, DIGEST_MAX_MEMBERS);
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
      db.prepare(`INSERT INTO notification_outbox(target,id,body,priority,next_at,created_at,member_ids)
        VALUES (?,?,?,'normal',?,?,?)`).run(target, id, body, at, at, JSON.stringify(memberIds));
      const attach = db.prepare("UPDATE notification_outbox SET digest_id = ? WHERE target = ? AND id = ?");
      for (const memberId of memberIds) attach.run(id, target, memberId);
      syncMembers(id);
    });
  }
  async function drain() {
    if (stopped || !config.url || config.mode === "off") return;
    for (let count = 0; count < 20 && !stopped; count++) {
      const at = now();
      const quiet = notificationDeliveryAt(preferences.get().quietHours, at) > at;
      // An older deferred normal event must not block an urgent or approval event.
      // Always select urgent work before assembling or delivering normal backlog.
      const select = (urgentOnly: boolean) => db.prepare("SELECT id, body, attempts FROM notification_outbox WHERE target = ? AND status = 'pending' AND digest_id IS NULL AND next_at <= ? AND (? = 0 OR priority IN ('urgent', 'approval')) AND (? = 0 OR priority != 'normal' OR digest_eligible = 0 OR attempts > 0 OR member_ids IS NOT NULL) ORDER BY CASE WHEN priority IN ('urgent', 'approval') THEN 0 ELSE 1 END, next_at, id LIMIT 1").get(target, at, urgentOnly ? 1 : 0, preferences.get().webhookDigest?.enabled ? 1 : 0);
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
        const result = db.prepare("UPDATE notification_outbox SET attempts = attempts + 1, next_at = ? WHERE target = ? AND id = ? AND status = 'pending' AND attempts = ? AND next_at <= ? AND digest_id IS NULL")
          .run(now() + 30000, target, id, attempts, now());
        if (result.changes) syncMembers(id);
        return result;
      });
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
          await response.body?.cancel();
        } else if (config.kind === "feishu") {
          const result: unknown = await response.json();
          if (!result || typeof result !== "object" || !("code" in result) || result.code !== 0) error = "Feishu rejected notification";
        } else { await response.body?.cancel(); }
      } catch { error = "Network error or timeout"; }
      const status = !error ? "sent" : !retryable || attempts + 1 >= 5 ? "failed" : "pending";
      transaction(() => {
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
    const fields = "SELECT id, priority, member_ids AS memberIdsJson, status, attempts, next_at AS nextAt, created_at AS createdAt, finished_at AS finishedAt, last_error AS lastError FROM notification_outbox WHERE target = ? AND digest_id IS NULL";
    const order = " ORDER BY created_at DESC, id LIMIT 100";
    const rows = (status ? db.prepare(fields + " AND status = ?" + order).all(target, status)
      : db.prepare(fields + order).all(target)) as unknown as (NotificationRecord & { priority: NotificationPriority; memberIdsJson: string | null })[];
    const quiet = preferences.get().quietHours;
    // Keep the retry deadline intact so disabling quiet hours releases eligible rows immediately.
    return rows.map(({ priority, memberIdsJson, ...row }) => ({
      ...row, ...(memberIdsJson ? { memberIds: JSON.parse(memberIdsJson) as string[] } : {}),
      ...(row.status === "pending" && quiet.enabled
        ? { nextAt: notificationDeliveryAt(quiet, Math.max(now(), row.nextAt), priority) } : {}),
    }));
  }
  function retry(id: string): "queued" | "missing" | "conflict" | "disabled" {
    if (stopped || !config.url || config.mode === "off") return "disabled";
    return transaction(() => {
      const row = db.prepare("SELECT digest_id FROM notification_outbox WHERE target = ? AND id = ?").get(target, id);
      if (!row) return "missing";
      const deliveryId = row.digest_id ? String(row.digest_id) : id;
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
