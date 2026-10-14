import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsStore } from "../dist/teams-store.js";

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const base = { chatId: "c1", chatType: "oneOnOne", senderId: "u1", senderName: "张三", direction: "in" as const, text: "在吗", important: true };

test("推送标记、已回复标记与查询过滤", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-store-"));
  const store = openTeamsStore(directory);
  try {
    store.record({ ...base, id: "c1:1", createdAt: at(30) });
    store.record({ ...base, id: "c1:1", createdAt: at(30) });
    store.record({ ...base, id: "c2:1", chatId: "c2", senderName: "李四", createdAt: at(20), important: false });
    assert.equal(store.list({ limit: 10 }).length, 2, "重复写入同一条消息不产生副本");
    assert.deepEqual(store.pendingPush().map(item => item.id), ["c1:1"], "只有重要来信进入待推送");
    store.markPushed("c1:1");
    assert.equal(store.pendingPush().length, 0);
    store.record({ ...base, id: "c1:2", direction: "out", senderId: "me", senderName: "我", text: "在", createdAt: at(10), important: false });
    const unreplied = store.list({ unreplied: true, limit: 10 });
    assert.deepEqual(unreplied.map(item => item.senderName), ["李四"], "我在 c1 回复后，c1 的来信不再算未回复");
    assert.equal(store.list({ sender: "张", limit: 10 }).find(item => item.direction === "in")?.repliedAt !== null, true);
    assert.equal(store.list({ sinceHours: 0.25, limit: 10 }).length, 1, "只返回最近 15 分钟");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recentInChat 返回同聊天早于新消息的最近上文，并带群名", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-store-"));
  const store = openTeamsStore(directory);
  try {
    const cutoff = at(10);
    store.record({ ...base, id: "c1:1", createdAt: at(30), chatTopic: "项目群" });
    store.record({ ...base, id: "c1:2", direction: "out", senderId: "me", senderName: "我", text: "收到", createdAt: at(20), important: false });
    store.record({ ...base, id: "c2:1", chatId: "c2", createdAt: at(15) });
    store.record({ ...base, id: "c1:3", text: "好的", createdAt: cutoff });
    const history = store.recentInChat("c1", cutoff, 5);
    assert.deepEqual(history.map(item => item.text), ["在吗", "收到"], "只含 c1 且早于新消息，按时间正序");
    assert.equal(history[0].chatTopic, "项目群");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("按聊天查询：群名匹配群聊，姓名匹配私聊整段对话", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-store-"));
  const store = openTeamsStore(directory);
  try {
    store.record({ ...base, id: "g:1", chatId: "g", chatType: "group", senderName: "张三", text: "群里说", createdAt: at(40), chatTopic: "项目群" });
    store.record({ ...base, id: "c1:1", text: "私聊问", createdAt: at(30) });
    store.record({ ...base, id: "c1:2", direction: "out", senderId: "me", senderName: "我", text: "私聊答", createdAt: at(20), important: false });
    assert.deepEqual(store.list({ chat: "项目", limit: 10 }).map(item => item.text), ["群里说"], "群名只匹配该群，不含张三的私聊");
    assert.deepEqual(store.list({ chat: "张三", limit: 10 }).map(item => item.text), ["私聊答", "私聊问"], "姓名取私聊双方消息，不含群聊");
    assert.equal(store.list({ chat: "%", limit: 10 }).length, 0, "通配符被转义");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
