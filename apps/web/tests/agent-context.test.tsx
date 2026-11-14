import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentContext } from "../dist/desktop/AgentContext.js";
import type { DesktopAgentSnapshot } from "@assistant/contracts";

test("handoff details show omitted history and unresolved provider capability without claiming delivery", () => {
  const snapshot = {
    capabilities: { nativeResume: "unknown", approval: "provider-request", cancellation: "process-stop", historyTransfer: "text-only", rollback: false },
    handoff: { source: "pi", target: "acp", createdAt: "2026-11-13T00:00:00Z", totalMessages: 12, includedMessages: 8, omittedMessages: 4, omitted: ["attachments", "tool-state", "hidden-reasoning"], status: "pending" },
  } as DesktopAgentSnapshot;
  const html = renderToStaticMarkup(<AgentContext snapshot={snapshot} />);
  assert.match(html, /下次发送时携带/);
  assert.match(html, /8 \/ 12/);
  assert.match(html, /4 条未携带/);
  assert.match(html, /不携带附件/);
  assert.match(html, /等待 Agent 协议确认/);
  assert.doesNotMatch(html, /已提交执行/);
});

test("idle snapshots without capabilities, handoff or runs do not occupy chat space", () => {
  assert.equal(renderToStaticMarkup(<AgentContext snapshot={{ nodeId: "local", busy: false } as DesktopAgentSnapshot} />), "");
});

test("recorded local execution keeps scope details available after execution ends", () => {
  const html = renderToStaticMarkup(<AgentContext snapshot={{ nodeId: "local", busy: false, runs: [{ id: "run" }] } as DesktopAgentSnapshot} />);
  assert.match(html, /Local · local/);
  assert.match(html, /历史同步/);
});
