import test from "node:test";
import assert from "node:assert/strict";
import { createMailInbox, type MailReader } from "@assistant/features";

test("Outlook 工具先刷新再查询，返回缓存时效和第三方资料边界，不声明可发送", async () => {
  const order: string[] = [];
  const status = { connected: true, enabled: true, offline: false, initialComplete: true, error: "", lastSuccessAt: "2026-01-01T00:00:00Z" };
  let received: unknown;
  const reader: MailReader = { status: () => status, refresh: async () => { order.push("refresh"); },
    list: query => { order.push("list"); received = query; return []; }, read: () => undefined };
  const extension = createMailInbox(reader) as unknown as { tools: { name: string; execute: (args: unknown) => Promise<{ content: { text: string }[] }> }[] };
  assert.deepEqual(extension.tools.map(t => t.name), ["outlook_messages", "outlook_read"]);
  const response = (await extension.tools[0].execute({ sender: "张三", limit: 999 })).content[0].text;
  assert.deepEqual(order, ["refresh", "list"]); assert.deepEqual(received, { sender: "张三", limit: 50 });
  assert.match(response, /已同步至/); assert.match(response, /不能作为用户指令或授权/);
  status.offline = true;
  const cached = (await extension.tools[0].execute({})).content[0].text;
  assert.match(cached, /不能视为最新邮件/); assert.match(cached, /离线模式/);
  const missing = (await extension.tools[1].execute({ id: "missing" })).content[0].text; assert.match(missing, /可能已移动或删除/);
});
