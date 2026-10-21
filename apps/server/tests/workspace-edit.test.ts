import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notes, Reminders, Schedules } from "@assistant/features";
import type { MemoryItem, SkillItem, Reminder, Schedule } from "@assistant/features";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PersonalData } from "@assistant/contracts";
import { createApplication } from "../dist/application/index.js";
import { createApi } from "../dist/application/api.js";
import { readConfig } from "../dist/config.js";
import { startServer } from "../dist/index.js";

test("固定页面编辑持久化，拒绝过期版本，并真实替换调度任务", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-workspace-edit-"));
  const config = readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: data, NOTIFY_MODE: "off", PI_OFFLINE: "1" });
  let app = await createApplication(config);
  async function close() {
    app.wechat?.stop(); app.taskGraph.dispose();
    await app.harness.close(app.ctx);
    await app.mail.close(); await app.businessDatabase.end(); app.modelSettings.close(); app.wechatSettings.close(); app.teamsStore.close(); app.episodeStore.close();
  }
  try {
    let api = createApi(app);
    const call = (method: string, path: string, body: Record<string, unknown> = {}) => api.dispatch(method, new URL(path, "http://localhost"), body);
    // dispatch 的返回联合未按路由细化；此处断言已知的内部路由契约。
    const chat = (await call("POST", "/api/conversations/direct")).data as { id: ConversationId };
    const path = `/api/conversations/${chat.id}`;
    const empty = { todos: [], memos: [] };
    const edited = { todos: [], memos: ["# 备忘\n\n第一段"] };
    assert.deepEqual((await call("GET", path + "/notes")).data, empty);
    assert.deepEqual((await call("POST", path + "/notes", { notes: edited, base: empty })).data, edited);
    const conversation = await app.harness.conversation(chat.id, app.ctx);
    await conversation!.commit(async tx => {
      const notes = await tx.doc(Notes, conversation!.id);
      notes.applied["model-call"] = "模型已处理";
      notes.memos.push("模型新增");
    }, app.ctx);
    await assert.rejects(call("POST", path + "/notes", { notes: empty, base: edited }), { status: 409 });
    assert.equal((await app.harness.snapshot(Notes, conversation!.id, app.ctx))?.applied["model-call"], "模型已处理");
    assert.deepEqual((await call("GET", path + "/notes")).data, { ...edited, memos: [...edited.memos, "模型新增"] });
    for (const notes of [{ todos: [{ text: "x", done: "false" }], memos: [] }, { ...empty, memos: Array(1001).fill("x") }, { ...empty, memos: ["x".repeat(16001)] }, { ...empty, memos: Array(9).fill("x".repeat(16000)) }]) {
      await assert.rejects(call("POST", path + "/notes", { notes, base: empty }), { status: 400 });
    }
    await assert.rejects(call("GET", `/api/conversations/${app.root.id}/notes`), { status: 404 });

    const memoryResponse = (await call("POST", "/api/personal/memory", { text: "# 偏好\n\n- 简短\n- 保留换行" })).data as { item: MemoryItem };
    const memory = memoryResponse.item;
    const memoryPath = `/api/personal/memory/${memory.id}/edit`;
    const memoryEditResponse = (await call("POST", memoryPath, { text: "# 偏好\n\n- 先结论", base: memory })).data as { item: MemoryItem };
    const memoryEdited = memoryEditResponse.item;
    assert.equal(memoryEdited.text, "# 偏好\n\n- 先结论");
    assert.equal(memoryEdited.status, "approved");
    await assert.rejects(call("POST", memoryPath, { text: "过期覆盖", base: memory }), { status: 409 });
    await call("POST", memoryPath, { text: memoryEdited.text });
    const skillResponse = (await call("POST", "/api/personal/skills", { name: "发布", description: "部署时", body: "# 步骤\n\n1. 准备" })).data as { item: SkillItem };
    const skill = skillResponse.item;
    const skillPath = `/api/personal/skills/${skill.id}`;
    const skillEditResponse = (await call("POST", skillPath + "/edit", { name: "发布检查", description: "上线前", body: "# 步骤\n\n1. 检查", base: skill })).data as { item: SkillItem };
    const skillEdited = skillEditResponse.item;
    assert.equal(skillEdited.name, "发布检查");
    assert.equal(skillEdited.status, skill.status);
    await assert.rejects(call("POST", skillPath + "/edit", { ...skill, base: skill }), { status: 409 });
    await call("POST", "/api/personal/skills", { name: "重名", description: "说明", body: "正文" });
    await assert.rejects(call("POST", skillPath + "/edit", { name: "重名", description: "说明", body: "正文", base: skillEdited }), { status: 400 });

    const reminderResponse = (await call("POST", path + "/reminders", { text: "原提醒", minutesFromNow: 30, requestId: "reminder-create" })).data as { item: Reminder };
    const reminder = reminderResponse.item;
    const duplicateResponse = (await call("POST", path + "/reminders", { text: "原提醒", minutesFromNow: 30, requestId: "reminder-create" })).data as { item: Reminder };
    const duplicate = duplicateResponse.item;
    assert.equal(duplicate.id, reminder.id);
    await assert.rejects(call("POST", path + `/reminders/${reminder.id}/edit`, { text: "", minutesFromNow: 60, at: reminder.at }), { status: 400 });
    assert.equal((await app.harness.snapshot(Reminders, conversation!.id, app.ctx))?.items.find(item => item.id === reminder.id)?.status, "scheduled");
    const replacementResponse = (await call("POST", path + `/reminders/${reminder.id}/edit`, { text: "新提醒", minutesFromNow: 60, at: reminder.at })).data as { item: Reminder };
    const replacement = replacementResponse.item;
    assert.notEqual(replacement.id, reminder.id);
    assert.equal((await app.harness.getTask(reminder.id, app.ctx))?.abortRequested, true);
    const replacementTask = await app.harness.getTask(replacement.id, app.ctx);
    assert.deepEqual(replacementTask?.input, { text: "新提醒", at: replacement.at });
    await assert.rejects(call("POST", path + `/reminders/${reminder.id}/edit`, { text: "过期", minutesFromNow: 60, at: reminder.at }), { status: 409 });
    await assert.rejects(call("POST", path + `/reminders/${replacement.id}/edit`, { text: "过期", minutesFromNow: 60, at: replacement.at - 1 }), { status: 409 });

    const scheduleResponse = (await call("POST", path + "/schedules", { text: "原计划", minutesFromNow: 30 })).data as { item: Schedule };
    const schedule = scheduleResponse.item;
    const changedResponse = (await call("POST", path + `/schedules/${schedule.id}/edit`, { text: "新计划", minutesFromNow: 60, everyMinutes: 90, revision: schedule.revision })).data as { item: Schedule };
    const changed = changedResponse.item;
    assert.notEqual(changed.jobId, schedule.jobId);
    assert.ok(schedule.jobId != null && changed.jobId != null);
    assert.equal((await app.harness.getTask(schedule.jobId, app.ctx))?.abortRequested, true);
    assert.deepEqual((await app.harness.getTask(changed.jobId, app.ctx))?.input, { scheduleId: schedule.id, text: "新计划", at: changed.nextAt, revision: changed.revision });
    await assert.rejects(call("POST", path + `/schedules/${schedule.id}/edit`, { text: "过期", minutesFromNow: 60, revision: schedule.revision }), { status: 409 });
    await assert.rejects(call("POST", path + `/schedules/${schedule.id}/edit`, { text: "", minutesFromNow: 60, revision: changed.revision }), { status: 400 });
    assert.equal((await app.harness.snapshot(Schedules, conversation!.id, app.ctx))?.items.find(item => item.id === schedule.id)?.jobId, changed.jobId);
    const other = (await call("POST", "/api/conversations")).data as { id: number };
    await assert.rejects(call("POST", `/api/conversations/${other.id}/reminders/${replacement.id}/edit`, { text: "越界", minutesFromNow: 60, at: replacement.at }), { status: 404 });
    await assert.rejects(call("POST", `/api/conversations/${other.id}/schedules/${schedule.id}/edit`, { text: "越界", minutesFromNow: 60, revision: changed.revision }), { status: 404 });

    const offlineApi = createApi({ ...app, modelConfigured: false });
    const offline = (method: string, suffix: string, body: Record<string, unknown> = {}) => offlineApi.dispatch(method, new URL(suffix, "http://localhost"), body);
    await offline("POST", "/api/conversations/direct");
    const current = (await offline("GET", path + "/notes")).data;
    await offline("POST", path + "/notes", { notes: edited, base: current });
    for (const suffix of ["/messages", "/schedules", "/reminders", "/background"]) await assert.rejects(offline("POST", path + suffix, {}), { status: 409 });

    await close();
    app = await createApplication(config); api = createApi(app);
    assert.deepEqual((await call("GET", path + "/notes")).data, edited);
    assert.equal((await app.harness.snapshot(Notes, conversation!.id, app.ctx))?.applied["model-call"], "模型已处理");
    const personal = (await call("GET", "/api/personal")).data as PersonalData;
    assert.equal(personal.memory.find(item => item.id === memory.id)?.text, memoryEdited.text);
    assert.equal(personal.skills.find(item => item.id === skill.id)?.body, skillEdited.body);
    assert.equal((await app.harness.snapshot(Reminders, conversation!.id, app.ctx))?.items.find(item => item.id === replacement.id)?.text, "新提醒");
    assert.equal((await app.harness.snapshot(Schedules, conversation!.id, app.ctx))?.items.find(item => item.id === schedule.id)?.jobId, changed.jobId);
    await call("POST", skillPath + "/reject");
    await assert.rejects(call("POST", skillPath + "/edit", { name: "状态冲突", description: "说明", body: "正文", base: skillEdited }), { status: 409 });
    await assert.rejects(call("POST", skillPath + "/edit", { name: "不能修改", description: "说明", body: "正文" }), { status: 400 });
  } finally { await close(); await rm(data, { recursive: true, force: true }); }
});

test("HTTP 笔记接口支持完整正文和 base，不放宽其它接口大小限制", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-notes-http-"));
  const config = readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: data, PORT: "0", NOTIFY_MODE: "off", PI_OFFLINE: "1" });
  const service = await startServer(config, "127.0.0.1");
  try {
    const created = await fetch(service.origin + "/api/conversations/direct", { method: "POST" });
    const chat: unknown = await created.json();
    assert.ok(chat && typeof chat === "object" && "id" in chat && typeof chat.id === "number");
    const path = service.origin + `/api/conversations/${chat.id}/notes`;
    const notes = { todos: [], memos: Array<string>(8).fill("\u0000".repeat(16000)) };
    const first = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes, base: { todos: [], memos: [] } }) });
    assert.equal(first.status, 200);
    const second = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notes, base: notes }) });
    assert.equal(second.status, 200);
    assert.deepEqual(await (await fetch(path)).json(), notes);
    const oversizeOther = await fetch(service.origin + "/api/personal/memory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(100001) }) });
    assert.equal(oversizeOther.status, 413);
  } finally { await service.close(); await rm(data, { recursive: true, force: true }); }
});
