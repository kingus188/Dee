import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NotificationConfig } from "@assistant/features";
import type { NotificationRecord, NotificationStatus } from "@assistant/contracts";
import { createNotificationPreferences } from "./notification-preferences.js";
import { nextNotificationAt } from "./notification-quiet-hours.js";

const delays = [15000, 60000, 300000, 900000];

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
    preferences = createNotificationPreferences(db);
  } catch (error) { db.close(); throw error; }
  // Bind queued messages to the configured destination without persisting its credentials.
  const target = createHash("sha256").update(JSON.stringify([config.url, config.kind || "generic"])).digest("hex");
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  async function enqueue(event: { id: string; body: string }) {
    if (stopped) throw new Error("通知队列已关闭");
    db.prepare("INSERT OR IGNORE INTO notification_outbox(target, id, body, next_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(target, event.id, event.body, now(), now());
  }
  async function drain() {
    if (stopped || !config.url || config.mode === "off") return;
    for (let count = 0; count < 20 && !stopped; count++) {
      const at = now();
      if (nextNotificationAt(preferences.get().quietHours, at) > at) return;
      const row = db.prepare("SELECT id, body, attempts FROM notification_outbox WHERE target = ? AND status = 'pending' AND next_at <= ? ORDER BY next_at, id LIMIT 1").get(target, now());
      if (!row) return;
      const id = String(row.id), attempts = Number(row.attempts);
      if (attempts >= 5) {
        db.prepare("UPDATE notification_outbox SET status = 'failed', finished_at = ?, last_error = 'Delivery interrupted at attempt limit' WHERE target = ? AND id = ? AND status = 'pending' AND attempts >= 5")
          .run(now(), target, id);
        continue;
      }
      // Reserve before I/O. A crashed attempt counts, and becomes eligible again after its lease.
      const claimed = db.prepare("UPDATE notification_outbox SET attempts = attempts + 1, next_at = ? WHERE target = ? AND id = ? AND status = 'pending' AND attempts = ? AND next_at <= ?")
        .run(now() + 30000, target, id, attempts, now());
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
      db.prepare("UPDATE notification_outbox SET status = ?, next_at = ?, finished_at = ?, last_error = ? WHERE target = ? AND id = ? AND status = 'pending' AND attempts = ?")
        .run(status, Math.max(now() + (delays[attempts] ?? 0), retryAt), status === "pending" ? null : now(), error, target, id, attempts + 1);
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
    const fields = "SELECT id, status, attempts, next_at AS nextAt, created_at AS createdAt, finished_at AS finishedAt, last_error AS lastError FROM notification_outbox WHERE target = ?";
    const order = " ORDER BY created_at DESC, id LIMIT 100";
    const rows = (status ? db.prepare(fields + " AND status = ?" + order).all(target, status)
      : db.prepare(fields + order).all(target)) as unknown as NotificationRecord[];
    const quiet = preferences.get().quietHours;
    // Keep the retry deadline intact so disabling quiet hours releases eligible rows immediately.
    return rows.map(row => row.status === "pending" && quiet.enabled
      ? { ...row, nextAt: nextNotificationAt(quiet, Math.max(now(), row.nextAt)) } : row);
  }
  function retry(id: string): "queued" | "missing" | "conflict" | "disabled" {
    if (stopped || !config.url || config.mode === "off") return "disabled";
    // Only failed rows are eligible; concurrent clicks cannot reset a pending delivery.
    const changed = db.prepare("UPDATE notification_outbox SET status = 'pending', attempts = 0, next_at = ?, finished_at = NULL, last_error = NULL WHERE target = ? AND id = ? AND status = 'failed'")
      .run(now(), target, id);
    if (changed.changes) return "queued";
    return db.prepare("SELECT 1 FROM notification_outbox WHERE target = ? AND id = ?").get(target, id) ? "conflict" : "missing";
  }
  function close() {
    return closing ??= (async () => { stopped = true; clearInterval(timer); try { await active; } finally { db.close(); } })();
  }
  return { enqueue, flush, start, list, retry, preferences, close };
}
