import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "@assistant/runtime";
import { createApplication } from "../dist/application/index.js";
import { readConfig } from "../dist/config.js";
import { openDirectChat } from "../dist/application/direct-chat.js";

test("延续已有普通聊天，跳过微信、分叉和已归档记录", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-direct-legacy-"));
  const app = await createApplication(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: data, NOTIFY_MODE: "off" }));
  try {
    const ids = await app.root.commit(async tx => {
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
      const index = await tx.doc(Index);
      index.items.push(
        { id: ids[0], title: "原来的聊天", createdAt: "2026-10-10" },
        { id: ids[1], title: "微信", channel: "wechat", createdAt: "2026-10-11" },
        { id: ids[2], title: "分叉", forkOf: ids[0], createdAt: "2026-10-12" },
        { id: ids[3], title: "归档", archivedAt: "2026-10-12", createdAt: "2026-10-12" },
      );
      return ids;
    }, app.ctx);
    assert.equal(await openDirectChat(app), ids[0]);
    const conversation = await app.harness.conversation(ids[0], app.ctx);
    assert.ok(conversation);
    assert.deepEqual((await conversation.agent(app.ctx)).model, app.agentModel);
    const selectedModel = { provider: "faux", modelId: "previous-choice" };
    await conversation.configure({ model: selectedModel }, app.ctx);
    assert.equal(await openDirectChat(app), ids[0]);
    assert.deepEqual((await conversation.agent(app.ctx)).model, selectedModel);
    const index = await app.harness.snapshot(Index, app.ctx);
    assert.equal(index?.items.length, 4);
    assert.equal(index?.items[0].channel, "web");
    assert.equal(index?.items[1].channel, "wechat");
    assert.equal(index?.items[2].forkOf, ids[0]);
    assert.equal(index?.items[3].archivedAt, "2026-10-12");
  } finally {
    app.taskGraph.dispose();
    await app.harness.close(app.ctx);
    app.modelSettings.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("停用体验后保留模拟与未绑定模型的旧历史，并重复打开同一真实模型会话", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-direct-no-demo-"));
  const app = await createApplication(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: data, NOTIFY_MODE: "off" }));
  try {
    const simulated = await openDirectChat(app);
    const legacy = await app.root.commit(async tx => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      (await tx.doc(Index)).items.push({ id: conversation.id, title: "旧版模拟聊天", channel: "web", createdAt: "2026-10-10" });
      return conversation.id;
    }, app.ctx);
    const context = { ...app, agentModel: { provider: "demo", modelId: "configured-model" } };
    const real = await openDirectChat(context);
    assert.notEqual(real, simulated);
    assert.notEqual(real, legacy);
    assert.equal(await openDirectChat(context), real);
    const oldConversation = await app.harness.conversation(simulated, app.ctx);
    assert.equal((await oldConversation!.agent(app.ctx)).model?.provider, "faux");
    const legacyConversation = await app.harness.conversation(legacy, app.ctx);
    assert.equal((await legacyConversation!.agent(app.ctx)).model, undefined);
    const realConversation = await app.harness.conversation(real, app.ctx);
    assert.deepEqual((await realConversation!.agent(app.ctx)).model, context.agentModel);
    assert.equal((await app.harness.snapshot(Index, app.ctx))?.items.length, 3);
  } finally {
    app.taskGraph.dispose();
    await app.harness.close(app.ctx);
    app.modelSettings.close();
    await rm(data, { recursive: true, force: true });
  }
});

test("显式新建保留旧会话与计划，之后默认恢复最新网页会话", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-direct-new-"));
  const app = await createApplication(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: data, NOTIFY_MODE: "off" }));
  try {
    const previous = await openDirectChat(app);
    const next = await openDirectChat(app, { fresh: true });
    assert.notEqual(next, previous);
    assert.equal(await openDirectChat(app), next);
    assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => openDirectChat(app))), Array(6).fill(next));
    assert.ok(await app.harness.conversation(previous, app.ctx));
    const index = await app.harness.snapshot(Index, app.ctx);
    assert.equal(index?.items.length, 2);
    assert.ok(index?.items.every(item => item.channel === "web" && !item.archivedAt));
  } finally {
    app.taskGraph.dispose();
    await app.harness.close(app.ctx);
    app.modelSettings.close();
    await rm(data, { recursive: true, force: true });
  }
});
