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
