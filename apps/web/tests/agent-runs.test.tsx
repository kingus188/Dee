import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { AgentRuns } from "../dist/desktop/AgentRuns.js";

test("native execution view distinguishes execution result from acceptance and escapes output", () => {
  const snapshot = { agent: "codex", runs: [{ id: "r", sessionId: "s", agent: "codex", status: "failed", request: "do work", result: '<script>alert(1)</script>', cancellation: "not_requested", review: "unsupported" }] } as DesktopAgentSnapshot;
  const html = renderToStaticMarkup(<AgentRuns snapshot={snapshot} />);
  assert.match(html, /Failed/);
  assert.match(html, /Unavailable/);
  assert.ok(!html.includes(">Accept</button>"));
  assert.ok(!html.includes("<script>"));
});

test("Pi view states its coverage boundary rather than claiming there are no executions", () => {
  assert.match(renderToStaticMarkup(<AgentRuns snapshot={{ agent: "pi" } as DesktopAgentSnapshot} />), /尚未接入此视图/);
});

test("completed native results offer version-bound review without retry controls", () => {
  const snapshot = {agent: "codex", runs: [{id: "r", sessionId: "s", agent: "codex", status: "succeeded", request: "task", result: "result", resultVersion: "v", reviewRevision: 0, review: "pending", cancellation: "not_requested"}]} as DesktopAgentSnapshot;
  const html = renderToStaticMarkup(<AgentRuns snapshot={snapshot} review={async () => {}} />);
  assert.match(html, />Accept<\/button>/); assert.match(html, />Reject<\/button>/);
  assert.match(html, /Review reason \(optional\)/); assert.ok(!html.includes("Retry"));
});
