import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { showMailNotification, startMailNotifications } from "../dist/mail-notifications.js";

class TestNotification extends EventEmitter {
  shown = 0;
  closed = 0;
  show() { this.shown++; this.emit("show"); }
  close() { this.closed++; this.emit("close"); }
}

test("desktop mail notifications close after five seconds with independent lifetimes", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = new TestNotification(), second = new TestNotification();
  showMailNotification(first);
  assert.equal(first.shown, 1);
  t.mock.timers.tick(2000);
  showMailNotification(second);
  t.mock.timers.tick(2999);
  assert.equal(first.closed, 0); assert.equal(second.closed, 0);
  t.mock.timers.tick(1);
  assert.equal(first.closed, 1); assert.equal(second.closed, 0);
  t.mock.timers.tick(2000);
  assert.equal(second.closed, 1);
});

test("manually dismissed desktop mail notifications cancel their auto-close timer", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notification = new TestNotification();
  showMailNotification(notification);
  t.mock.timers.tick(2000);
  notification.close();
  t.mock.timers.tick(5000);
  assert.equal(notification.closed, 1);
});


function batch(latest: number, sequences: number[] = [], extra: object = {}) {
  return { latest, items: sequences.map(sequence => ({ sequence, message: { sender: "Sender", subject: `Subject ${sequence}` } })),
    ...(sequences.length ? { delivery: { id: `digest-${latest}`, token: `token-${latest}`, leaseUntil: Date.now() + 60_000 } } : {}), ...extra };
}
function response(value: unknown) { return new Response(JSON.stringify(value)); }
const flush = () => setImmediate();

test("desktop claims shared delivery, authenticates, acknowledges and preserves summary fields", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const requests: { path: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  const sent: string[] = []; let claims = 0;
  const stop = startMailNotifications("https://assistant.example", "Basic abc", (title, body) => { sent.push(`${title}|${body}`); }, async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: JSON.parse(String(init?.body)), init: init! });
    if (path.endsWith("/ack")) return response({ acknowledged: true });
    claims++;
    return response(claims === 2 ? batch(110, [60], { total: 100, cursor: 110, urgent: true }) : batch(10));
  });
  t.after(stop);
  await flush(); t.mock.timers.tick(15000); await flush();
  t.mock.timers.tick(15000); await flush();
  assert.deepEqual(sent, ["Outlook · 100 封新邮件（含重要邮件）|Sender：Subject 60"]);
  assert.deepEqual(requests.map(r => r.path), ["/api/mail/delivery", "/api/mail/delivery", "/api/mail/delivery/ack", "/api/mail/delivery"]);
  assert.equal(new Set(requests.map(r => r.body.clientId)).size, 1);
  assert.equal(requests[2]!.body.id, "digest-110");
  for (const request of requests) {
    assert.equal(request.init.method, "POST"); assert.equal(request.init.redirect, "error");
    assert.equal(new Headers(request.init.headers).get("Authorization"), "Basic abc");
  }
  stop(); t.mock.timers.tick(15000); await flush(); assert.equal(requests.length, 4);
});

test("first claim may inherit a pending digest without dropping it as history", async t => {
  const sent: string[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, title => { sent.push(title); }, async url =>
    response(new URL(String(url)).pathname.endsWith("/ack") ? { acknowledged: true } : batch(1, [1])));
  t.after(stop); await flush(); assert.deepEqual(sent, ["Outlook 新邮件"]);
});

test("lost ack retries idempotently and a reclaimed token never repeats a local toast", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let claims = 0, acks = 0; const sent: string[] = [], tokens: string[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, title => { sent.push(title); }, async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/ack")) {
      tokens.push(JSON.parse(String(init?.body)).token); acks++;
      if (acks === 1) throw new Error("ack response lost");
      return response({ acknowledged: acks !== 2 });
    }
    claims++; return response(batch(1, [1], { delivery: { id: "same", token: `token-${claims}`, leaseUntil: Date.now() + 60000 } }));
  });
  t.after(stop); await flush(); t.mock.timers.tick(15000); await flush();
  assert.equal(sent.length, 1); assert.deepEqual(tokens, ["token-1", "token-1", "token-2"]);
});

test("failed presentation is not acknowledged and can be retried", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let shown = 0, acks = 0;
  const stop = startMailNotifications("https://assistant.example", undefined, () => { if (++shown === 1) throw new Error("show failed"); }, async url => {
    if (new URL(String(url)).pathname.endsWith("/ack")) { acks++; return response({ acknowledged: true }); }
    return response(batch(1, [1]));
  });
  t.after(stop); await flush(); assert.equal(acks, 0);
  t.mock.timers.tick(15000); await flush(); assert.equal(shown, 2); assert.equal(acks, 1);
});

test("expired leases never show or acknowledge", async t => {
  let calls = 0, shown = 0;
  const stop = startMailNotifications("https://assistant.example", undefined, () => { shown++; }, async () => {
    calls++; return response(batch(1, [1], { delivery: { id: "expired", token: "old", leaseUntil: Date.now() - 1 } }));
  });
  t.after(stop); await flush(); assert.equal(shown, 0); assert.equal(calls, 1);
});

test("hung fetch times out, aborts and retries without applying its late response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const signals: AbortSignal[] = [], statuses: unknown[] = [], sent: string[] = [];
  let finishOld!: (response: Response) => void;
  const stop = startMailNotifications("https://assistant.example", undefined, title => { sent.push(title); }, (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/ack")) return Promise.resolve(response({ acknowledged: true }));
    signals.push(init!.signal!);
    if (signals.length === 1) return new Promise<Response>(resolve => { finishOld = resolve; });
    return Promise.resolve(response(batch(11, [11])));
  }, status => statuses.push(status));
  t.after(stop); await flush();
  t.mock.timers.tick(9999); await flush(); assert.equal(signals[0]!.aborted, false);
  t.mock.timers.tick(1); await flush(); assert.equal(signals[0]!.aborted, true);
  assert.deepEqual(statuses, [{ state: "retrying", reason: "timeout" }]);
  t.mock.timers.tick(5000); await flush(); assert.equal(signals.length, 2);
  finishOld(response(batch(999, [999]))); await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(statuses, [{ state: "retrying", reason: "timeout" }, { state: "connected" }]);
});

test("response JSON timeout suppresses late results and recovers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, finishBody!: (value: unknown) => void;
  const statuses: unknown[] = [], sent: string[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, title => { sent.push(title); }, async url => {
    if (new URL(String(url)).pathname.endsWith("/ack")) return response({ acknowledged: true });
    if (++calls === 1) return { ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) } as Response;
    return response(batch(11, [11]));
  }, status => statuses.push(status));
  t.after(stop); await flush(); t.mock.timers.tick(10000); await flush();
  t.mock.timers.tick(5000); await flush(); finishBody(batch(999, [999])); await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(statuses, [{ state: "retrying", reason: "timeout" }, { state: "connected" }]);
});

test("ack JSON timeout uses the same total ten-second deadline and retries without showing again", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let acks = 0, shown = 0, finishBody!: (value: unknown) => void;
  const signals: AbortSignal[] = [], statuses: unknown[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, () => { shown++; }, async (url, init) => {
    signals.push(init!.signal!);
    if (new URL(String(url)).pathname.endsWith("/ack")) {
      if (++acks === 1) return { ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) } as Response;
      return response({ acknowledged: true });
    }
    return response(batch(1, [1]));
  }, status => statuses.push(status));
  t.after(stop); await flush(); assert.equal(shown, 1);
  t.mock.timers.tick(10000); await flush(); assert.equal(signals[1]!.aborted, true);
  t.mock.timers.tick(5000); await flush(); finishBody({ acknowledged: true }); await flush();
  assert.equal(shown, 1); assert.equal(acks, 3);
  assert.deepEqual(statuses, [{ state: "retrying", reason: "timeout" }, { state: "connected" }]);
});

test("stop aborts in-flight JSON and suppresses late results, retries and status updates", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0, signal: AbortSignal | undefined, finishBody!: (value: unknown) => void;
  const sent: string[] = [], statuses: unknown[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, title => { sent.push(title); }, async (_url, init) => {
    calls++; signal = init!.signal!;
    return { ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) } as Response;
  }, status => statuses.push(status));
  await flush(); stop(); stop(); assert.equal(signal?.aborted, true);
  finishBody(batch(11, [11])); await flush(); t.mock.timers.tick(60000); await flush();
  assert.equal(calls, 1); assert.deepEqual(sent, []); assert.deepEqual(statuses, []);
});

test("HTTP, invalid JSON and invalid leases report status transitions only and recover", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const statuses: unknown[] = []; let calls = 0;
  const stop = startMailNotifications("https://assistant.example", undefined, () => {}, async () => {
    calls++;
    if (calls === 1 || calls >= 8) return response(batch(0));
    if (calls <= 3) return new Response("private error body", { status: 401 });
    if (calls === 4) return new Response("private error body", { status: 503 });
    if (calls === 5) return new Response("not JSON");
    if (calls === 6) return response({ latest: "invalid", items: [] });
    return response(batch(1, [1], { delivery: { id: "invalid", token: "t", leaseUntil: "invalid" } }));
  }, status => statuses.push(status));
  t.after(stop); await flush();
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(15000); await flush(); }
  assert.deepEqual(statuses, [
    { state: "connected" }, { state: "retrying", reason: "authorization" },
    { state: "retrying", reason: "unavailable" }, { state: "connected" },
  ]);
});

test("synchronously throwing fetch or status callback does not wedge retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let calls = 0;
  const stop = startMailNotifications("https://assistant.example", undefined, () => {}, () => {
    calls++; if (calls === 1) throw new Error("fetch rejected before returning a promise");
    return Promise.resolve(response(batch(0)));
  }, () => { throw new Error("presentation failed"); });
  t.after(stop); await flush(); t.mock.timers.tick(15000); await flush();
  t.mock.timers.tick(15000); await flush(); assert.equal(calls, 3);
});

test("urgent preview takes precedence over a newer ordinary message", async t => {
  const sent: string[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, (_title, body) => { sent.push(body); }, async url => {
    if (new URL(String(url)).pathname.endsWith("/ack")) return response({ acknowledged: true });
    return response(batch(2, [1, 2], { urgent: true, items: [
      { sequence: 1, message: { subject: "Urgent", importance: "high" } },
      { sequence: 2, message: { subject: "Ordinary", importance: "normal" } },
    ] }));
  });
  t.after(stop); await flush(); assert.deepEqual(sent, ["未知发件人：Urgent"]);
});

for (const outcome of ["false", "reject"] as const) {
  test(`async presentation ${outcome} leaves the delivery unacknowledged and retryable`, async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let attempts = 0, acks = 0;
    const stop = startMailNotifications("https://assistant.example", undefined, async () => {
      if (++attempts === 1) { if (outcome === "reject") throw new Error("native failure"); return false; }
      return true;
    }, async url => {
      if (new URL(String(url)).pathname.endsWith("/ack")) { acks++; return response({ acknowledged: true }); }
      return response(batch(1, [1]));
    });
    t.after(stop); await flush(); assert.equal(acks, 0);
    t.mock.timers.tick(15000); await flush(); assert.equal(attempts, 2); assert.equal(acks, 1);
  });
}

for (const outcome of ["resolve", "reject"] as const) {
  test(`late presentation ${outcome} after timeout never acknowledges or marks displayed`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    let finish!: () => void, attempts = 0, acks = 0;
    const statuses: unknown[] = [];
    const stop = startMailNotifications("https://assistant.example", undefined, () => {
      if (++attempts === 1) return new Promise<boolean>((resolve, reject) => { finish = () => outcome === "resolve" ? resolve(true) : reject(new Error("late")); });
      return true;
    }, async url => {
      if (new URL(String(url)).pathname.endsWith("/ack")) { acks++; return response({ acknowledged: true }); }
      return response(batch(1, [1]));
    }, status => statuses.push(status));
    t.after(stop); await flush(); t.mock.timers.tick(10000); await flush();
    finish(); await flush(); assert.equal(acks, 0);
    t.mock.timers.tick(5000); await flush(); assert.equal(attempts, 2); assert.equal(acks, 1);
    assert.deepEqual(statuses, [{ state: "retrying", reason: "timeout" }, { state: "connected" }]);
  });
}

test("stop while awaiting native show suppresses acknowledgement and late status", async t => {
  let finish!: (value: boolean) => void, acks = 0; const statuses: unknown[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, () => new Promise<boolean>(resolve => { finish = resolve; }), async url => {
    if (new URL(String(url)).pathname.endsWith("/ack")) { acks++; return response({ acknowledged: true }); }
    return response(batch(1, [1]));
  }, status => statuses.push(status));
  t.after(stop); await flush(); stop(); finish(true); await flush();
  assert.equal(acks, 0); assert.deepEqual(statuses, []);
});

test("lease expiring while awaiting native show is not acknowledged", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let finish!: (value: boolean) => void, acks = 0;
  const stop = startMailNotifications("https://assistant.example", undefined, () => new Promise<boolean>(resolve => { finish = resolve; }), async url => {
    if (new URL(String(url)).pathname.endsWith("/ack")) { acks++; return response({ acknowledged: true }); }
    return response(batch(1, [1], { delivery: { id: "d", token: "t", leaseUntil: 1001 } }));
  });
  t.after(stop); await flush(); t.mock.timers.tick(2); finish(true); await flush(); assert.equal(acks, 0);
});

for (const event of ["failed", "close", "timeout"] as const) {
  test(`native ${event} before show returns false and removes listeners`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const notification = new TestNotification(); notification.show = () => { notification.shown++; };
    const shown = showMailNotification(notification);
    if (event === "timeout") t.mock.timers.tick(4000); else notification.emit(event);
    assert.equal(await shown, false);
    assert.deepEqual(notification.eventNames(), []);
    notification.emit("show"); t.mock.timers.tick(10000);
    assert.equal(notification.closed, event === "close" ? 0 : 1);
  });
}

test("native show event confirms display and close clears lifecycle listeners", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const notification = new TestNotification(); notification.show = () => { notification.shown++; };
  let settled = false;
  const shown = showMailNotification(notification).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false);
  notification.emit("show"); assert.equal(await shown, true);
  t.mock.timers.tick(5000); assert.equal(notification.closed, 1); assert.deepEqual(notification.eventNames(), []);
});
