import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { showMailNotification, startMailNotifications } from "../dist/mail-notifications.js";

class TestNotification extends EventEmitter {
  shown = 0;
  closed = 0;
  show() { this.shown++; }
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


test("desktop polling skips history, authenticates API and batches fresh messages", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const sent: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const after = new URL(String(url)).searchParams.get("after");
    return new Response(JSON.stringify(after === null ? { latest: 10, items: [] } : after === "10" ? { latest: 12, items: [11, 12].map(sequence => ({ sequence, message: { sender: "张三", subject: `主题${sequence}` } })) } : { latest: 12, items: [] }));
  };
  const stop = startMailNotifications("https://assistant.example", "Basic abc", (title, body) => sent.push(title + "|" + body), fetcher);
  await setImmediate();
  t.mock.timers.tick(15000); await setImmediate();
  assert.deepEqual(sent, ["Outlook · 2 封新邮件|张三：主题12"]);
  t.mock.timers.tick(15000); await setImmediate();
  assert.deepEqual(requests.map(r => new URL(r.url).searchParams.get("after")), [null, "10", "12"]);
  for (const request of requests) {
    assert.equal(new URL(request.url).pathname, "/api/mail/notices");
    assert.equal(request.init?.redirect, "error");
    assert.equal(new Headers(request.init?.headers).get("Authorization"), "Basic abc");
  }
  stop(); t.mock.timers.tick(15000); await setImmediate(); assert.equal(requests.length, 3);
});

test("a zero initial cursor still delivers the first new message and retries offline", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0; const sent: string[] = [];
  const fetcher: typeof fetch = async () => {
    calls++;
    if (calls === 2) throw new Error("offline or refused redirect");
    return new Response(JSON.stringify(calls === 1 ? { latest: 0, items: [] } : { latest: 1, items: [{ sequence: 1, message: { subject: "First", address: "alice" } }] }));
  };
  const stop = startMailNotifications("http://127.0.0.1:8080", undefined, (_title, body) => sent.push(body), fetcher);
  await setImmediate(); t.mock.timers.tick(15000); await setImmediate();
  t.mock.timers.tick(15000); await setImmediate();
  assert.deepEqual(sent, ["alice：First"]); stop();
});

test("stopping in-flight polling suppresses late notifications", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let resolve: ((response: Response) => void) | undefined;
  const sent: string[] = [];
  const stop = startMailNotifications("https://assistant.example", undefined, title => sent.push(title), async () => new Promise<Response>(done => { resolve = done; }));
  stop(); resolve!(new Response(JSON.stringify({ latest: 1, items: [] }))); await setImmediate();
  assert.deepEqual(sent, []);
});
