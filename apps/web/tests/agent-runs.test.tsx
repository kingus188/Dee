import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { AgentRuns } from "../dist/desktop/AgentRuns.js";

test("native execution view distinguishes execution result from acceptance and escapes output", () => {
  const snapshot = { agent: "codex", runs: [{ id: "r", sessionId: "s", agent: "codex", status: "failed", request: "do work", result: '<script>alert(1)</script>', cancellation: "not_requested", review: "unsupported" }] } as DesktopAgentSnapshot;
  const html = renderToStaticMarkup(<AgentRuns snapshot={snapshot} />);
  assert.match(html, /失败/);
  assert.match(html, /不代表成果已验收/);
  assert.match(html, /暂不支持持久人工验收/);
  assert.ok(!html.includes("<script>"));
});

test("Pi view states its coverage boundary rather than claiming there are no executions", () => {
  assert.match(renderToStaticMarkup(<AgentRuns snapshot={{ agent: "pi" } as DesktopAgentSnapshot} />), /尚未接入此视图/);
});
