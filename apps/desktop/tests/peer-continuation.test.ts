import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createModelCatalog, type PeerJob } from "@assistant/runtime";
import { openExternalAgents, type ExternalBinding, type DriverFactory } from "../dist/agents/service.js";
import { openDesktopAgent, type AgentRequest } from "../dist/local-agent.js";
import { openAgentSettings } from "../dist/agent-settings.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
const model = { api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 };

async function until(ready: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!await ready()) { if (Date.now() > deadline) throw new Error("continuation timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
for (const kind of ["codex", "claude", "acp", "omp"] as const) test(`${kind}: result resumes the original native source without selecting it or replaying after restart`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-native-continuation-"));
  const binding: ExternalBinding = { kind, cwd: directory, config: { executable: "fixture", args: [] } };
  const turns: Array<{ nativeId: string; text: string; id: string }> = [];
  let count = 0;
  const factory: DriverFactory = async (_kind, options) => {
    const nativeId = options.sessionId ?? `native-${++count}`;
    options.emit({ type: "session", id: nativeId });
    return { close: async () => {}, abort: async () => {}, send: async (text, id) => { turns.push({ nativeId, text, id }); options.emit({ type: "text", id: "reply", text: "continued" }); } };
  };
  const options = { directory, binding: () => binding, factory };
  let service = openExternalAgents(options);
  try {
    await service.send({ id: randomUUID(), text: "source context" }); await until(() => !service.busy);
    const source = service.sessions()[0]!;
    await service.newSession();
    await service.send({ id: randomUUID(), text: "current UI session" }); await until(() => !service.busy);
    const job: PeerJob = { id: randomUUID(), source: "desktop-" + randomUUID(), target: "server", sourceSession: source, targetSession: { agent: "pi", sessionId: "pi-1" }, task: "work", status: "done", result: "target result", createdAt: "now", updatedAt: "now" };
    await service.deliverResult(job);
    await until(() => !service.busy);
    assert.equal(turns.length, 3, "result delivery must start a real driver turn");
    assert.equal(turns[2]!.nativeId, "native-1"); assert.equal(turns[2]!.id, `peer-result:${job.id}`);
    for (const text of [job.id, "server", "pi-1", "done", "target result"]) assert.ok(turns[2]!.text.includes(text));
    assert.ok(!service.snapshot().messages.some(message => message.id === `peer-result:${job.id}`));
    assert.ok(service.readSession(source).messages.some(message => message.id === `peer-result:${job.id}` && message.role === "user"));
    await service.close(); service = openExternalAgents(options);
    await service.deliverResult(job); await until(() => !service.busy);
    assert.equal(turns.length, 3);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("offline desktop restart drains a busy source continuation from the original job exactly once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-desktop-continuation-"));
  const settings = openAgentSettings(directory); settings.selectAgent({ kind: "codex", config: { executable: process.execPath, args: [] } });
  let offline = false, release!: () => void, continuations = 0;
  const request: AgentRequest = async (path, body) => {
    if (offline) throw new Error("offline");
    if (path === "/api/peers/messages") return { item: { ...body as PeerJob, status: "done", result: "remote completed while source busy" } };
    if (path.startsWith("/api/peers/tasks")) return { items: [] };
    return {};
  };
  const factory: DriverFactory = async (_kind, options) => {
    options.emit({ type: "session", id: "original-native-source" });
    return { close: async () => {}, abort: async () => {}, send: async text => {
      if (text === "hold") await new Promise<void>(resolve => { release = resolve; options.signal.addEventListener("abort", () => resolve(), { once: true }); });
      if (text.startsWith("协作任务 ")) { continuations++; assert.equal(options.sessionId, "original-native-source"); }
      options.emit({ type: "text", id: "reply", text: "continued" });
    } };
  };
  const options = { directory, settings, request, confirm: async () => false, driverFactory: factory,
    loadModels: async () => ({ ...await createModelCatalog(model, fauxAssistantMessage("Pi")), model: { ...model, hasApiKey: false } }) };
  let agent = await openDesktopAgent(options);
  try {
    await agent.send({ id: randomUUID(), text: "source original context" });
    await until(async () => !(await agent.snapshot()).busy);
    const source = (await agent.sessions()).find(session => session.agent === "codex")!;
    await agent.send({ id: randomUUID(), text: "hold" }); await until(() => Boolean(release));
    const job = await agent.sendPeer({ id: randomUUID(), source: settings.get().nodeId, sourceSession: source, target: "server", targetSession: { agent: "pi", sessionId: "pi-1" }, task: "remote work" });
    await until(async () => (await agent.peerStatus(job.id)).status === "done");
    assert.equal((await agent.peerStatus(job.id)).resultDelivered, undefined); assert.match((await agent.peerStatus(job.id)).deliveryError!, /等待来源/); assert.equal(continuations, 0);
    offline = true; await agent.close(); agent = await openDesktopAgent(options);
    await until(() => continuations === 1);
    await until(async () => !(await agent.snapshot()).busy);
    assert.equal((await agent.peerStatus(job.id)).resultDelivered, true);
    assert.ok((await agent.readSession({ node: settings.get().nodeId, session: source })).messages.some(message => message.id === `peer-result:${job.id}` && message.role === "user"));
    await agent.close(); agent = await openDesktopAgent(options);
    assert.equal(continuations, 1); assert.equal((await agent.snapshot()).jobs.length, 1);
  } finally { release?.(); await agent.close(); await rm(directory, { recursive: true, force: true }); }
});

test("same-desktop addressed completion resumes its source and leaves the selected target unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-desktop-local-relay-"));
  const settings = openAgentSettings(directory); settings.selectAgent({ kind: "codex", config: { executable: process.execPath, args: [] } });
  let nativeCount = 0;
  const turns: Array<{ nativeId: string; text: string }> = [];
  const factory: DriverFactory = async (_kind, options) => {
    const nativeId = options.sessionId ?? `native-${++nativeCount}`; options.emit({ type: "session", id: nativeId });
    return { close: async () => {}, abort: async () => {}, send: async text => { turns.push({ nativeId, text }); options.emit({ type: "text", id: "reply", text: "answer" }); } };
  };
  const agent = await openDesktopAgent({ directory, settings, request: async () => { throw new Error("offline"); }, confirm: async () => false, driverFactory: factory,
    loadModels: async () => ({ ...await createModelCatalog(model, fauxAssistantMessage("Pi")), model: { ...model, hasApiKey: false } }) });
  try {
    await agent.send({ id: randomUUID(), text: "source" });
    await until(async () => !(await agent.snapshot()).busy);
    const source = (await agent.sessions()).find(session => session.agent === "codex")!;
    await agent.newSession(); await agent.send({ id: randomUUID(), text: "selected target" });
    await until(async () => !(await agent.snapshot()).busy);
    const target = (await agent.sessions()).filter(session => session.agent === "codex").at(-1)!;
    const job = await agent.sendPeer({ id: randomUUID(), source: settings.get().nodeId, target: settings.get().nodeId, sourceSession: source, targetSession: target, task: "local target work" });
    assert.equal(turns.length, 2); await agent.approve(job.id);
    await until(() => turns.length === 4);
    await until(async () => !(await agent.snapshot()).busy);
    assert.equal(turns[2]!.nativeId, "native-2"); assert.equal(turns[3]!.nativeId, "native-1");
    const snapshot = await agent.snapshot();
    assert.ok(snapshot.messages.some(message => message.text === "selected target"));
    assert.ok(!snapshot.messages.some(message => message.id === `peer-result:${job.id}`));
    assert.equal(snapshot.jobs.length, 1); assert.equal((await agent.peerStatus(job.id)).resultDelivered, true);
  } finally { await agent.close(); await rm(directory, { recursive: true, force: true }); }
});

test("busy native source returns pending; interrupted continuation intent is never replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-native-pending-"));
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  let release!: () => void, turns = 0;
  const factory: DriverFactory = async (_kind, options) => { options.emit({ type: "session", id: "native-source" }); return { close: async () => {}, abort: async () => {}, send: async text => { turns++; if (text === "hold") await new Promise<void>(resolve => { release = resolve; }); } }; };
  const options = { directory, binding: () => binding, factory };
  let service = openExternalAgents(options);
  try {
    await service.send({ id: randomUUID(), text: "hold" }); await until(() => Boolean(release));
    const source = service.sessions()[0]!;
    const job: PeerJob = { id: randomUUID(), source: "desktop-" + randomUUID(), target: "server", sourceSession: source, task: "remote", status: "done", result: "result", createdAt: "now", updatedAt: "now" };
    assert.equal(await service.deliverResult(job), false); assert.equal(turns, 1);
    assert.ok(!service.readSession(source).messages.some(message => message.id === `peer-result:${job.id}`));
    release(); await until(() => !service.busy);
    assert.equal(await service.deliverResult(job), true); await until(() => !service.busy); assert.equal(turns, 2);
    await service.close();
    const id = `peer-result:${job.id}`;
    const message = service.readSession(source).messages.find(message => message.id === id)!;
    await writeFile(join(directory, "external-agent-sessions.json"), JSON.stringify({ version: 1, sessions: [{ id: source.sessionId, binding: JSON.stringify(binding), nativeId: "native-source", status: "running", messages: [message], activities: [], requests: { [id]: { status: "running" } } }] }));
    service = openExternalAgents(options);
    assert.equal(await service.deliverResult(job), true); assert.equal(turns, 2);
    assert.equal(service.snapshot().external.status, "interrupted");
  } finally { release?.(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
