import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSelfChatRecovery } from "../dist/teams-self-chat-recovery.js";
import { openTeamsSelfChat, SELF_CHAT_REPLY_PREFIX } from "../dist/teams-self-chat.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dee-self-chat-"));
  const controller = new AbortController();
  let time = 1000, sends = 0, generations = 0, sender = "me", user = "haifeng.zhang@example.com";
  let sendFailure = false, modelFailure = false, edited = false, pages = false, hideInput = false;
  let sourceFailure: number | "network" | undefined;
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
      if (target.endsWith("/input") && sourceFailure) {
        if (sourceFailure === "network") throw new Error("network unavailable");
        return Response.json({}, { status: sourceFailure });
      }
      if (target.includes("?$top=")) return Response.json({ value: hideInput ? messages.filter(m => m.id !== "input") : pages ? messages.slice(0, 1) : messages, ...(pages ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/chats/48%3Anotes/messages?$skiptoken=next" } : {}) });
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
    failSource: (failure: number | "network" | undefined) => { sourceFailure = failure; },
    hideInput: () => { hideInput = true; },
    advance: (milliseconds: number) => { time += milliseconds; },
    restore: () => { modelFailure = false; sendFailure = false; edited = false; },
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


test("operator can retry a pre-send failure without replaying delivered input", async () => {
  const f = await fixture();
  try {
    await f.worker.refresh(); f.fresh(); f.change("model");
    await assert.rejects(f.worker.refresh()); f.restore();
    const recovery = openSelfChatRecovery(f.options.dir, "me");
    try {
      recovery.resolve("input", "failed", "retry");
      assert.throws(() => recovery.resolve("input", "failed", "retry"), /状态已变化/);
      await f.worker.refresh(); await f.worker.refresh();
      assert.equal(f.sends, 1); assert.equal(f.generations, 2);
      assert.equal(recovery.status()[0].state, "sent");
      assert.throws(() => recovery.resolve("input", "sent", "retry"));
    } finally { recovery.close(); }
  } finally { await f.close(); }
});

test("crashed processing becomes an explicit recoverable failure on restart", async () => {
  const f = await fixture();
  try {
    await f.worker.refresh(); f.fresh();
    const db = new DatabaseSync(join(f.options.dir, "teams-self-chat.sqlite"));
    db.prepare("INSERT INTO replies(source_id,state) VALUES('input','processing')").run(); db.close();
    await f.restart(); await f.worker.refresh();
    assert.equal(f.sends, 0); assert.equal(f.worker.status()[0].state, "failed");
    const recovery = openSelfChatRecovery(f.options.dir, "me");
    try { recovery.resolve("input", "failed", "retry"); } finally { recovery.close(); }
    await f.worker.refresh(); assert.equal(f.sends, 1);
  } finally { await f.close(); }
});

test("unknown delivery can only be skipped explicitly, preserving receipt and audit", async () => {
  const f = await fixture();
  try {
    await f.worker.refresh(); f.fresh(); f.change("send");
    await assert.rejects(f.worker.refresh()); f.restore();
    assert.throws(() => openSelfChatRecovery(f.options.dir, "other"), /账号不匹配/);
    const recovery = openSelfChatRecovery(f.options.dir, "me");
    try {
      assert.throws(() => recovery.resolve("input", "unknown", "retry"), /不得重试/);
      recovery.resolve("input", "unknown", "skip");
      assert.equal(recovery.status()[0].state, "skipped");
    } finally { recovery.close(); }
    await f.restart(); f.fresh("second"); await f.worker.refresh();
    assert.equal(f.sends, 2); assert.equal(f.generations, 2);
    const db = new DatabaseSync(join(f.options.dir, "teams-self-chat.sqlite"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS total FROM recovery_audit").get()?.total, 1);
      assert.equal(db.prepare("SELECT state FROM replies WHERE source_id='input'").get()?.state, "skipped");
    } finally { db.close(); }
  } finally { await f.close(); }
});


test("explicit retry retrieves a source outside the latest page and still enforces expiry", async () => {
  for (const expired of [false, true]) {
    const f = await fixture();
    try {
      await f.worker.refresh(); f.fresh(); f.change("model");
      await assert.rejects(f.worker.refresh()); f.restore(); f.hideInput();
      const recovery = openSelfChatRecovery(f.options.dir, "me");
      try { recovery.resolve("input", "failed", "retry"); } finally { recovery.close(); }
      if (expired) {
        f.advance(86400_001);
        await assert.rejects(f.worker.refresh(), /一天内/);
        assert.equal(f.sends, 0); assert.equal(f.worker.status()[0].state, "failed");
      } else {
        await f.worker.refresh(); assert.equal(f.sends, 1);
        assert.ok(f.requests.some(url => url.endsWith("/input")));
      }
    } finally { await f.close(); }
  }
});

test("a superseded generator cannot POST or overwrite the recovered execution", async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  f.options.generate = async () => {
    if (++calls === 1) { started(); await gate; }
    return "恢复后的回答";
  };
  let replacement: ReturnType<typeof openTeamsSelfChat> | undefined;
  try {
    await f.restart(); await f.worker.refresh(); f.fresh();
    const old = f.worker.refresh();
    // Observe rejection immediately; it may finish after the replacement.
    const rejected = assert.rejects(old, /已被中断/);
    await entered;
    replacement = openTeamsSelfChat(f.options);
    const recovery = openSelfChatRecovery(f.options.dir, "me");
    try { recovery.resolve("input", "failed", "retry"); } finally { recovery.close(); }
    await replacement.refresh();
    assert.equal(f.sends, 1);
    release(); await rejected;
    assert.equal(f.sends, 1); assert.equal(replacement.status()[0].state, "sent");
    assert.equal(replacement.status()[0].reply_id, "reply-1");
  } finally { release(); await replacement?.close(); await f.close(); }
});


test("missing or forbidden retry source fails without starving new notes", async () => {
  for (const status of [403, 404]) {
    const f = await fixture();
    try {
      await f.worker.refresh(); f.fresh(); f.change("model");
      await assert.rejects(f.worker.refresh()); f.restore(); f.hideInput();
      const recovery = openSelfChatRecovery(f.options.dir, "me");
      try {
        recovery.resolve("input", "failed", "retry");
        f.failSource(status); f.fresh("second");
        await f.worker.refresh();
        assert.equal(recovery.status().find(row => row.source_id === "input")?.state, "failed");
        assert.equal(recovery.status().find(row => row.source_id === "second")?.state, "sent");
        assert.equal(f.sends, 1);
        await f.worker.refresh(); assert.equal(f.sends, 1);
      } finally { recovery.close(); }
    } finally { await f.close(); }
  }
});

test("rate limits and network failure preserve explicit retry until recovery", async () => {
  for (const failure of [429, "network"] as const) {
    const f = await fixture();
    try {
      await f.worker.refresh(); f.fresh(); f.change("model");
      await assert.rejects(f.worker.refresh()); f.restore(); f.hideInput();
      const recovery = openSelfChatRecovery(f.options.dir, "me");
      try {
        recovery.resolve("input", "failed", "retry"); f.failSource(failure);
        await assert.rejects(f.worker.refresh());
        assert.equal(recovery.status()[0].state, "retry"); assert.equal(f.sends, 0);
        f.failSource(undefined); await f.worker.refresh();
        assert.equal(recovery.status()[0].state, "sent"); assert.equal(f.sends, 1);
      } finally { recovery.close(); }
    } finally { await f.close(); }
  }
});
