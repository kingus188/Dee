import test from "node:test";
import assert from "node:assert/strict";
import { createTeamsInbox } from "@assistant/features";

test("查询先复用采集器刷新，失败明确返回缓存时间而非伪造最新待办", async () => {
  const order: string[] = [];
  let fails = false;
  const lastSuccessAt = "2026-01-01T01:00:00.000Z";
  const extension = createTeamsInbox({
    refresh: async () => { order.push("refresh"); if (fails) throw new Error("Graph unavailable"); return { ok: true, lastSuccessAt }; },
    syncStatus: () => ({ lastSuccessAt }),
    list: () => { order.push("list"); return []; },
  }) as unknown as { tools: { execute: (args: unknown) => Promise<{ content: { text: string }[] }> }[] };
  assert.match((await extension.tools[0].execute({ unreplied: true })).content[0].text, /已同步至/);
  assert.deepEqual(order, ["refresh", "list"]);
  fails = true;
  const stale = (await extension.tools[0].execute({ unreplied: true })).content[0].text;
  assert.match(stale, /本地缓存.*不能视为最新待办/);
  assert.match(stale, /2026/);
  assert.doesNotMatch(stale, /Graph unavailable/);
});
