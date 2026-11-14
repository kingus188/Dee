import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { PeerJob } from "@assistant/runtime";
import { openExternalAgents, type ExternalBinding, type DriverFactory } from "../dist/agents/service.js";
import { openPeerTools } from "../dist/agents/peer-tools.js";

async function until(ready: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!ready()) { if (Date.now() > deadline) throw new Error("fixture timeout"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
for (const kind of ["codex", "claude", "acp", "omp"] as const) test(`${kind}: addressed old session queues while busy, resumes natively, returns to source and never replays`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-native-peer-"));
  const binding: ExternalBinding = { kind, cwd: directory, config: { executable: "fixture", args: [] } };
  let opened = 0, executions = 0, resumed: string | undefined, release: (() => void) | undefined;
  const factory: DriverFactory = async (_kind, options) => {
    resumed = options.sessionId;
    options.emit({ type: "session", id: options.sessionId ?? `native-${++opened}` });
    assert.ok(options.peerMcp, "native driver receives its source-bound peer tools");
    return { close: async () => {}, abort: async () => {}, send: async text => {
      executions++;
      if (text === "hold") await new Promise<void>(resolve => { release = resolve; options.signal.addEventListener("abort", () => resolve(), { once: true }); });
      options.emit({ type: "text", id: "answer", text: `answer:${text}` });
    } };
  };
  const config = { directory, binding: () => binding, factory, peerTools: () => async () => ({}) };
  let service = openExternalAgents(config);
  try {
    await service.send({ id: randomUUID(), text: "first context" }); await until(() => !service.busy);
    const target = service.sessions()[0]!;
    await service.newSession();
    await service.send({ id: randomUUID(), text: "source context" }); await until(() => !service.busy);
    const source = service.sessions()[1]!;
    await service.send({ id: randomUUID(), text: "hold" }); await until(() => Boolean(release));
    const job: PeerJob = { id: randomUUID(), source: "desktop-" + randomUUID(), target: "desktop-" + randomUUID(), sourceSession: source, targetSession: target, task: "relay", status: "queued", createdAt: "now", updatedAt: "now" };
    assert.equal(await service.runSession(job), undefined, "busy is queued without starting or interrupting");
    assert.equal(executions, 3);
    release!(); await until(() => !service.busy);
    const result = await service.runSession(job);
    assert.equal(resumed, "native-1"); assert.equal(result?.result, "answer:relay"); assert.equal(executions, 4);
    assert.ok(!service.snapshot().messages.some(message => message.text === "relay"), "selected source did not change");
    assert.ok(service.readSession(target).messages.some(message => message.text === "relay"));
    await service.deliverResult({ ...job, ...result! }); await service.deliverResult({ ...job, ...result! });
    await until(() => !service.busy);
    assert.equal(service.snapshot().messages.filter(message => message.id === `peer-result:${job.id}`).length, 1);
    await service.close(); service = openExternalAgents(config);
    assert.deepEqual(await service.runSession(job), result); assert.equal(executions, 5);
    await assert.rejects(service.runSession({ ...job, task: "changed" }), /冲突/);
    await assert.rejects(service.runSession({ ...job, targetSession: { ...target, agent: kind === "codex" ? "claude" : "codex" } }), /不存在/);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native MCP stdio adapter carries list/read/send/status to the same source-bound queue and rejects unauthenticated HTTP", async () => {
  const calls: unknown[] = [];
  const server = await openPeerTools(async (name, args) => { calls.push({ name, args }); return { accepted: true }; });
  const child = spawn(server.config.command, server.config.args, { env: { ...process.env, ...server.config.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const responses: Array<{ id: number; result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> } }> = [];
  lines.on("line", line => responses.push(JSON.parse(line)));
  try {
    assert.equal((await fetch(server.config.env.DEE_PEER_MCP_URL, { method: "POST", body: "{}" })).status, 403);
    for (const message of [{ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, { id: 2, method: "tools/list" }, { id: 3, method: "tools/call", params: { name: "peer_sessions", arguments: {} } }]) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    await until(() => responses.length === 3);
    assert.deepEqual(responses.find(item => item.id === 2)!.result.tools!.map(tool => tool.name), ["cancel_peer_task", "peer_sessions", "read_peer_session", "send_to_peer_session", "peer_task_status"]);
    assert.deepEqual(calls, [{ name: "peer_sessions", args: {} }]);
    assert.match(responses.find(item => item.id === 3)!.result.content![0]!.text, /accepted/);
  } finally { lines.close(); child.kill(); await new Promise<void>(resolve => child.once("close", () => resolve())); await server.close(); }
});

test("restarting after native intent admission exposes unknown outcome without executing the request again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-peer-unknown-"));
  const binding: ExternalBinding = { kind: "claude", cwd: directory, config: { executable: "fixture", args: [] } };
  const sessionId = randomUUID(), jobId = randomUUID(), requestId = `peer:${jobId}`;
  await writeFile(join(directory, "external-agent-sessions.json"), JSON.stringify({ version: 1, sessions: [{ id: sessionId, binding: JSON.stringify(binding), nativeId: "native-existing", status: "running", messages: [{ id: requestId, role: "user", text: "non-repeatable work" }], activities: [], requests: { [requestId]: { status: "running" } } }] }));
  let starts = 0;
  const service = openExternalAgents({ directory, binding: () => binding, factory: async () => { starts++; throw new Error("must not replay"); } });
  try {
    const job: PeerJob = { id: jobId, source: "server", target: "desktop-" + randomUUID(), targetSession: { agent: "claude", sessionId }, task: "non-repeatable work", status: "running", createdAt: "now", updatedAt: "now" };
    const result = await service.runSession(job);
    assert.equal(result?.status, "failed"); assert.match(result!.result, /未知.*未自动重放/); assert.equal(starts, 0);
    assert.equal(service.snapshot().external.status, "interrupted");
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
