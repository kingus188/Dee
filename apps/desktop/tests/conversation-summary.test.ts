import test from "node:test";
import assert from "node:assert/strict";
import { completeSummary, createSummaryDrafts, summaryRevision } from "../dist/conversation-summary.js";
import type { DesktopConversation } from "@assistant/contracts";
const source = (): DesktopConversation => ({ sessionId: "pi-1", agent: "pi", messages: [{ id: "1", role: "user", text: "Build a report" }] });

test("summary drafts return source revision without mutating the conversation", async () => {
  const conversation = source(), original = structuredClone(conversation);
  const drafts = createSummaryDrafts(async () => conversation, async () => "Goal: report");
  assert.deepEqual(await drafts.generate("pi-1"), { summary: "Goal: report", sourceRevision: summaryRevision(original) });
  assert.deepEqual(conversation, original);
});
test("empty source and invalid model output fail explicitly", async () => {
  const empty = { ...source(), messages: [] };
  await assert.rejects(createSummaryDrafts(async () => empty, async () => "wrong").generate("pi-1"), /empty/);
  await assert.rejects(createSummaryDrafts(async () => source(), async () => " ").generate("pi-1"), /Invalid/);
});
test("stale conversation is rejected after completion", async () => {
  const conversation = source();
  const drafts = createSummaryDrafts(async () => conversation, async () => { conversation.messages.push({ id: "2", role: "assistant", text: "Done" }); return "old draft"; });
  await assert.rejects(drafts.generate("pi-1"), /Conversation changed/);
});
test("concurrent drafts are blocked and cancelled results discarded", async () => {
  let finish!: (value: string) => void;
  const drafts = createSummaryDrafts(async () => source(), () => new Promise(resolve => { finish = resolve; }));
  const pending = drafts.generate("pi-1");
  await assert.rejects(drafts.generate("pi-1"), /already/);
  drafts.cancel("pi-1"); finish("discard me");
  await assert.rejects(pending, /cancelled/);
});
test("model failures allow a new generation", async () => {
  let attempt = 0;
  const drafts = createSummaryDrafts(async () => source(), async () => { if (!attempt++) throw new Error("offline"); return "new draft"; });
  await assert.rejects(drafts.generate("pi-1"), /offline/);
  assert.equal((await drafts.generate("pi-1")).summary, "new draft");
});


test("completion uses only text roles and no tools or conversation runtime", async () => {
  let context: unknown, parameters: unknown;
  const catalog = { configured: true, agentModel: { provider: "test", modelId: "test" }, models: {
    getModel: () => ({ contextWindow: 128000 }),
    completeSimple: async (_model: unknown, input: unknown, options: unknown) => {
      context = input; parameters = options;
      return { stopReason: "stop", content: [{ type: "text", text: "Draft result" }] };
    },
  } } as unknown as Parameters<typeof completeSummary>[0];
  const signal = new AbortController().signal;
  assert.equal(await completeSummary(catalog, source(), signal), "Draft result");
  const captured = context as { tools?: unknown; messages: Array<{ content: string }> };
  assert.equal(captured.tools, undefined);
  assert.deepEqual(JSON.parse(captured.messages[0]!.content), [{ role: "user", text: "Build a report" }]);
  assert.equal((parameters as { signal: AbortSignal }).signal, signal);
});
