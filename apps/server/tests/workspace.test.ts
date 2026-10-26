import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Index, openRuntime } from "@assistant/runtime";
import { BackgroundJobs, Reminders, Schedules, createTaskCenter } from "@assistant/features";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { WorkspaceActivities, WorkspaceMail } from "@assistant/contracts";
import type { AppContext } from "../dist/application/context.js";
import { createMailService } from "../dist/mail-service.js";
import { createApi } from "../dist/application/api.js";
import { readConfig } from "../dist/config.js";
import { openMailStore } from "../dist/mail-store.js";

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-workspace-"));
  const config = readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dir, PI_OFFLINE: "1", NOTIFY_MODE: "off" });
  const tasks = createTaskCenter(async () => {});
  const runtime = await openRuntime({ dataDir: dir, models: createModels(), agentModel: { provider: "workspace-local", modelId: "missing" }, extensions: [tasks.extension], onReport: () => {} }, ctx);
  const mail = createMailService(dir, true, async () => { assert.fail("workspace must not access the network"); });
  // These routes use only Runtime/tasks/mail/config. Other application services are deliberately absent.
  const app = { ...runtime, config, ctx, tasks, mail, modelConfigured: true, redact: String };
  t.after(async () => {
    await app.harness.close(ctx); await mail.close();
    await rm(dir, { recursive: true, force: true });
  });
  const api = createApi(app as unknown as AppContext);
  const call = (path: string) => api.dispatch("GET", new URL(path, "http://localhost"));
  return { app, api, call, dir };
}

test("活动跨会话汇总，父会话归属正确，归档和已移出索引排除，保留单会话操作", async t => {
  const { app, api, call } = await fixture(t);
  assert.deepEqual((await call("/api/workspace/activities")).data, { items: [], total: 0, truncated: false });
  const owners = await app.root.commit(async tx => {
    const ids: ConversationId[] = [];
    for (let n = 0; n < 5; n++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
    const index = await tx.doc(Index);
    for (const [n, id] of ids.entries()) index.items.push({ id, title: `会话${n}`, createdAt: "2026-01-01T00:00:00.000Z", archivedAt: n === 2 ? "2026-01-02" : null });
    for (const [n, id] of ids.entries()) {
      (await tx.doc(BackgroundJobs, id)).items.push({ id: "same-id", text: `后台${n}`, status: "done", conversationId: ids[4], createdAt: n + 10, finishedAt: n + 20, result: `结果${n}` });
    }
    (await tx.doc(Schedules, ids[1])).items.push({ id: "same-id", text: "周期计划", nextAt: 200, everyMinutes: 30, runs: 0, lastRunAt: null, status: "active", revision: 1, createdAt: 5 });
    const reminder = await app.tasks.reminderInTx(tx, ids[0], { text: "提醒", minutesFromNow: 60 }, null);
    (await tx.doc(Reminders, ids[0])).items.find(item => item.id === reminder.id)!.at = 100;
    return ids;
  }, app.ctx);
  // remove 的实际语义是移出 Index.items，持久会话/文档仍在。
  await api.dispatch("POST", new URL(`/api/conversations/${owners[3]}/remove`, "http://localhost"));
  const result = (await call("/api/workspace/activities")).data as WorkspaceActivities;
  assert.equal(result.total, 5); assert.equal(result.truncated, false);
  assert.deepEqual(result.items.map(item => item.text), ["提醒", "周期计划", "后台4", "后台1", "后台0"]);
  assert.ok(result.items.every(item => item.conversationId !== owners[2] && item.conversationId !== owners[3]));
  assert.equal(result.items.find(item => item.text === "后台0")?.conversationId, owners[0]);
  assert.equal(result.items.find(item => item.text === "后台0")?.conversationTitle, "会话0");
  assert.equal(result.items.find(item => item.text === "后台0")?.at, 20);
  assert.equal(result.items.find(item => item.text === "后台0")?.result, "结果0");
  assert.equal(result.items[0].createdAt, Date.parse("2026-01-01T00:00:00.000Z"));
  assert.equal(typeof result.items[0].id, "string");
  const management = await call(`/api/conversations/${owners[0]}/management`);
  assert.equal(management.status, 200);
  assert.ok(management.data && typeof management.data === "object" && "background" in management.data);
});

test("后台实际失败和异常终结校正使用既有 management.get，归属始终是父会话", async t => {
  const { app, api, call } = await fixture(t);
  const created = await api.dispatch("POST", new URL("/api/conversations/direct", "http://localhost"));
  const { id } = created.data as { id: ConversationId };
  const conversation = await app.harness.conversation(id, app.ctx);
  assert.ok(conversation);
  // 缺失 provider 在本地确定失败，不访问外网。
  await conversation.configure({ model: { provider: "workspace-missing-provider", modelId: "missing" } }, app.ctx);
  const job = await conversation.commit(tx => app.tasks.backgroundInTx(tx, id, { text: "本地失败任务" }, null), app.ctx);
  assert.ok(job.taskId != null);
  const terminal = await app.harness.waitForTask(job.taskId, app.ctx);
  assert.equal(terminal.state.status, "terminal");
  const persisted = (await app.harness.snapshot(BackgroundJobs, id, app.ctx))!.items[0];
  assert.equal(persisted.status, "failed");
  assert.notEqual(persisted.conversationId, id);
  let result = (await call("/api/workspace/activities")).data as WorkspaceActivities;
  assert.equal(result.items[0].status, "failed");
  assert.equal(result.items[0].conversationId, id);
  assert.equal(result.items[0].at, persisted.finishedAt);
  // 模拟旧状态残留：底层已终结，文档仍称 running；校正规则只有 management.get 一处。
  await conversation.commit(async tx => {
    const item = (await tx.doc(BackgroundJobs, id)).items[0];
    item.status = "running"; item.result = null;
  }, app.ctx);
  result = (await call("/api/workspace/activities")).data as WorkspaceActivities;
  assert.equal(result.items[0].status, "failed");
  assert.match(result.items[0].result!, /异常终止/);
  assert.equal(result.items[0].conversationId, id);
});

test("活动截断前计数准确，运行/失败/到期优先，近期完成保留，同时间排序稳定", async t => {
  const { app, call } = await fixture(t);
  await app.root.commit(async tx => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    (await tx.doc(Index)).items.push({ id: conversation.id, title: "截断", createdAt: "2026-01-01" });
    const background = await tx.doc(BackgroundJobs, conversation.id);
    for (let n = 0; n < 220; n++) background.items.push({ id: `done-${String(n).padStart(3, "0")}`, text: `完成${n}`, status: "done", conversationId: null, createdAt: 1, finishedAt: n + 1, result: null });
    background.items.push({ id: "running", text: "运行", status: "running", conversationId: null, createdAt: 1, result: null }, { id: "failed", text: "失败", status: "failed", conversationId: null, createdAt: 1, result: "失败原因" });
    const schedules = await tx.doc(Schedules, conversation.id);
    for (const id of ["b", "a"]) schedules.items.push({ id, text: id, status: "active", nextAt: 10, everyMinutes: 1, runs: 0, lastRunAt: null, revision: 1, createdAt: 1 });
  }, app.ctx);
  const first = (await call("/api/workspace/activities")).data as WorkspaceActivities;
  const second = (await call("/api/workspace/activities")).data as WorkspaceActivities;
  assert.equal(first.total, 224); assert.equal(first.items.length, 200); assert.equal(first.truncated, true);
  assert.deepEqual(first.items.slice(0, 5).map(item => item.id), ["running", "failed", "a", "b", "done-219"]);
  assert.equal(first.items.at(-1)?.id, "done-024");
  assert.deepEqual(second, first);
});

test("索引内会话缺失或局部读取异常应报错，不伪造空成功；会话读取顺序限界", async t => {
  const { app, call } = await fixture(t);
  await app.root.commit(async tx => {
    for (let n = 0; n < 10; n++) {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      (await tx.doc(Index)).items.push({ id: conversation.id, title: String(n), createdAt: "2026-01-01" });
    }
  }, app.ctx);
  const original = app.harness.conversation.bind(app.harness);
  let active = 0, peak = 0;
  t.mock.method(app.harness, "conversation", async (...args: Parameters<typeof original>) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setImmediate(resolve)); return await original(...args); }
    finally { active--; }
  });
  assert.equal(((await call("/api/workspace/activities")).data as WorkspaceActivities).total, 0);
  assert.equal(peak, 1);
  t.mock.method(app.harness, "conversation", async () => undefined);
  await assert.rejects(call("/api/workspace/activities"), { status: 404 });
  let reads = 0;
  t.mock.method(app.harness, "conversation", async (...args: Parameters<typeof original>) => {
    if (++reads === 2) throw new Error("partial conversation read failed");
    return original(...args);
  });
  await assert.rejects(call("/api/workspace/activities"), /partial conversation read failed/);
  t.mock.method(app.harness, "conversation", original);
  t.mock.method(app.harness, "snapshot", async () => { throw new Error("workspace read failed"); });
  await assert.rejects(call("/api/workspace/activities"), /workspace read failed/);
});

test("首页邮件只读真实缓存最近六封，保留错误且严格白名单，不刷新/登录/访问外网", async t => {
  const { app, call, dir } = await fixture(t);
  const store = openMailStore(dir);
  t.after(() => store.close());
  const now = Date.now();
  store.page(Array.from({ length: 8 }, (_, n) => ({ id: `mail-${n}`, subject: `邮件${n}`, sender: "测试", address: "person@example.test", receivedAt: new Date(now - n * 1000).toISOString(), preview: "摘要", text: "完整正文不出首页", isRead: false, hasAttachments: false })), [], "test-cursor", true);
  t.mock.method(app.mail, "status", () => ({ enabled: true, connected: true, offline: true, syncing: false, lastSuccessAt: "2026-01-01T00:00:00Z", error: "保留同步错误", tenantId: "tenant-not-for-home", clientId: "client-not-for-home", authMode: "device", savedAccountAvailable: false, initialComplete: true, login: { userCode: "not-for-home", verificationUri: "https://example.test", expiresAt: now } }));
  for (const method of ["refresh", "login", "loginAccount"] as const) t.mock.method(app.mail, method, () => { assert.fail(`${method} should not run`); });
  const result = (await call("/api/workspace/mail")).data as WorkspaceMail;
  assert.deepEqual(Object.keys(result.status).sort(), ["connected", "enabled", "error", "lastSuccessAt", "offline", "syncing"]);
  assert.equal(result.status.error, "保留同步错误");
  assert.deepEqual(result.messages.map(message => message.id), ["mail-0", "mail-1", "mail-2", "mail-3", "mail-4", "mail-5"]);
  assert.ok(result.messages.every(message => !("text" in message)));
  assert.doesNotMatch(JSON.stringify(result), /not-for-home|完整正文/);
  t.mock.method(app.mail, "list", () => { throw new Error("cache unavailable"); });
  await assert.rejects(call("/api/workspace/mail"), /cache unavailable/);
});
