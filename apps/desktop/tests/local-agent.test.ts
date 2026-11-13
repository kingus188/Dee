import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openAgentSettings } from "../dist/agent-settings.js";
import { openDesktopAgent } from "../dist/local-agent.js";
import { createModelCatalog } from "@assistant/runtime";
import { PeerConnectionError } from "../dist/peer-connection.js";
import type { AgentRequest } from "../dist/local-agent.js";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const timeout = Date.now() + 15000;
  do { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < timeout);
  throw new Error("Timed out waiting for local Agent");
}
test("WebSocket changes wake local collaboration without waiting for reconciliation and never approve execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-peer-push-")), settings = openAgentSettings(directory);
  const config = { api: "openai-completions", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 };
  let receive!: (change: "connected" | "disconnected" | "tasks") => void, transportClosed = false, unsubscribed = false;
  let items: Array<{ id: string; source: string; target: string; task: string; status: string; createdAt: string; updatedAt: string }> = [];
  const request: AgentRequest = Object.assign(async (path: string) => path === "/api/info" ? {} : { items }, {
    onChange(listener: typeof receive) { receive = listener; return () => { unsubscribed = true; }; }, close() { transportClosed = true; },
  });
  const agent = await openDesktopAgent({ directory, settings, request, confirm: async () => false,
    loadModels: async () => ({ ...await createModelCatalog(config), model: { ...config, hasApiKey: false } }) });
  try {
    await until(() => agent.snapshot(), value => value.collaboration === "ready");
    items = [{ id: randomUUID(), source: "server", target: settings.get().nodeId, task: "wait for approval", status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
    const deadline = Date.now() + 1000; receive("tasks");
    while (!(await agent.snapshot()).jobs.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const snapshot = await agent.snapshot();
    assert.equal(snapshot.jobs[0]?.status, "queued"); assert.equal(snapshot.busy, false);
    receive("disconnected"); assert.equal((await agent.snapshot()).serverConnected, false);
    receive("connected"); await until(() => agent.snapshot(), value => value.serverConnected && value.collaboration === "ready");
  } finally { await agent.close(); await rm(directory, { recursive: true, force: true }); }
  assert.equal(transportClosed, true); assert.equal(unsubscribed, true);
});
test("healthy server with missing collaboration is not reported disconnected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-peer-health-"));
  const settings = openAgentSettings(directory);
  const config = { api: "openai-completions", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 };
  const agent = await openDesktopAgent({ directory, settings, loadModels: async () => ({ ...await createModelCatalog(config), model: { api: config.api, baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192, hasApiKey: false } }),
    confirm: async () => false, request: async path => { if (path === "/api/info") return {}; throw new PeerConnectionError(404); } });
  try {
    const snapshot = await until(() => agent.snapshot(), value => value.collaboration === "unavailable");
    assert.equal(snapshot.serverConnected, true); assert.match(snapshot.error!, /尚未启用双端/);
  } finally { await agent.close(); await rm(directory, { recursive: true, force: true }); }
});
test("local Agent owns model, protects tools, persists approvals and returns one durable peer result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-local-agent-"));
  let calls = 0, allow = false, pauseReply = false;
  let outbound: { id: string; source: string; sourceSession: { agent: "pi"; sessionId: string }; target: string; targetSession: { agent: "pi"; sessionId: string }; task: string } | undefined;
  const toolResults: string[] = [];
  const model = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body) as { model: string; messages: Array<{role:string;content?:unknown}> };
    if (input.messages.at(-1)?.role === "tool") toolResults.push(JSON.stringify(input.messages.at(-1)?.content));
    calls++;
    if (pauseReply) { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); return; }
    const tool = input.messages.at(-1)?.role !== "tool";
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "read-fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] } : { role: "assistant", content: "本机验证完成" };
    const chunk = { id: "local-agent-test", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const settings = openAgentSettings(directory);
  const modelConfig = { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fixture", apiKey: "fixture-only", contextWindow: 128000, maxTokens: 8192 };
  settings.selectAgent({ kind: "pi", piAccess: "ask" });
  const loadModels = async () => ({ ...await createModelCatalog(modelConfig), model: { api: modelConfig.api, baseUrl: "", model: modelConfig.model, contextWindow: modelConfig.contextWindow, maxTokens: modelConfig.maxTokens, hasApiKey: true } });
  const workspace = settings.get().workspace!;
  await writeFile(join(workspace, "fixture.txt"), "本机资料");
  const incoming = { id: randomUUID(), source: "server", target: settings.get().nodeId, task: "读取工作目录 fixture.txt", status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const completions: unknown[] = []; let confirms = 0;
  const options = { directory, settings, loadModels, confirm: async () => { confirms++; return allow; }, request: async (path: string, body?: unknown) => {
    if (outbound && path === "/api/peers/messages") return { item: { ...outbound, status: "done", result: "远端结果", createdAt: "now", updatedAt: "now" } };
    if (outbound && path.includes(outbound.id)) return { item: { ...outbound, status: "done", result: "远端结果", createdAt: "now", updatedAt: "now" } };
    if (path.includes("/complete")) { completions.push(body); return { item: { ...incoming, status: "done", result: "本机验证完成" } }; }
    return { items: [incoming] };
  } };
  let agent = await openDesktopAgent(options);
  try {
    await until(() => agent.snapshot(), snapshot => snapshot.jobs.length === 1);
    assert.equal(calls, 0, "unapproved server task must not call local model");
    await agent.approve(incoming.id);
    const done = await until(() => agent.snapshot(), snapshot => snapshot.jobs[0]?.status === "done");
    assert.equal(done.jobs[0]?.result, "本机验证完成"); assert.equal(confirms, 1);
    assert.equal(calls, 2); assert.equal(await readFile(join(workspace, "fixture.txt"), "utf8"), "本机资料");
    await agent.close(); agent = await openDesktopAgent(options);
    await until(() => agent.snapshot(), snapshot => snapshot.jobs[0]?.status === "done");
    assert.equal(calls, 2, "reopening cannot repeat completed tools or generation");
    assert.match(toolResults[0]!, /用户未授权/);
    settings.selectAgent({ kind: "pi", piAccess: "full" });
    const id = randomUUID(); await agent.send({ id, text: "本机聊天" });
    await until(() => agent.snapshot(), snapshot => !snapshot.busy && snapshot.messages.some(message => message.text === "本机验证完成"));
    assert.match(toolResults.at(-1)!, /本机资料/);
    assert.equal(confirms, 1, "Full access executes the tool without a second confirmation, even when confirm would deny");
    const before = calls; await agent.send({ id, text: "本机聊天" });
    await until(() => agent.snapshot(), snapshot => !snapshot.busy);
    assert.equal(calls, before, "repeated send ID is one submission");
    assert.ok(completions.length > 0);
    const previous = (await agent.sessions()).find(session => session.agent === "pi")!;
    await agent.newSession();
    assert.deepEqual((await agent.snapshot()).messages, [], "new Pi conversation starts without the old context");
    assert.ok((await agent.readSession({ node: settings.get().nodeId, session: previous })).messages.some(message => message.text === "本机聊天"), "old transcript stays readable");
    assert.equal((await agent.sessions()).filter(session => session.agent === "pi").length, 3);
    await agent.close(); agent = await openDesktopAgent(options);
    assert.deepEqual((await agent.snapshot()).messages, [], "restart restores the newly selected conversation");
    await agent.send({ id: randomUUID(), text: "新会话消息" });
    await assert.rejects(agent.newSession(), /先停止当前任务/);
    const fresh = await until(() => agent.snapshot(), snapshot => !snapshot.busy && snapshot.messages.some(message => message.text === "本机验证完成"));
    assert.ok(fresh.messages.some(message => message.text === "新会话消息"));
    assert.ok(!fresh.messages.some(message => message.text === "本机聊天"));
    await agent.close(); agent = await openDesktopAgent(options);
    assert.ok((await agent.snapshot()).messages.some(message => message.text === "新会话消息"));
    const source = (await agent.sessions()).findLast(session => session.agent === "pi")!;
    await agent.newSession();
    outbound = { id: randomUUID(), source: settings.get().nodeId, sourceSession: { agent: "pi", sessionId: source.sessionId }, target: "server", targetSession: { agent: "pi", sessionId: "pi-1" }, task: "旧会话协作" };
    pauseReply = true;
    await agent.sendPeer(outbound);
    await until(() => agent.snapshot(), snapshot => snapshot.busy && snapshot.jobs.some(job => job.id === outbound!.id && job.status === "done"));
    await agent.abort();
    await until(() => agent.snapshot(), snapshot => !snapshot.busy);
    assert.deepEqual((await agent.snapshot()).messages, [], "stopping an old source continuation keeps the new conversation selected");
  } finally { await agent.close(); await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); }
});
