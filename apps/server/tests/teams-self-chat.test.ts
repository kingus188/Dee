import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openTeamsSelfChat, SELF_CHAT_REPLY_PREFIX } from "../dist/teams-self-chat.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dee-self-chat-"));
  const controller = new AbortController();
  let time = 1000, sends = 0, generations = 0, sender = "me", user = "haifeng.zhang@example.com";
  let sendFailure = false, modelFailure = false, edited = false, pages = false;
  const input = (id: string, at = 1100, text = "帮我整理消息") => ({ id, chatId: "48:notes", messageType: "message", createdDateTime: new Date(at).toISOString(), from: { user: { id: sender } }, body: { contentType: "text", content: text } });
  let messages = [input("old", 900)], receipt = input("none");
  const requests: string[] = [];
  const options = {
    dir, username: "haifeng.zhang", signal: controller.signal, now: () => time,
    getToken: async () => "read", sendToken: async () => "send",
    generate: async () => { generations++; if (modelFailure) throw new Error("model unavailable"); return "我可以整理成待办清单。"; },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url); requests.push(target);
      assert.ok(target === "https://graph.microsoft.com/v1.0/me" || target.startsWith("https://graph.microsoft.com/v1.0/chats/48%3Anotes/messages"));
      if (target.endsWith("/me")) return Response.json({ id: "me", userPrincipalName: user });
      if (init?.method === "POST") {
        sends++;
        if (sendFailure) throw new Error("timeout after POST");
        receipt = input(`reply-${sends}`, time + 1, JSON.parse(String(init.body)).body.content);
        return Response.json(receipt);
      }
      if (target.endsWith(`/${receipt.id}`)) return Response.json(receipt);
      if (target.includes("?$top=")) return Response.json({ value: pages ? messages.slice(0, 1) : messages, ...(pages ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/48%3Anotes/messages?$skiptoken=next" } : {}) });
      if (target.includes("$skiptoken=next")) return Response.json({ value: messages.slice(1) });
      const message = messages.find(m => target.endsWith(`/${m.id}`));
      assert.ok(message);
      return Response.json(edited ? { ...message, body: { content: "edited", contentType: "text" } } : message);
    }) as typeof fetch,
  };
  let worker = openTeamsSelfChat(options);
  return {
    get worker() { return worker; }, options, requests, input,
    fresh: (id = "input") => { time = 1200; messages = [input(id), ...messages]; },
    echo: () => { messages = [receipt, ...messages]; },
    change: (kind: string) => { if (kind === "sender") sender = "other"; if (kind === "account") user = "other@example.com"; if (kind === "send") sendFailure = true; if (kind === "model") modelFailure = true; if (kind === "edit") edited = true; if (kind === "pages") pages = true; },
    get sends() { return sends; }, get generations() { return generations; },
    restart: async () => { await worker.close(); worker = openTeamsSelfChat(options); },
    close: async () => { controller.abort(); await worker.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("native self-chat baselines history, serializes polls, verifies delivery, skips echoes and survives restart", async () => {
  const f = await fixture();
  try {
    await f.worker.refresh(); assert.equal(f.sends, 0);
    f.fresh();
    await Promise.all([f.worker.refresh(), f.worker.refresh()]);
    assert.equal(f.sends, 1); assert.equal(f.generations, 1);
    assert.equal(f.worker.status()[0].state, "sent");
    assert.equal(f.worker.status()[0].reply_id, "reply-1");
    f.echo(); await f.restart(); await f.worker.refresh();
    assert.equal(f.sends, 1); assert.equal(f.generations, 1);
    f.fresh("second"); await f.worker.refresh(); assert.equal(f.sends, 2);
  } finally { await f.close(); }
});

test("unknown POST result blocks all future sends including after restart", async () => {
  const f = await fixture();
  try {
    await f.worker.refresh(); f.fresh(); f.change("send");
    await assert.rejects(f.worker.refresh(), /timeout after POST/);
    assert.equal(f.worker.status()[0].state, "unknown");
    await f.restart(); f.fresh("second");
    await assert.rejects(f.worker.refresh(), /结果未知/);
    assert.equal(f.sends, 1); assert.equal(f.generations, 1);
  } finally { await f.close(); }
});

test("account, foreign sender, edited input and model failure never cause a POST", async () => {
  for (const kind of ["account", "sender", "edit", "model"]) {
    const f = await fixture();
    try {
      await f.worker.refresh(); f.change(kind); f.fresh();
      await assert.rejects(f.worker.refresh());
      assert.equal(f.sends, 0);
      if (["edit", "model"].includes(kind)) {
        assert.equal(f.worker.status()[0].state, "failed");
        await f.restart(); await f.worker.refresh(); assert.equal(f.generations, 1);
      }
    } finally { await f.close(); }
  }
});

test("persisted sending claims after a crash block restart, while processing claims are not replayed", async () => {
  for (const state of ["sending", "processing"]) {
    const f = await fixture();
    try {
      await f.worker.refresh(); f.fresh();
      const db = new DatabaseSync(join(f.options.dir, "teams-self-chat.sqlite"));
      db.prepare("INSERT INTO replies(source_id,state) VALUES('input',?)").run(state); db.close();
      await f.restart();
      if (state === "sending") await assert.rejects(f.worker.refresh(), /结果未知/);
      else await f.worker.refresh();
      assert.equal(f.sends, 0); assert.equal(f.generations, 0);
    } finally { await f.close(); }
  }
});

test("pagination does not skip unseen input behind a known message", async () => {
  const f = await fixture();
  try {
    await f.worker.refresh(); f.fresh(); await f.worker.refresh();
    f.fresh("behind"); f.echo(); f.change("pages");
    await f.worker.refresh(); assert.equal(f.sends, 2);
  } finally { await f.close(); }
});

test("prefix replies never trigger a model call", async () => {
  const f = await fixture();
  try {
    await f.worker.refresh();
    f.options.generate = async () => SELF_CHAT_REPLY_PREFIX + "answer";
    f.fresh(); await f.worker.refresh(); f.echo(); await f.worker.refresh();
    assert.equal(f.sends, 1);
  } finally { await f.close(); }
});
