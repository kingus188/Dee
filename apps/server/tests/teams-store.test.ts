import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("按名称找聊天、草稿按会话和聊天取最新版、旧版不能复活", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-store-"));
  const store = openTeamsStore(directory);
  try {
    store.record({ ...base, id: "p:1", chatId: "p", senderName: "张三", createdAt: at(30) });
    store.record({ ...base, id: "p2:1", chatId: "p2", senderName: "张三丰", createdAt: at(29) });
    store.record({ ...base, id: "g:1", chatId: "g", chatType: "group", senderName: "李四", chatTopic: "项目群", createdAt: at(28) });
    assert.deepEqual(store.findChats("张三").map(chat => chat.label), ["私聊「张三」"], "完全同名优先");
    assert.equal(store.findChats("张").length, 2, "模糊匹配多个时全部返回，由调用方要求指明");
    assert.deepEqual(store.findChats("项目").map(chat => chat.chatId), ["g"]);
    assert.deepEqual(store.findChats("不存在"), []);

    const first = store.saveDraft({ conversationId: 1, chatId: "p", label: "私聊「张三」", text: "旧稿", explicit: false, sourceEntryId: 1 });
    const second = store.saveDraft({ conversationId: 1, chatId: "p", label: "私聊「张三」", text: "新稿", explicit: true, sourceEntryId: 2 });
    store.saveDraft({ conversationId: 2, chatId: "g", label: "群聊「项目群」", text: "别的会话", explicit: false, sourceEntryId: 3 });
    assert.equal(store.pendingDrafts(1, 60_000)[0]?.text, "新稿");
    assert.deepEqual([store.pendingDrafts(1, 60_000)[0]?.explicit], [true], "explicit 标记随草稿保存");
    assert.equal(store.pendingDrafts(3, 60_000)[0], undefined);
    assert.equal(store.claim(first, 1, 60_000), false, "旧版本不能占用");
    assert.equal(store.claim(second, 2, 60_000), false, "不能跨会话占用");
    assert.equal(store.claim(second, 1, 60_000), true);
    assert.equal(store.claim(second, 1, 60_000), false, "已占用的草稿不能再发");
    assert.equal(store.pendingDrafts(1, 60_000)[0], undefined, "新稿已发出，旧稿不能重新成为待发送稿");
    store.release(second);
    assert.equal(store.pendingDrafts(1, 60_000)[0]?.id, second, "失败释放后可重试");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("已回复检测：我在最近一次来信之后发过消息才算已回复", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-store-"));
  const store = openTeamsStore(directory);
  try {
    store.record({ ...base, id: "r:1", chatId: "r", createdAt: at(30) });
    assert.equal(store.alreadyReplied("r"), undefined, "只有来信，没回复");
    store.record({ ...base, id: "r:2", chatId: "r", direction: "out", senderId: "me", senderName: "我", text: "好的", createdAt: at(20), important: false });
    assert.equal(store.alreadyReplied("r")?.text, "好的");
    store.record({ ...base, id: "r:3", chatId: "r", createdAt: at(10), text: "又来一条" });
    assert.equal(store.alreadyReplied("r"), undefined, "对方又来新消息后，之前的回复不再算");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("草稿重放复用 ID，持久化授权来源，过期与新版本检查包含在原子占用中", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-drafts-"));
  let store = openTeamsStore(directory);
  try {
    const input = { conversationId: 1, chatId: "p", label: "私聊「张三」", text: "原文", explicit: true, sourceEntryId: 10 };
    const id = store.saveDraft(input);
    assert.equal(store.saveDraft(input), id);
    assert.equal(store.pendingDrafts(1, 60_000)[0].sourceEntryId, 10);
    assert.equal(store.claim(id, 1, 60_000), true);
    assert.equal(store.saveDraft(input), id, "发送后重放起草不能产生新的可发送副本");
    assert.deepEqual(store.pendingDrafts(1, 60_000), []);
    store.close();
    store = openTeamsStore(directory);
    assert.equal(store.saveDraft(input), id, "重启后仍防重放");
    store.release(id);
    const next = store.saveDraft({ ...input, sourceEntryId: 20, text: "新版" });
    assert.equal(store.claim(id, 1, 60_000), false, "检查后被新版替换也不能发送");
    const other = store.saveDraft({ ...input, chatId: "g", label: "群聊「项目群」" });
    assert.deepEqual(store.pendingDrafts(1, 60_000).map(d => d.id), [other, next], "不同目标同时保留供消歧");
    const db = new DatabaseSync(join(directory, "agent.sqlite"));
    try { db.prepare("UPDATE teams_drafts SET created_at = ? WHERE id = ?").run(at(31), next); } finally { db.close(); }
    assert.equal(store.claim(next, 1, 30 * 60_000), false, "占用也检查有效期");
    assert.deepEqual(store.pendingDrafts(1, 30 * 60_000).map(d => d.id), [other], "新版过期后不能复活旧版");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("旧库迁移保留草稿但不伪造授权来源，同名聊天匹配不能被模糊结果覆盖", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-migrate-"));
  const db = new DatabaseSync(join(directory, "agent.sqlite"));
  db.exec(`CREATE TABLE teams_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT)`);
  db.prepare("INSERT INTO teams_drafts (conversation_id, chat_id, label, text, created_at) VALUES (1, 'p', '私聊「张三」', '旧稿', ?)").run(at(1));
  db.close();
  const store = openTeamsStore(directory);
  try {
    const draft = store.pendingDrafts(1, 60 * 60_000)[0];
    assert.equal(draft.sourceEntryId, null);
    assert.equal(draft.explicit, false);
    for (const [id, senderName] of [["a", "Haibo Sun"], ["b", "Haibo Sun"], ["c", "Haibo Sun Jr"]]) {
      store.record({ ...base, id, chatId: id, senderName, createdAt: at(1) });
    }
    assert.deepEqual(new Set(store.findChats("haibo sun").map(chat => chat.chatId)), new Set(["a", "b"]));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("回复状态不依赖入库顺序，已回复消息永不进入待推送", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-order-"));
  let store = openTeamsStore(directory);
  try {
    const inbound = { ...base, id: "c1:late", createdAt: at(20) };
    store.record({ ...base, id: "c1:reply", direction: "out", createdAt: at(10), important: false });
    store.record(inbound);
    assert.equal(store.list({ unreplied: true, limit: 10 }).length, 0);
    assert.equal(store.pendingPush().length, 0);
    store.record({ ...base, id: "c2:in", chatId: "c2", createdAt: at(20) });
    store.record({ ...base, id: "c2:out", chatId: "c2", direction: "out", createdAt: at(10), important: false });
    assert.equal(store.pendingPush().length, 0);
    store.close();
    const db = new DatabaseSync(join(directory, "agent.sqlite"));
    db.exec("UPDATE teams_messages SET replied_at = NULL WHERE direction = 'in'");
    db.close();
    store = openTeamsStore(directory);
    assert.equal(store.list({ unreplied: true, limit: 10 }).length, 0, "旧库矛盾状态在重开时修复");
    store.record({ ...base, id: "c1:new", createdAt: at(1) });
    assert.deepEqual(store.pendingPush().map(x => x.id), ["c1:new"], "回复后新来信仍保留");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("消息入库与回复归一同事务：修复失败不能留下跳过修复的半条回执", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-atomic-"));
  const store = openTeamsStore(directory);
  const probe = new DatabaseSync(join(directory, "agent.sqlite"));
  try {
    store.record({ ...base, id: "before", createdAt: at(20) });
    probe.exec("CREATE TRIGGER fail_reply BEFORE UPDATE OF replied_at ON teams_messages BEGIN SELECT RAISE(FAIL, 'test repair failure'); END");
    const outbound = { ...base, id: "reply", direction: "out" as const, createdAt: at(10), important: false };
    assert.throws(() => store.record(outbound), /test repair failure/);
    assert.equal(store.message("reply"), undefined);
    probe.exec("DROP TRIGGER fail_reply");
    store.record(outbound);
    assert.ok(store.message("before")?.repliedAt);
    assert.equal(store.pendingPush().length, 0);
  } finally { probe.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("工作状态自动代回：到期失效、同状态期只回一次、代回不算已回复", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-teams-away-"));
  const store = openTeamsStore(directory);
  try {
    assert.equal(store.away(), undefined);
    store.setAway({ status: "出差中", reply: "我在出差，晚些回你", until: at(-60) });
    const away = store.away()!;
    assert.equal(away.status, "出差中");

    store.record({ ...base, id: "c1:in", createdAt: at(5) });
    assert.equal(store.autoRepliedIn("c1", away.version), false);
    // 代发的安抚语先入库（和真实发送顺序一致），登记后来信必须回到未回复。
    store.record({ ...base, id: "c1:auto", direction: "out", senderId: "me", senderName: "我", text: away.reply, createdAt: at(4), important: false });
    assert.ok(store.message("c1:in")?.repliedAt, "入库瞬间会被当成已回复");
    store.recordAutoReply("c1", "c1:auto", away.version);
    assert.equal(store.message("c1:in")?.repliedAt, null, "登记为代回后不再算已回复");
    assert.equal(store.autoRepliedIn("c1", away.version), true);
    assert.deepEqual(store.pendingPush().map(x => x.id), ["c1:in"], "代回后仍留在未回复清单");

    // 用户本人回复仍然标记已回复。
    store.record({ ...base, id: "c1:me", direction: "out", senderId: "me", senderName: "我", text: "收到", createdAt: at(3), important: false });
    assert.ok(store.message("c1:in")?.repliedAt);

    // 换状态后可以再代回一次；到期后状态自动失效。
    store.setAway({ status: "全天会议", reply: "开会中，散会回你", until: at(-60) });
    assert.equal(store.autoRepliedIn("c1", store.away()!.version), false);
    store.setAway({ status: "出差中", reply: "我在出差", until: at(1) });
    assert.equal(store.away(), undefined, "到点即失效，用户不再交代就按正常流程处理");
    store.setAway({ status: "出差中", reply: "我在出差", until: at(-60) });
    store.clearAway();
    assert.equal(store.away(), undefined);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
