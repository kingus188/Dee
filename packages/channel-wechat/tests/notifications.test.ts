import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { notificationForAnswer } from "../dist/notifications.js";

test("一个回答关联多条自动提醒；同轮混入普通用户输入时不整条撤销", async () => {
  const conversationId = 7 as ConversationId;
  const user = (id: number) => ({ id, kind: "pi.user" });
  const boundary = { id: 5, kind: "pi.assistant", model: [{ content: [{ type: "text", text: "上轮回答" }] }] };
  let entries = [user(20), user(10), boundary];
  const tx = {
    doc: async () => ({ items: [10, 20].map(id => ({ conversationId, requestId: String(id), source: { kind: "teams", messageIds: [String(id)] } })) }),
    submissionByRequest: async (_conversation: number, id: string) => ({ type: "input", status: "done", entry: Number(id), answer: 30 }),
    scanEntries: async () => ({ items: entries }),
  } as unknown as Tx;
  assert.deepEqual(await notificationForAnswer(tx, conversationId, 30), { kind: "teams", messageIds: ["10", "20"] });
  assert.equal(await notificationForAnswer(tx, conversationId, 31), undefined, "不能关联到下一轮回答");
  entries = [user(20), user(10), user(8), boundary];
  assert.equal(await notificationForAnswer(tx, conversationId, 30), undefined, "提醒前的普通输入不能被误撤销");
  entries = [user(25), user(20), user(10), boundary];
  assert.equal(await notificationForAnswer(tx, conversationId, 30), undefined, "提醒后的普通输入不能被误撤销");
});
