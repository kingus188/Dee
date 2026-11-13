import assert from "node:assert/strict";
import test from "node:test";
import { prepareHandoff, handoffPrompt, HANDOFF_HISTORY_LIMIT } from "../dist/agent-handoff.js";
import { agentCapabilities } from "../dist/agents/capabilities.js";

test("handoff selects complete recent messages and records omissions without truncating current input", () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" as const : "user" as const, text: `${i}:` + "x".repeat(5000) }));
  const result = prepareHandoff(messages, "codex", "claude");
  assert.ok(result.context.length <= HANDOFF_HISTORY_LIMIT);
  assert.equal(result.handoff.lastMessageId, "19");
  assert.ok(result.handoff.omittedMessages > 0);
  assert.equal(result.handoff.includedMessages + result.handoff.omittedMessages, 20);
  assert.deepEqual(JSON.parse(result.context), messages.slice(-result.handoff.includedMessages).map(({ role, text }) => ({ role, text })));
  const instruction = "NEW_INSTRUCTION".repeat(1000);
  assert.ok(handoffPrompt(result.context, instruction).endsWith(instruction));
  assert.deepEqual(result.handoff.omitted, ["attachments", "tool-state", "hidden-reasoning"]);
});

test("legacy oversized history is budgeted without invalid JSON or partial messages", () => {
  const history = JSON.stringify([{ role: "user", text: "x".repeat(100000) }, { role: "assistant", text: "recent" }]);
  const prompt = handoffPrompt(history, "LATEST");
  assert.ok(prompt.includes('"recent"'));
  assert.ok(prompt.length < HANDOFF_HISTORY_LIMIT);
  assert.ok(prompt.endsWith("LATEST"));
});

test("adapter capability claims distinguish negotiated ACP resume and process cancellation", () => {
  for (const kind of ["acp", "omp"] as const) {
    assert.equal(agentCapabilities(kind).nativeResume, "unknown");
    assert.equal(agentCapabilities(kind, false).nativeResume, "unsupported");
    assert.equal(agentCapabilities(kind, true).nativeResume, "supported");
  }
  assert.equal(agentCapabilities("pi").cancellation, "runtime-task");
  assert.equal(agentCapabilities("codex").cancellation, "process-stop");
  assert.equal(agentCapabilities("claude").historyTransfer, "text-only");
  assert.equal(agentCapabilities("claude").rollback, false);
});


test("malformed legacy context fails explicitly rather than dropping history or sending partial context", () => {
  for (const value of ["broken", "null", "{}", '[{"role":"system","text":"x"}]', '[{"role":"user","text":null}]']) {
    assert.throws(() => handoffPrompt(value, "CURRENT"), /历史交接记录.*原记录已保留/);
  }
});


test("empty handoffs are JSON-safe without undefined document fields", () => {
  const result = prepareHandoff([], "pi", "codex");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.handoff.includedMessages, 0);
});
