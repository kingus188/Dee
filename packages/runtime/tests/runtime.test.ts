import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, openRuntime, Meta } from "@assistant/runtime";

test("运行时可以脱离 HTTP 与助手功能独立启动并恢复", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-runtime-"));
  const { models, agentModel } = await createModelCatalog({ api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 }, fauxAssistantMessage("独立运行"));
  let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
  try {
    const options = { dataDir, models, agentModel, extensions: [], onReport: (error: unknown) => { throw error; } };
    runtime = await openRuntime(options, context);
    assert.equal((await runtime.harness.snapshot(Meta, context))?.boots, 1);
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel } }, context);
    const submission = await conversation.submit({ type: "input", content: "hello" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    await runtime.harness.close(context); runtime = undefined;
    runtime = await openRuntime(options, context);
    assert.equal((await runtime.harness.snapshot(Meta, context))?.boots, 2);
    assert.ok(await runtime.harness.conversation(conversation.id, context));
  } finally {
    await runtime?.harness.close(context);
    await rm(dataDir, { recursive: true, force: true });
  }
});
