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

test("无完整归档的旧缓存预览可恢复分块，已有分块随当前缓存刷新且不复活已消失的消息", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db);
    const row: TeamsMessageRow = { id: "chat:one", chatId: "chat", chatType: "oneOnOne", chatTopic: null, senderName: "甲", direction: "in", text: "缓存中的原话", createdAt: "2026-11-09T00:00:00Z", important: false, pushedAt: null, repliedAt: null };
    const parts = teamsPreviewParts(row);
    const preview = `同步时间\n${parts.prefix}未推送/未回复${parts.suffix}`;
    const restored = enrichTeamsRecordView(archive, "teams_messages", preview, {}, () => [row]);
    const parse = (text: string) => JSON.parse(text.match(/<teams-records>([^\n]*)<\/teams-records>/)![1]);
    assert.deepEqual(parse(restored).map((record: { text: string; direction: string }) => [record.text, record.direction]), [[row.text, "in"]]);
    const refreshed = enrichTeamsRecordView(archive, "teams_messages", restored, {}, () => [{ ...row, text: "更新的原话" }]);
    assert.equal(parse(refreshed)[0].text, "更新的原话");
    assert.deepEqual(parse(enrichTeamsRecordView(archive, "teams_messages", restored, {}, () => [])), []);
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

test("左右方向按归档账号身份计算，同名不认本人，缺少身份时明确未知", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db);
    const original = { chatId: "chat", id: "a", createdDateTime: "2026-11-09T00:00:00Z", from: { user: { id: "owner", displayName: "同名" } }, body: { content: "本人原话" } };
    assert.equal(teamsRecords(archive, [original])[0].direction, "unknown");
    archive.bindAccount("owner");
    const other = { ...original, id: "b", from: { user: { id: "other", displayName: "同名" } } };
    assert.deepEqual(teamsRecords(archive, [original, other, { ...original, from: undefined }]).map(record => record.direction), ["out", "in", "unknown"]);
    assert.notEqual(db.prepare("SELECT value FROM teams_archive_meta WHERE key='owner'").get()!.value, "owner", "不改变既有身份摘要存储");
  } finally { db.close(); }
});

test("旧记录标记只补充经原始账号核实的方向，保留内容与时间且不信任伪造方向", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db); archive.bindAccount("owner");
    const original = { chatId: "chat", id: "a", createdDateTime: "2026-11-09T00:00:00Z", from: { user: { id: "owner", displayName: "本人" } }, body: { content: "原话" } };
    archive.save("chat", [original]);
    const records = teamsRecords(archive, [original]).map(({ direction, ...record }) => record);
    const text = `资料\n<teams-records>${JSON.stringify([...records, { ...records[0], id: "missing", direction: "out" }])}</teams-records>`;
    const enriched = enrichTeamsRecordView(archive, "teams_history", text);
    const actual = JSON.parse(enriched.match(/<teams-records>([^\n]*)<\/teams-records>/)![1]);
    assert.deepEqual(actual[0], { ...records[0], direction: "out" });
    assert.equal(actual[1].direction, "unknown");
    assert.equal(enrichTeamsRecordView(archive, "not_teams", text), text);
    assert.equal(enrichTeamsRecordView(archive, "teams_history", "<teams-records>bad-json</teams-records>"), "<teams-records>bad-json</teams-records>");
  } finally { db.close(); }
});

test("历史工具快照随原消息更新，已撤回或失去访问权的记录不在 IM 区域复活", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const archive = openTeamsArchive(db);
    const original = { id: "one", createdDateTime: "2026-11-09T00:00:00Z", from: { user: { id: "other", displayName: "原发送者" } }, body: { content: "当前原文" } };
    archive.save("chat", [original]);
    const text = `<teams-records>${JSON.stringify([{ chatId: "chat", id: "one", sender: "旧姓名", text: "旧正文", createdAt: original.createdDateTime, media: [] }])}</teams-records>`;
    const read = () => JSON.parse(enrichTeamsRecordView(archive, "teams_messages", text).match(/<teams-records>([^\n]*)<\/teams-records>/)![1]);
    assert.equal(read()[0].text, "当前原文");
    assert.equal(read()[0].sender, "原发送者");
    db.exec("CREATE TABLE teams_chat_access(chat_id TEXT PRIMARY KEY,available INTEGER); INSERT INTO teams_chat_access VALUES ('chat',0)");
    assert.deepEqual(read(), []);
    db.exec("UPDATE teams_chat_access SET available=1");
    archive.save("chat", [{ ...original, deletedDateTime: "2026-11-09T00:01:00Z" }]);
    assert.deepEqual(read(), []);
  } finally { db.close(); }
});
