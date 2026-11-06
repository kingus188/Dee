import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsStore } from "../dist/teams-store.js";
import { startTeamsForward } from "../dist/teams-forward.js";

test("提醒注入失败不回退重复发送；非文本消息也绑定来源；刷新后已回复不注入", async () => {
  for (const mode of ["failed", "empty", "replied"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "pi-forward-"));
    await mkdir(join(directory, "state/primary"), { recursive: true });
    await writeFile(join(directory, "state/primary/context_tokens.json"), JSON.stringify({ wxid_test: "test" }));
    const store = openTeamsStore(directory);
    const incoming = { id: "chat:in", chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "同事", direction: "in" as const, text: mode === "empty" ? "" : "请求", important: true, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() };
    store.record(incoming);
    let injections = 0, sends = 0, stop = () => {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { sends++; return new Response("{}"); };
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    try {
      stop = startTeamsForward({ dir: directory, store, getToken: async () => "unused", sendURL: "http://localhost:1/unused", sendToken: "test",
        sync: { status: () => ({ lastSuccessAt: null }), refresh: async () => {
          if (mode === "replied") store.record({ ...incoming, id: "chat:out", senderId: "me", direction: "out", createdAt: new Date().toISOString() });
          return { ok: true, lastSuccessAt: new Date().toISOString() };
        } },
        inject: async (_wxid, prompt, id) => { injections++; assert.equal(id, incoming.id); assert.match(prompt, /第三方/); if (mode === "failed") throw Error("receipt uncertain"); },
        undelivered: async () => { complete(); return []; },
      });
      await done;
      assert.equal(sends, 0);
      assert.equal(injections, mode === "replied" ? 0 : 1);
      assert.equal(!!store.message(incoming.id)?.pushedAt, mode === "empty");
    } finally { stop(); globalThis.fetch = originalFetch; store.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("工作状态自动代回：只回私聊、每人一次，通知里带上已代回且不算已回复", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-forward-away-"));
  await mkdir(join(directory, "state/primary"), { recursive: true });
  await writeFile(join(directory, "state/primary/context_tokens.json"), JSON.stringify({ wxid_test: "test" }));
  const store = openTeamsStore(directory);
  const base = { senderId: "peer", direction: "in" as const, important: true, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() };
  store.record({ ...base, id: "dm:1", chatId: "dm", chatType: "oneOnOne", senderName: "同事", text: "方案什么时候给我" });
  store.record({ ...base, id: "dm:2", chatId: "dm", chatType: "oneOnOne", senderName: "同事", text: "急" });
  store.record({ ...base, id: "g:1", chatId: "g", chatType: "group", chatTopic: "项目群", senderName: "同事", text: "群里问一句" });
  store.setAway({ status: "出差中", reply: "我在出差，今天回得慢，紧急事情打电话给我。", until: new Date(Date.now() + 3_600_000).toISOString() });

  const graphSends: string[] = [];
  const prompts: string[] = [];
  const originalFetch = globalThis.fetch;
  let stop = () => {};
  let complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("graph.microsoft.com")) {
      graphSends.push(String(JSON.parse(String(init!.body)).body.content));
      return Response.json({ id: "auto1", from: { user: { id: "me", displayName: "我" } }, createdDateTime: new Date().toISOString(), body: { content: "ok" } });
    }
    return new Response("{}");
  }) as typeof fetch;
  try {
    stop = startTeamsForward({ dir: directory, store, getToken: async () => "token", sendURL: "http://localhost:1/unused", sendToken: "test",
      sync: { status: () => ({ lastSuccessAt: null }), refresh: async () => ({ ok: true, lastSuccessAt: new Date().toISOString() }) },
      inject: async (_wxid, prompt) => { prompts.push(prompt); },
      undelivered: async () => { complete(); return []; } });
    await done;
    assert.deepEqual(graphSends, ["我在出差，今天回得慢，紧急事情打电话给我。"], "同一个人只代回一次，群聊不代回");
    assert.equal(prompts.filter(prompt => prompt.includes("出差中")).length, 1, "只有代回的那条通知带状态");
    assert.equal(store.message("dm:1")?.repliedAt, null, "代回不算用户已回复");
    assert.ok(store.message("dm:1")?.pushedAt, "通知照常推送");
  } finally { stop(); globalThis.fetch = originalFetch; store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("停止期间等待的同步完成后，不再注入、读取微信发件箱或发出通知", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-forward-stop-"));
  const store = openTeamsStore(directory);
  let finish!: (value: { ok: boolean; lastSuccessAt: string | null }) => void;
  const refreshed = new Promise<{ ok: boolean; lastSuccessAt: string | null }>(resolve => { finish = resolve; });
  let injections = 0, outboxReads = 0, notices = 0;
  const stop = startTeamsForward({ dir: directory, store, getToken: async () => { throw new Error("must not acquire token"); },
    sendURL: "http://localhost:1/unused", sendToken: "test",
    sync: { status: () => ({ lastSuccessAt: null }), refresh: () => refreshed },
    inject: async () => { injections++; }, undelivered: async () => { outboxReads++; return [{ text: "pending" }]; },
    onStuck: () => { notices++; } });
  try {
    const stopped = stop();
    finish({ ok: true, lastSuccessAt: null });
    await stopped;
    assert.equal(injections, 0);
    assert.equal(outboxReads, 0);
    assert.equal(notices, 0);
  } finally { finish({ ok: true, lastSuccessAt: null }); await stop(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("自动代回网络结果未知只发送一次，重启换状态也不会重复；提示不得宣称已代回", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-forward-unknown-"));
  await mkdir(join(directory, "state/primary"), { recursive: true });
  await writeFile(join(directory, "state/primary/context_tokens.json"), JSON.stringify({ wxid_test: "test" }));
  let store = openTeamsStore(directory);
  const base = { chatId: "dm", chatType: "oneOnOne", senderId: "peer", senderName: "同事", direction: "in" as const, important: true, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() };
  store.record({ ...base, id: "dm:1", text: "方案呢" });
  store.record({ ...base, id: "dm:2", text: "在吗" });
  store.setAway({ status: "开会中", reply: "稍后回你", until: new Date(Date.now() + 3_600_000).toISOString() });
  const originalFetch = globalThis.fetch;
  let posts = 0;
  const prompts: string[] = [];
  globalThis.fetch = async () => { posts++; throw new TypeError("fetch failed after upload"); };
  const run = async () => {
    let complete!: () => void;
    const done = new Promise<void>(resolve => { complete = resolve; });
    const stop = startTeamsForward({ dir: directory, store, getToken: async () => "token", sendURL: "http://localhost:1/unused", sendToken: "test",
      sync: { status: () => ({ lastSuccessAt: null }), refresh: async () => ({ ok: true, lastSuccessAt: new Date().toISOString() }) },
      inject: async (_wxid, prompt) => { prompts.push(prompt); },
      undelivered: async () => { complete(); return []; } });
    try { await done; } finally { await stop(); }
  };
  try {
    await run();
    assert.equal(posts, 1);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.match(prompt, /发送结果未知/);
      assert.match(prompt, /已核实 自动代回 \d+ 未发送/);
      assert.doesNotMatch(prompt, /已按用户.*自动代回一句/);
    }
    store.close(); store = openTeamsStore(directory);
    store.setAway({ status: "出差中", reply: "明天回你", until: new Date(Date.now() + 3_600_000).toISOString() });
    store.record({ ...base, id: "dm:3", text: "新来信" });
    await run();
    assert.equal(posts, 1, "未知结果重启及换状态后也不重发");
  } finally { globalThis.fetch = originalFetch; store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("自动代回等待令牌期间来源被处理、撤销、推送或过期以及授权撤回均不 POST", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-05T12:00:00Z") });
  for (const mode of ["reply", "cancel", "pushed", "expired", "authorization"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "pi-forward-away-race-"));
    await mkdir(join(directory, "state/primary"), { recursive: true });
    await writeFile(join(directory, "state/primary/context_tokens.json"), '{"wxid_test":"synthetic"}');
    const store = openTeamsStore(directory);
    const source = { id: "dm:in", chatId: "dm", chatType: "oneOnOne", senderId: "peer", senderName: "Peer", direction: "in" as const, text: "pending", important: true, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() };
    store.record(source);
    store.setAway({ status: "busy", reply: "later", until: new Date(Date.now() + 48 * 3_600_000).toISOString() });
    const version = store.away()!.version;
    let release!: (value: string) => void, acquired!: () => void, complete!: () => void;
    const token = new Promise<string>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { acquired = resolve; });
    const done = new Promise<void>(resolve => { complete = resolve; });
    let posts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { posts++; throw Error("must not POST after source invalidation"); };
    const stop = startTeamsForward({ dir: directory, store, getToken: () => { acquired(); return token; }, sendURL: "http://unused.test", sendToken: "synthetic",
      sync: { status: () => ({ lastSuccessAt: null }), refresh: async () => ({ ok: true, lastSuccessAt: new Date().toISOString() }) },
      inject: async () => {}, undelivered: async () => { complete(); return []; } });
    try {
      await waiting;
      if (mode === "reply") store.record({ ...source, id: "dm:out", direction: "out", senderId: "me", createdAt: new Date().toISOString(), important: false });
      if (mode === "cancel") store.notifications.cancelSource(source.id);
      if (mode === "pushed") store.markPushed(source.id);
      if (mode === "expired") t.mock.timers.setTime(Date.now() + 25 * 3_600_000);
      if (mode === "authorization") store.clearAway();
      release("synthetic"); await done;
      assert.equal(posts, 0, mode);
      assert.equal(store.autoReplyAttempt("dm", version), undefined, "definite pre-POST cancellation releases only its own unsent claim");
    } finally { release("synthetic"); await stop(); globalThis.fetch = original; store.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("自动代回处理前一条期间后续快照来源被删除，入口重查后不获取其令牌", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-forward-away-snapshot-"));
  await mkdir(join(directory, "state/primary"), { recursive: true });
  await writeFile(join(directory, "state/primary/context_tokens.json"), '{"wxid_test":"synthetic"}');
  const store = openTeamsStore(directory);
  const source = (id: string) => ({ id, chatId: id, chatType: "oneOnOne", senderId: "peer", senderName: "Peer", direction: "in" as const, text: id, important: true, createdAt: new Date(Date.now() - 31 * 60_000).toISOString() });
  store.record(source("a")); store.record(source("b"));
  store.setAway({ status: "busy", reply: "later", until: new Date(Date.now() + 3_600_000).toISOString() });
  let calls = 0, posts = 0, complete!: () => void;
  const done = new Promise<void>(resolve => { complete = resolve; });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { posts++; return Response.json({}, { status: 403 }); };
  const stop = startTeamsForward({ dir: directory, store, getToken: async () => { calls++; store.notifications.cancelSource("b"); return "synthetic"; }, sendURL: "http://unused.test", sendToken: "synthetic",
    sync: { status: () => ({ lastSuccessAt: null }), refresh: async () => ({ ok: true, lastSuccessAt: new Date().toISOString() }) },
    inject: async () => {}, undelivered: async () => { complete(); return []; } });
  try {
    await done;
    assert.equal(calls, 1); assert.equal(posts, 1);
    assert.equal(store.autoReplyAttempt("b", store.away()!.version), undefined);
  } finally { await stop(); globalThis.fetch = original; store.close(); await rm(directory, { recursive: true, force: true }); }
});
