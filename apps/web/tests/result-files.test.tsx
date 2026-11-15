import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { ResultFiles } from "../dist/tasks/ResultFiles.js";
import { PeerArtifacts } from "../dist/desktop/PeerArtifacts.js";
import { apiClient } from "../dist/api/socket.js";
import type { DesktopAgentBridge } from "@assistant/contracts";
import { mount } from "./dom.js";

test("web results require an explicit read, show escaped metadata and authenticated relative download", async t => {
  const calls: string[] = [];
  t.mock.method(apiClient, "request", async (path: string) => { calls.push(path); return { items: [{ id: "a", taskId: "t", deviceId: "desktop-d", name: "<script>.txt", mimeType: "text/plain", size: 5, sha256: "a".repeat(64), status: "available" }] }; });
  const { dom } = await mount(t, <ResultFiles />);
  assert.deepEqual(calls, []);
  await act(async () => dom.window.document.querySelector("button")!.click());
  assert.deepEqual(calls, ["/api/peers/artifacts"]);
  const link = dom.window.document.querySelector("a")!;
  assert.equal(link.textContent, "<script>.txt");
  assert.equal(link.getAttribute("href"), "/api/peers/tasks/t/artifacts/a?deviceId=desktop-d&download=1");
  assert.equal(dom.window.document.querySelector("script"), null);
});
test("artifact UI cannot upload on render or list and leaves failures retryable", async t => {
  const calls: string[] = [];
  const bridge = { listArtifacts: async () => { calls.push("list"); return []; }, shareArtifact: async () => { calls.push("share"); throw new Error("File unavailable"); } } as unknown as DesktopAgentBridge;
  const { dom } = await mount(t, <PeerArtifacts id="t" bridge={bridge} canShare />);
  assert.deepEqual(calls, []);
  await act(async () => dom.window.document.querySelector("button")!.click());
  assert.deepEqual(calls, ["list"]);
  await act(async () => dom.window.document.querySelectorAll("button")[1].click());
  assert.deepEqual(calls, ["list", "share"]);
  assert.equal(dom.window.document.querySelector('[role="alert"]')!.textContent, "File unavailable");
  assert.equal(dom.window.document.querySelectorAll("button")[1].disabled, false);
});
