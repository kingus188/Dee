import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Index, Meta } from "@assistant/runtime";
import { Notes, Reminders, Delegations, Schedules, Parents, BackgroundJobs, MemoryDoc, SkillsDoc, createTaskCenter } from "@assistant/features";
import { WechatState } from "@assistant/channel-wechat";

test("拆包后的持久化定义与迁移前快照一致", async () => {
  const before = JSON.parse(await readFile(new URL("../fixtures/durable-definitions.json", import.meta.url), "utf8"));
  const documents = [Notes, Index, Reminders, Delegations, Meta, Schedules, Parents, BackgroundJobs, MemoryDoc, SkillsDoc, WechatState]
    .map(({ definition: d }) => ({ kind: d.kind, version: d.version, scope: d.scope,
      history: "history" in d ? d.history : undefined, fork: "fork" in d ? d.fork : undefined, initial: d.initial() }));
  const center = createTaskCenter(async () => {});
  const tasks = [center.ScheduleTask, center.BackgroundTask].map(({ definition: d }) => ({ name: d.name, version: d.version }));
  assert.deepEqual(JSON.parse(JSON.stringify({ documents, tasks })), before);
});
