import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationSync } from "../dist/desktop/ConversationSync.js";
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
  assert.match(html, /Sync status/);
});


test("scope state does not confuse connectivity with successful synchronization", () => {
  const base = { nodeId: "desktop", workspace: "/repo", serverConnected: true, conversationSync: { sessionId: "pi-1", mode: "full", summary: "", revision: 3, sentRevision: 2, previouslyShared: true, status: "pending" } } as DesktopAgentSnapshot;
  let html = renderToStaticMarkup(<AgentContext snapshot={base} />);
  assert.match(html, /Sync status<\/dt><dd>Pending/);
  assert.match(html, /Workspace<\/dt><dd>\/repo/);
  html = renderToStaticMarkup(<AgentContext snapshot={{ ...base, conversationSync: { ...base.conversationSync!, mode: "local", status: "local" } }} />);
  assert.match(html, /Sync status<\/dt><dd>Local only/);
  assert.doesNotMatch(html, /Sync status<\/dt><dd>Synced/);
});


test("a conversation bound to another server waits for its original server without exposing addresses", () => {
  const sync = { sessionId: "pi-1", mode: "full", summary: "", revision: 1, sentRevision: 1, previouslyShared: true, status: "pending", serverMismatch: true, serverId: "https://private-origin.invalid" } as const;
  const snapshot = { nodeId: "desktop", serverConnected: true, conversationSync: sync } as DesktopAgentSnapshot;
  const html = renderToStaticMarkup(<AgentContext snapshot={snapshot}><ConversationSync sync={sync} disabled={false} save={async () => {}} /></AgentContext>);
  assert.match(html, /Waiting for<\/dt><dd>Original server/);
  assert.match(html, /This conversation remains bound to its original server; changing servers does not move it/);
  assert.doesNotMatch(html, /private-origin/);
});
