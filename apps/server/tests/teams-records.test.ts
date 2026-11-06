import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openTeamsArchive } from "../dist/teams-archive-store.js";
import { teamsOriginalText, teamsRecords, enrichTeamsRecordView } from "../dist/teams-records.js";
import { teamsPreviewParts, type TeamsMessageRow } from "@assistant/features";

test("原文提取保留段落、原字句、Unicode 和完整长度，文本消息不当作 HTML", () => {
  const text = '原话\n不是截图解读\n甲 & 乙 😀';
  assert.equal(teamsOriginalText({ id: "1", createdDateTime: "2026-01-01", body: { contentType: "html", content: '<p>原话</p><p>不是截图解读<br>甲 &amp; 乙 &#x1f600;</p><img src="https://evil.example/track">' } }), text);
  const full = "真实内容".repeat(2000);
  assert.equal(teamsOriginalText({ id: "1", createdDateTime: "2026-01-01", body: { contentType: "text", content: full } }), full);
  assert.equal(teamsOriginalText({ id: "1", createdDateTime: "2026-01-01", body: { contentType: "text", content: "<p>用户亲口输入的文本</p>" } }), "<p>用户亲口输入的文本</p>");
});

test("旧预览按原时间、发送人和原文唯一关联，状态变化不影响；同时间同原文有歧义时不猜", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db);
    const message = { id: "one", createdDateTime: "2026-01-01T00:00:00Z", from: { user: { displayName: "甲" } }, body: { content: "原文".repeat(500) } };
    archive.save("chat",[message]);
    const row: TeamsMessageRow = { id: "chat:one", chatId: "chat", chatType: "oneOnOne", chatTopic: null, senderName: "甲", direction: "in", text: message.body.content, createdAt: message.createdDateTime, important: false, pushedAt: null, repliedAt: null };
    const parts=teamsPreviewParts(row),old='同步时间\n'+parts.prefix+'已推送/已回复'+parts.suffix;
    const restored=enrichTeamsRecordView(archive,"teams_messages",old,{},()=>[row]);
    const records=JSON.parse(restored.match(/<teams-records>([^\n]*)<\/teams-records>/)![1]);
    assert.equal(records.length,1);assert.equal(records[0].text,message.body.content);
    const ambiguous=enrichTeamsRecordView(archive,"teams_messages",old,{},()=>[row,{...row,id:"chat:two"}]);
    assert.doesNotMatch(ambiguous,/<teams-records>/);
    assert.doesNotMatch(enrichTeamsRecordView(archive,"teams_messages",old.replace('原文','别的话'),{},()=>[row]),/<teams-records>/);
  } finally { db.close(); }
});

test("每张图只关联原消息，姓名与时间取原始字段，不生成图片解释", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db); archive.chats([{ id: "chat", topic: "真实聊天" }]);
    const a = { chatId: "chat", id: "a", createdDateTime: "2026-01-01T00:00:00Z", from: { user: { displayName: "发送者甲" } }, body: { content: "第一条原话" } };
    const b = { ...a, id: "b", from: { user: { displayName: "发送者乙" } }, body: { content: "第二条原话" } };
    archive.save("chat", [a,b]); archive.hosted("chat", "a", ["image-a"]);
    const records = teamsRecords(archive, [a,b]);
    assert.equal(records[0].sender, "发送者甲"); assert.equal(records[1].sender, "发送者乙");
    assert.equal(records[0].media.length, 1); assert.equal(records[1].media.length, 0);
    assert.equal(records[0].text, a.body.content); assert.equal(records[0].createdAt, a.createdDateTime);
    const old = '第三方资料\n'+JSON.stringify({ items: [b] })+'\n<teams-media>[]</teams-media>';
    const restored = enrichTeamsRecordView(archive, "teams_history", old, { chatId: "chat" });
    const view = JSON.parse(restored.match(/<teams-records>([^\n]*)<\/teams-records>/)![1]);
    assert.deepEqual(view.map((m: { id: string }) => m.id), ["b"], "只恢复该次查询实际返回的消息，不能补进别的消息");
    assert.doesNotMatch(restored, /<teams-media>/);
    assert.equal(enrichTeamsRecordView(archive, "teams_history", '资料\n'+JSON.stringify({ items: [{ ...a, id: "not-in-archive" }] }), { chatId: "chat" }).includes("<teams-records>"), false);
  } finally { db.close(); }
});
