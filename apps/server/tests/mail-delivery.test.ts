import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createNotificationPreferences } from "../dist/notification-preferences.js";
import { Worker } from "node:worker_threads";
import { openMailStore, type MailRecord } from "../dist/mail-store.js";

const start = Date.parse("2026-11-05T12:00:00Z");
const mail = (id: string, importance: MailRecord["importance"] = "high"): MailRecord => ({ id, subject: id, sender: "A", address: "a@example.test", receivedAt: new Date().toISOString(), preview: "", text: "", isRead: false, hasAttachments: false, importance });
async function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const dir = await mkdtemp(join(tmpdir(), "mail-delivery-"));
  let store = openMailStore(dir);
  store.page([], [], "baseline", true);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, get store() { return store; }, restart() { store.close(); store = openMailStore(dir); }, at(n: number) { t.mock.timers.setTime(start + n); } };
}

test("two database connections contend for one persistent digest; ack and response retries are idempotent", async t => {
  const f = await fixture(t), other = openMailStore(f.dir);
  t.after(() => other.close());
  f.store.claimDelivery("web"); other.claimDelivery("desktop");
  f.store.page([mail("a"), mail("b")], [], "delta", true);
  const batch = f.store.claimDelivery("web"), lease = batch.delivery!;
  assert.equal(batch.total, 2);
  assert.equal(other.claimDelivery("desktop").delivery, undefined);
  assert.deepEqual(f.store.claimDelivery("web").delivery, lease);
  assert.deepEqual(f.store.acknowledgeDelivery("web", lease.id, lease.token), { acknowledged: true });
  assert.deepEqual(f.store.acknowledgeDelivery("web", lease.id, lease.token), { acknowledged: true });
  assert.equal(other.claimDelivery("desktop").items.length, 0);
  f.restart();
  assert.equal(f.store.claimDelivery("web").items.length, 0);
});

test("lost claim response and dead client recover across server restart; stale lease cannot consume takeover", async t => {
  const f = await fixture(t);
  f.store.claimDelivery("web"); f.store.claimDelivery("desktop");
  f.store.page([mail("a")], [], "delta", true);
  const lost = f.store.claimDelivery("web").delivery!;
  f.restart(); f.at(30_000);
  assert.equal(f.store.claimDelivery("web").delivery!.leaseUntil, lost.leaseUntil, "retry must not renew a lost-response lease");
  f.at(44_999);
  assert.equal(f.store.claimDelivery("desktop").delivery, undefined);
  f.at(45_000);
  const takeover = f.store.claimDelivery("desktop").delivery!;
  assert.equal(takeover.id, lost.id); assert.notEqual(takeover.token, lost.token);
  assert.equal(f.store.acknowledgeDelivery("web", lost.id, lost.token).acknowledged, false);
  assert.equal(f.store.acknowledgeDelivery("desktop", takeover.id, takeover.token).acknowledged, true);
});

test("first account activation skips history and new clients cannot overwrite an outstanding digest", async t => {
  const f = await fixture(t);
  f.store.page([mail("history")], [], "delta", true);
  assert.equal(f.store.claimDelivery("web").items.length, 0);
  f.store.page([mail("pending")], [], "delta", true);
  const pending = f.store.claimDelivery("web").delivery!;
  assert.equal(f.store.claimDelivery("new-desktop").items.length, 0);
  f.at(45_000);
  const next = f.store.claimDelivery("new-desktop");
  assert.equal(next.delivery!.id, pending.id);
  assert.deepEqual(next.items.map(i => i.message.id), ["pending"]);
});

test("every new client inherits unassigned mail owed to the activated account", async t => {
  const f = await fixture(t);
  f.store.claimDelivery("old");
  f.store.page([mail("old-owed")], [], "delta", true);
  f.restart();
  const inherited = f.store.claimDelivery("brand-new-uuid");
  assert.deepEqual(inherited.items.map(i => i.message.id), ["old-owed"]);
  assert.equal(f.store.claimDelivery("another-new-uuid").delivery, undefined);
});

test("all clients restarting during the 60 second window preserve unassigned normal mail", async t => {
  const f = await fixture(t);
  f.store.claimDelivery("web-old"); f.store.claimDelivery("desktop-old");
  f.store.page([mail("waiting", "normal")], [], "delta", true);
  f.at(20_000); assert.equal(f.store.claimDelivery("web-old").delivery, undefined);
  f.restart();
  f.at(30_000); assert.equal(f.store.claimDelivery("web-new").delivery, undefined);
  f.at(60_000);
  const batch = f.store.claimDelivery("desktop-new");
  assert.deepEqual(batch.items.map(i => i.message.id), ["waiting"]);
  assert.equal(f.store.claimDelivery("web-new").delivery, undefined);
});

test("quiet-hours backlog survives all clients and server restarting before digest assignment", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.dir, "agent.sqlite"));
  try { createNotificationPreferences(db).save({ quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" } }); }
  finally { db.close(); }
  f.store.claimDelivery("old");
  f.store.page([mail("quiet-wait", "normal"), mail("handled", "normal")], [], "delta", true);
  f.at(60_000); assert.equal(f.store.claimDelivery("old").delivery, undefined);
  f.store.page([{ ...mail("handled", "normal"), isRead: true }], [], "delta", true);
  f.restart();
  assert.equal(f.store.claimDelivery("new-tab").delivery, undefined);
  f.at(3_600_000);
  assert.deepEqual(f.store.claimDelivery("new-desktop").items.map(i => i.message.id), ["quiet-wait"]);
});

test("legacy client migration uses minimum baseline and preserves unassigned backlog", async t => {
  const f = await fixture(t);
  f.store.page([mail("history"), mail("owed"), mail("later")], [], "delta", true);
  const db = new DatabaseSync(join(f.dir, "agent.sqlite"));
  try {
    db.exec("DROP TABLE outlook_delivery_activation; INSERT INTO outlook_delivery_clients(id, baseline) VALUES ('older', 1), ('newer', 2)");
  } finally { db.close(); }
  f.restart();
  const batch = f.store.claimDelivery("new-install");
  assert.deepEqual(batch.items.map(i => i.message.id), ["owed", "later"]);
  const lease = batch.delivery!;
  f.store.acknowledgeDelivery("new-install", lease.id, lease.token);
  f.restart();
  assert.equal(f.store.claimDelivery("another-install").delivery, undefined);
});

test("read/removed items are rechecked before retry or takeover and never resurrected", async t => {
  const f = await fixture(t); f.store.claimDelivery("web");
  f.store.page([mail("read"), mail("removed"), mail("keep")], [], "delta", true);
  const lease = f.store.claimDelivery("web").delivery!;
  f.store.page([{ ...mail("read"), isRead: true }], ["removed"], "delta", true);
  f.restart(); f.store.page([mail("read"), mail("removed")], [], "delta", true);
  const retry = f.store.claimDelivery("web");
  assert.equal(retry.delivery!.id, lease.id);
  assert.deepEqual(retry.items.map(i => i.message.id), ["keep"]);
  f.store.page([{ ...mail("keep"), isRead: true }], [], "delta", true);
  f.at(45_000);
  assert.equal(f.store.claimDelivery("healthy").delivery, undefined);
});

test("new urgent mail bypasses a different client's hung normal delivery; summary membership exceeds preview", async t => {
  const f = await fixture(t); f.store.claimDelivery("web"); f.store.claimDelivery("desktop");
  f.store.page(Array.from({ length: 120 }, (_, n) => mail(`n-${n}`, "normal")), [], "delta", true);
  assert.equal(f.store.claimDelivery("web").items.length, 0);
  f.at(60_000);
  const normal = f.store.claimDelivery("web");
  assert.equal(normal.total, 120); assert.equal(normal.items.length, 50); assert.equal(normal.cursor, 120);
  f.store.page([mail("urgent")], [], "delta", true);
  const urgent = f.store.claimDelivery("desktop");
  assert.equal(urgent.urgent, true); assert.equal(urgent.total, 1);
  assert.notEqual(urgent.delivery!.id, normal.delivery!.id);
});

test("account reset invalidates leases while preserving sequence highwater", async t => {
  const f = await fixture(t); f.store.claimDelivery("web"); f.store.page([mail("a")], [], "delta", true);
  const lease = f.store.claimDelivery("web").delivery!;
  f.store.reset();
  assert.equal(f.store.acknowledgeDelivery("web", lease.id, lease.token).acknowledged, false);
  f.store.page([], [], "new-account-baseline", true);
  f.store.page([mail("new-account-history")], [], "new-account-delta", true);
  assert.equal(f.store.claimDelivery("new-account-client").items.length, 0, "reset clears activation so the new account skips pre-activation history");
  f.store.page([mail("new-account-fresh")], [], "new-account-delta", true);
  assert.deepEqual(f.store.claimDelivery("another-client").items.map(i => i.message.id), ["new-account-fresh"]);
});


test("simultaneous independent workers receive only one lease", async t => {
  const f = await fixture(t);
  f.store.claimDelivery("web"); f.store.claimDelivery("desktop");
  f.store.page([mail("concurrent")], [], "delta", true);
  const moduleUrl = new URL("../dist/mail-store.js", import.meta.url).href;
  const work = (clientId: string) => new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.moduleUrl).then(({openMailStore}) => {
        const store = openMailStore(workerData.dir);
        parentPort.postMessage('ready');
        parentPort.once('message', () => {
          try { parentPort.postMessage(store.claimDelivery(workerData.clientId)); }
          finally { store.close(); }
        });
      });`, { eval: true, workerData: { dir: f.dir, clientId, moduleUrl } });
    worker.on("error", reject);
    worker.on("message", value => {
      if (value === "ready") { ready.push(worker); if (ready.length === 2) ready.forEach(w => w.postMessage("go")); }
      else resolve(value);
    });
  });
  const ready: Worker[] = [];
  const responses = await Promise.all([work("new-web-uuid"), work("new-desktop-uuid")]) as { delivery?: unknown }[];
  assert.equal(responses.filter(r => r.delivery).length, 1);
});

test("mail arriving while every client is offline is delivered to a fresh UUID without any prior observation", async t => {
  const f = await fixture(t);
  f.store.claimDelivery("last-client-before-offline");
  // No client claim follows ingestion: only the background server sync sees mail.
  f.restart();
  f.at(10_000);
  f.store.page([mail("arrived-offline", "normal")], [], "background-sync", true);
  f.restart();
  f.at(70_000);
  const recovered = f.store.claimDelivery("fresh-install-after-offline");
  assert.deepEqual(recovered.items.map(item => item.message.id), ["arrived-offline"]);
  const lease = recovered.delivery!;
  f.store.acknowledgeDelivery("fresh-install-after-offline", lease.id, lease.token);
  assert.equal(f.store.claimDelivery("another-fresh-install").delivery, undefined);
});
