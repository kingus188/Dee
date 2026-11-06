import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MailNotices, MailMessage } from "@assistant/contracts";
import { notificationDeliveryAt } from "./notification-policy.js";
import type { createNotificationPreferences } from "./notification-preferences.js";

const LEASE_MS = 45_000;
// Activation belongs to the account, never to a browser/process UUID. Once
// enabled, unassigned mail survives every client restart. Transitions use a write lock.
export function createMailDelivery(db: DatabaseSync, preferences: ReturnType<typeof createNotificationPreferences>) {
  db.exec(`CREATE TABLE IF NOT EXISTS outlook_delivery_activation (id INTEGER PRIMARY KEY CHECK(id = 1), baseline INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outlook_delivery_clients (id TEXT PRIMARY KEY, baseline INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outlook_deliveries (id TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT NOT NULL,
      lease_until INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS outlook_delivery_members (sequence INTEGER PRIMARY KEY, delivery_id TEXT NOT NULL);`);
  const latest = () => Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'outlook_notices'").get()?.seq ?? 0);
  const empty = (): MailNotices => ({ latest: latest(), items: [], total: 0, urgent: false });
  const active = `FROM outlook_notices n JOIN outlook_messages m ON m.id = n.message_id
    WHERE n.cancelled_at IS NULL AND json_extract(m.value, '$.isRead') = 0`;
  function snapshot(id: string): MailNotices {
    const where = active + " AND n.sequence IN (SELECT sequence FROM outlook_delivery_members WHERE delivery_id = ?)";
    const summary = db.prepare("SELECT COUNT(*) AS total, MAX(CASE WHEN json_extract(m.value, '$.importance') = 'high' THEN 1 ELSE 0 END) AS urgent " + where).get(id)!;
    const items = db.prepare("SELECT n.sequence, m.value " + where + " ORDER BY CASE WHEN json_extract(m.value, '$.importance') = 'high' THEN 1 ELSE 0 END DESC, n.sequence DESC LIMIT 50").all(id)
      .map(row => { const { text: _, ...message } = JSON.parse(String(row.value)) as MailMessage & { text: string }; return { sequence: Number(row.sequence), message }; })
      .sort((a, b) => a.sequence - b.sequence);
    const cursor = Number(db.prepare("SELECT MAX(sequence) AS cursor FROM outlook_delivery_members WHERE delivery_id = ?").get(id)?.cursor ?? 0);
    return { latest: latest(), items, total: Number(summary.total), urgent: summary.urgent === 1, cursor };
  }
  function transaction<T>(job: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = job(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function claim(clientId: string): MailNotices {
    return transaction(() => {
      // Migrate the oldest existing client baseline before considering latest:
      // even mail not yet assigned to a digest remains owed to the account.
      // With no prior client, only the first activation skips historical notices.
      db.prepare(`INSERT OR IGNORE INTO outlook_delivery_activation(id, baseline)
        SELECT 1, COALESCE(MIN(baseline), ?) FROM outlook_delivery_clients`).run(latest());
      const now = Date.now();
      // Re-read live membership every time, including retry: handled mail cannot revive.
      const queued = db.prepare("SELECT * FROM outlook_deliveries WHERE done = 0 ORDER BY rowid").all();
      for (const batch of queued) {
        const result = snapshot(String(batch.id));
        if (!result.total) { db.prepare("UPDATE outlook_deliveries SET done = 1 WHERE id = ?").run(String(batch.id)); continue; }
        const immediate = db.prepare("SELECT MAX(CASE WHEN json_extract(m.value, '$.importance') = 'high' OR json_extract(m.value, '$.importance') IS NULL THEN 1 ELSE 0 END) AS immediate " + active +
          " AND n.sequence IN (SELECT sequence FROM outlook_delivery_members WHERE delivery_id = ?)").get(String(batch.id))!.immediate === 1;
        if (notificationDeliveryAt(preferences.get().quietHours, now, immediate ? "urgent" : "normal", now) > now) continue;
        if (batch.owner !== clientId && Number(batch.lease_until) > now) continue;
        const token = batch.owner === clientId && Number(batch.lease_until) > now ? String(batch.token) : randomUUID();
        // Retries do not extend a live lease: lost responses must not keep a
        // broken client holding the digest forever.
        const leaseUntil = batch.owner === clientId && Number(batch.lease_until) > now ? Number(batch.lease_until) : now + LEASE_MS;
        db.prepare("UPDATE outlook_deliveries SET owner = ?, token = ?, lease_until = ? WHERE id = ?").run(clientId, token, leaseUntil, String(batch.id));
        return { ...result, delivery: { id: String(batch.id), token, leaseUntil } };
      }
      const baseline = Number(db.prepare("SELECT baseline FROM outlook_delivery_activation WHERE id = 1").get()!.baseline);
      const eligible = active + " AND n.sequence > ? AND NOT EXISTS (SELECT 1 FROM outlook_delivery_members d WHERE d.sequence = n.sequence)";
      const pending = db.prepare(`SELECT COUNT(*) AS total, MIN(n.created_at) AS first,
        MAX(CASE WHEN json_extract(m.value, '$.importance') = 'high' OR json_extract(m.value, '$.importance') IS NULL THEN 1 ELSE 0 END) AS immediate ` + eligible).get(baseline)!;
      if (!pending.total || notificationDeliveryAt(preferences.get().quietHours, now, pending.immediate === 1 ? "urgent" : "normal", Date.parse(String(pending.first)) + 60_000) > now) return empty();
      const id = randomUUID(), token = randomUUID(), leaseUntil = now + LEASE_MS;
      db.prepare("INSERT INTO outlook_deliveries(id, owner, token, lease_until) VALUES (?, ?, ?, ?)").run(id, clientId, token, leaseUntil);
      db.prepare("INSERT INTO outlook_delivery_members(sequence, delivery_id) SELECT n.sequence, ? " + eligible).run(id, baseline);
      return { ...snapshot(id), delivery: { id, token, leaseUntil } };
    });
  }
  function acknowledge(clientId: string, id: string, token: string) {
    return transaction(() => {
      // A stale owner cannot acknowledge a newer lease. The last successful token
      // remains stored so a lost ack response is safely retried, even after expiry.
      const row = db.prepare("SELECT owner, token FROM outlook_deliveries WHERE id = ?").get(id);
      if (!row || row.owner !== clientId || row.token !== token) return { acknowledged: false };
      db.prepare("UPDATE outlook_deliveries SET done = 1 WHERE id = ?").run(id);
      return { acknowledged: true };
    });
  }
  return { claim, acknowledge };
}
