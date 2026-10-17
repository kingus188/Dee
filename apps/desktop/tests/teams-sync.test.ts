import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTeamsSync, GRAPH } from "../dist/teams-sync.js";
import { sendTeamsMessage } from "../dist/teams-send.js";
import type { TeamsStore } from "@assistant/server";

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const message = (id: string, createdDateTime: string, mine = false) => ({ id, createdDateTime, messageType: "message", from: { user: { id: mine ? "me" : "peer" } }, body: { content: "text" } });

test("单个聊天失败只跳过它：不推进它的水位，其余聊天照常入库，重叠读取可接收同时间晚到消息", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-teams-sync-"));
  const old = at(60), newer = at(1), replyAt = at(30);
  await writeFile(join(dir, "teams-forward.json"), JSON.stringify({ c1: old, c2: old }));
  const saved = new Map<string, { id: string; direction: string }>();
  let fail = true, late = false, calls = 0;
  const store = { record: (m: { id: string; direction: string }) => saved.set(m.id, m), earliestUnrepliedAt: () => null } as unknown as TeamsStore;
  const fetchImpl = (async (url: string) => {
    calls++;
    if (url.includes("/me?")) return Response.json({ id: "me" });
    if (url.includes("/me/chats?")) return Response.json({ value: [{ id: "c1", chatType: "oneOnOne" }], "@odata.nextLink": GRAPH + "/chats-page2" });
    if (url.endsWith("/chats-page2")) return Response.json({ value: [{ id: "c2", chatType: "group" }] });
    if (url.includes("/chats/c2/")) return Response.json({ value: [message("in2", newer)] });
    if (url.endsWith("/messages-page2")) return fail ? new Response("", { status: 503 }) : Response.json({ value: [message("reply", replyAt, true)] });
    return Response.json({ value: [message("new", newer), ...(late ? [message("same-time", newer)] : [])], "@odata.nextLink": GRAPH + "/messages-page2" });
  }) as typeof fetch;
  const sync = createTeamsSync({ dir, store, getToken: async () => "test", fetchImpl });
  try {
    const first = await sync.refresh();
    assert.equal(first.ok, false, "有聊天被跳过时本轮不算成功");
    // 失败原因要带上请求路径，否则日志无法指出是哪个聊天的哪一页。
    assert.match(first.skipped!.join(" "), /聊天 c1：Graph 503 \/v1\.0\/messages-page2/);
    assert.equal(JSON.parse(await readFile(join(dir, "teams-forward.json"), "utf8")).c1, old);
    assert.ok(!saved.has("c1:new"), "失败的聊天不入库");
    assert.ok(saved.has("c2:in2"), "一个聊天失败不拖垮其余聊天");
    assert.equal(sync.status().lastSuccessAt, null);
    fail = false;
    const one = sync.refresh(), two = sync.refresh();
    assert.equal(one, two, "并发查询与轮询合并");
    assert.equal((await one).ok, true);
    assert.equal(saved.get("c1:reply")?.direction, "out");
    assert.ok(saved.has("c2:in2"));
    late = true;
    await sync.refresh();
    assert.ok(saved.has("c1:same-time"));
    assert.ok(calls > 6);
    assert.equal(JSON.parse(await readFile(join(dir, "teams-forward.json"), "utf8")).c1, newer);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Graph nextLink 不得带令牌访问其他站点，循环分页失败而非跳过", async () => {
  for (const next of ["https://example.com/steal", GRAPH + "/me/chats?$top=50"]) {
    const dir = await mkdtemp(join(tmpdir(), "pi-teams-pages-"));
    let calls = 0;
    try {
      const sync = createTeamsSync({ dir, store: { earliestUnrepliedAt: () => null } as unknown as TeamsStore, getToken: async () => "test",
        fetchImpl: (async (url: string) => {
          calls++;
          assert.ok(url.startsWith(GRAPH));
          return Response.json(url.includes("/me?") ? { id: "me" } : { value: [], "@odata.nextLink": next });
        }) as typeof fetch });
      await assert.rejects(sync.refresh(), /分页/);
      assert.ok(calls <= 3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("Teams 发送成功用 Graph 返回的真实 ID 和时间立即入库；成功后的入库失败不能变成可重发", async () => {
  const original = globalThis.fetch;
  const records: unknown[] = [];
  const sent = message("graph-id", at(0), true);
  const store = { record: (m: unknown) => records.push(m), recentInChat: () => [{ chatType: "oneOnOne", chatTopic: null }] } as unknown as TeamsStore;
  try {
    globalThis.fetch = async () => Response.json(sent, { status: 201 });
    await sendTeamsMessage(async () => "test", "chat", "text", store);
    assert.equal((records[0] as { id: string }).id, "chat:graph-id");
    assert.equal((records[0] as { createdAt: string }).createdAt, sent.createdDateTime);
    store.record = () => { throw new Error("db unavailable"); };
    await assert.doesNotReject(sendTeamsMessage(async () => "test", "chat", "text", store));
    globalThis.fetch = async () => new Response("", { status: 403 });
    await assert.rejects(sendTeamsMessage(async () => "test", "chat", "text", store), /403/);
  } finally { globalThis.fetch = original; }
});

test("聊天消息里的非法分页地址是安全问题，不能当成单个聊天的故障跳过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-teams-unsafe-"));
  try {
    const sync = createTeamsSync({ dir, store: { earliestUnrepliedAt: () => null } as unknown as TeamsStore, getToken: async () => "test",
      fetchImpl: (async (url: string) => Response.json(url.includes("/me?") ? { id: "me" }
        : url.includes("/me/chats?") ? { value: [{ id: "c1", chatType: "oneOnOne" }] }
        : { value: [], "@odata.nextLink": "https://example.com/steal" })) as typeof fetch });
    await assert.rejects(sync.refresh(), /分页/);
    assert.equal(sync.status().lastSuccessAt, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("会议聊天的 403 不算故障：其余聊天照常成功，之后不再请求它", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-teams-403-"));
  const saved = new Set<string>();
  const asked: string[] = [];
  try {
    // 新聊天的水位从进程启动起算，所以预写水位才能收到既有消息。
    await writeFile(join(dir, "teams-forward.json"), JSON.stringify({ c1: at(60) }));
    const store = { record: (m: { id: string }) => saved.add(m.id), earliestUnrepliedAt: () => null } as unknown as TeamsStore;
    const sync = createTeamsSync({ dir, store, getToken: async () => "test",
      fetchImpl: (async (url: string) => {
        if (url.includes("/me?")) return Response.json({ id: "me" });
        if (url.includes("/me/chats?")) return Response.json({ value: [{ id: "meet", chatType: "group" }, { id: "c1", chatType: "oneOnOne" }] });
        asked.push(url.includes("/chats/meet/") ? "meet" : "c1");
        if (url.includes("/chats/meet/")) return new Response("", { status: 403 });
        return Response.json({ value: [message("in1", at(1))] });
      }) as typeof fetch });
    const first = await sync.refresh();
    assert.equal(first.ok, true, "403 是权限性拒绝，不该让自动提醒停摆");
    assert.match(first.skipped!.join(" "), /聊天 meet：Graph 403 \/v1\.0\/chats\/meet\/messages/);
    assert.ok(saved.has("c1:in1"));
    assert.ok(sync.status().lastSuccessAt);
    await sync.refresh();
    assert.equal(asked.filter(x => x === "meet").length, 1, "403 的聊天不再重复请求");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("久无新消息的聊天不再逐个请求；仍有未回复来信的照旧回扫", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-teams-quiet-"));
  const asked: string[] = [];
  try {
    // 三个聊天水位都是刚同步过，quiet 和 unreplied 的最后一条消息都在两天前。
    await writeFile(join(dir, "teams-forward.json"), JSON.stringify({ quiet: at(0), unreplied: at(0), busy: at(0) }));
    const store = { record: () => {},
      earliestUnrepliedAt: (chatId: string) => chatId === "unreplied" ? at(60 * 48) : null } as unknown as TeamsStore;
    const sync = createTeamsSync({ dir, store, getToken: async () => "test",
      fetchImpl: (async (url: string) => {
        if (url.includes("/me?")) return Response.json({ id: "me" });
        if (url.includes("/me/chats?")) return Response.json({ value: [
          { id: "quiet", chatType: "group", lastMessagePreview: { createdDateTime: at(60 * 48) } },
          { id: "unreplied", chatType: "oneOnOne", lastMessagePreview: { createdDateTime: at(60 * 48) } },
          { id: "busy", chatType: "oneOnOne", lastMessagePreview: { createdDateTime: at(1) } },
        ] });
        asked.push(/\/chats\/([^/]+)\//.exec(url)![1]);
        return Response.json({ value: [] });
      }) as typeof fetch });
    assert.equal((await sync.refresh()).ok, true);
    assert.deepEqual(asked.sort(), ["busy", "unreplied"], "没新消息的聊天不请求，未回复的仍要回扫");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
