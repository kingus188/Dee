import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsStore } from "../../server/dist/teams-store.js";
import { startTeamsForward } from "../dist/teams-forward.js";

test("提醒注入失败不回退重复发送；非文本消息也绑定来源；刷新后已回复不注入", async () => {
  for (const mode of ["failed", "empty", "replied"] as const) {
    const directory = await mkdtemp(join(tmpdir(), "pi-forward-"));
    await mkdir(join(directory, "state/primary"), { recursive: true });
    await writeFile(join(directory, "state/primary/context_tokens.json"), JSON.stringify({ wxid_test: "test" }));
    const store = openTeamsStore(directory);
    const incoming = { id: "chat:in", chatId: "chat", chatType: "oneOnOne", senderId: "peer", senderName: "同事", direction: "in" as const, text: mode === "empty" ? "" : "请求", important: true, createdAt: new Date(Date.now() - 60_000).toISOString() };
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
  const base = { senderId: "peer", direction: "in" as const, important: true, createdAt: new Date(Date.now() - 60_000).toISOString() };
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
