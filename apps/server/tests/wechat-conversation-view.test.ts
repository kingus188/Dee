import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationId, ConversationView } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import { WechatState } from "@assistant/channel-wechat";
import type { AppContext } from "../dist/application/context.js";
import { createViews } from "../dist/application/views.js";

test("会话视图从绑定与索引标注来源，不暴露微信接收方或改动通道状态", async () => {
  const index = { items: [{ id: 7, channel: "web" }, { id: 8, channel: "wechat" }], children: {} };
  const wechat = { bindings: { sample: { binding: "primary", wxid: "private-recipient-id", conversationId: 7 } }, cursors: { sample: 10 }, outbox: [] };
  const before = structuredClone({ index, wechat });
  const views = createViews({
    harness: { snapshot: async (definition: unknown) => definition === Index ? index : definition === WechatState ? wechat : undefined },
    taskGraph: { value: { tasks: {} } }, redact: String, teamsStore: { archive: {} },
  } as unknown as AppContext);
  const simplified = [];
  for (const id of [7, 8, 9]) simplified.push(await views.simplifyView(id as ConversationId, { entries: [], docs: {} } as unknown as ConversationView));
  assert.deepEqual(simplified.map(view => view.channel), ["wechat", "wechat", "web"]);
  assert.doesNotMatch(JSON.stringify(simplified), /private-recipient-id|primary|cursors|outbox/);
  assert.deepEqual({ index, wechat }, before, "读取展示元数据不得更改绑定、游标或发件箱");
});
