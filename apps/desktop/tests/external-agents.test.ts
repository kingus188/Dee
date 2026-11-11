import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openExternalAgents, type ExternalBinding, type DriverFactory } from "../dist/agents/service.js";
import { openCodex } from "../dist/agents/codex.js";
import { openAcp } from "../dist/agents/acp.js";
import { openClaude } from "../dist/agents/claude.js";
import { resolveAgentExecutable, spawnAgent, stopAgent } from "../dist/agents/process.js";
import type { AgentEvent, DriverOptions } from "../dist/agents/types.js";
import type { query, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dee-external-agent-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("GUI-launched npm Agents find their sibling interpreter and retain explicit environment", { skip: process.platform === "win32" }, async () => temporary(async directory => {
  const originalPath = process.env.PATH;
  const executable = join(directory, "agent"), interpreter = join(directory, "dee-fixture-interpreter");
  await writeFile(executable, "#!/usr/bin/env dee-fixture-interpreter\n");
  await writeFile(interpreter, '#!/bin/sh\nprintf "%s" "$DEE_FIXTURE_VALUE"\n');
  await chmod(executable, 0o700); await chmod(interpreter, 0o700);
  const child = spawnAgent(executable, [], directory, "/usr/bin:/bin", { PATH: "/usr/bin:/bin", DEE_FIXTURE_VALUE: "kept" });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0); assert.equal(output, "kept");
  const preferred = join(directory, "preferred"); await mkdir(preferred);
  await writeFile(join(preferred, "dee-fixture-interpreter"), '#!/bin/sh\nprintf "preferred"\n');
  await chmod(join(preferred, "dee-fixture-interpreter"), 0o700);
  const next = spawnAgent(executable, [], directory, "/usr/bin:/bin", { PATH: preferred });
  let preferredOutput = ""; next.stdout.on("data", chunk => { preferredOutput += chunk; });
  assert.equal(await new Promise<number | null>((resolve, reject) => { next.once("error", reject); next.once("close", resolve); }), 0);
  assert.equal(preferredOutput, "preferred"); assert.equal(process.env.PATH, originalPath);
}));
async function until(ready: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!ready()) { if (Date.now() > deadline) throw new Error("Agent fixture timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function options(directory: string, executable: string, events: AgentEvent[]): DriverOptions {
  return { cwd: directory, config: { executable, args: [] }, signal: new AbortController().signal, emit: event => events.push(event), ask: async () => ({ id: "fixture", allow: false }), failed: () => {} };
}

test("external sessions deduplicate intent, bind approvals, keep turns separate and resume without replay", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  let executions = 0, opens = 0, resumed: string | undefined;
  const factory: DriverFactory = async (_kind, config) => {
    opens++; resumed = config.sessionId; config.emit({ type: "session", id: "native-fixture" });
    return { close: async () => {}, abort: async () => {}, send: async text => {
      executions++;
      const approved = await config.ask({ title: "执行测试命令", detail: "fixture command" });
      config.emit({ type: "text", id: "answer", text: `${text}:${approved.allow}` });
    } };
  };
  const config = { directory, binding: () => binding, factory };
  let service = openExternalAgents(config);
  try {
    const first = { id: randomUUID(), text: "第一轮" };
    await service.send(first);
    await until(() => service.snapshot().external.approvals.length === 1);
    await service.send(first);
    await assert.rejects(service.send({ ...first, text: "不同内容" }), /冲突/);
    const request = service.snapshot().external.approvals[0]!;
    assert.equal(service.snapshot().external.status, "waiting");
    service.answer({ id: request.id, allow: false });
    assert.throws(() => service.answer({ id: request.id, allow: true }), /过期/);
    await until(() => !service.busy);
    await service.send({ id: randomUUID(), text: "第二轮" });
    await until(() => service.snapshot().external.approvals.length === 1);
    service.answer({ id: service.snapshot().external.approvals[0]!.id, allow: true });
    await until(() => !service.busy);
    assert.deepEqual(service.snapshot().messages.filter(message => message.role === "assistant").map(message => message.text), ["第一轮:false", "第二轮:true"]);
    assert.equal(opens, 1); assert.equal(executions, 2);
    await service.close(); service = openExternalAgents(config);
    assert.equal(service.snapshot().messages.length, 4);
    await service.send(first); assert.equal(executions, 2);
    await service.send({ id: randomUUID(), text: "第三轮" });
    await until(() => service.snapshot().external.approvals.length === 1);
    assert.equal(resumed, "native-fixture");
    const stale = service.snapshot().external.approvals[0]!.id;
    await service.abort(); assert.equal(service.snapshot().external.status, "cancelled");
    assert.throws(() => service.answer({ id: stale, allow: true }), /过期/);
    await service.newSession(); assert.equal(service.snapshot().messages.length, 0);
    const saved = JSON.parse(await readFile(join(directory, "external-agent-sessions.json"), "utf8"));
    assert.equal(saved.sessions.length, 2, "new session preserves previous history");
  } finally { await service.close(); }
}));

test("interrupted work is visible and never automatically replayed; corrupt history is preserved", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "claude", cwd: directory, config: { executable: "fixture", args: [] } };
  const id = randomUUID(), file = join(directory, "external-agent-sessions.json");
  await writeFile(file, JSON.stringify({ version: 1, sessions: [{ id: "stored", binding: JSON.stringify(binding), nativeId: "native", status: "running", messages: [{ id, role: "user", text: "写入任务" }], activities: [] }] }));
  let executions = 0;
  const factory: DriverFactory = async () => { executions++; throw new Error("unexpected replay"); };
  let service = openExternalAgents({ directory, binding: () => binding, factory });
  assert.equal(service.snapshot().external.status, "interrupted");
  await service.send({ id, text: "写入任务" }); assert.equal(executions, 0); await service.close();
  await writeFile(file, "corrupt"); service = openExternalAgents({ directory, binding: () => binding, factory });
  await assert.rejects(service.send({ id: randomUUID(), text: "继续" }), /原文件已保留/);
  assert.equal(await readFile(file, "utf8"), "corrupt"); await service.close();
}));

test("process exit while waiting for approval preserves failed status and expires its request", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  let fail!: (error: Error) => void;
  const factory: DriverFactory = async (_kind, config) => {
    fail = config.failed;
    return { close: async () => {}, abort: async () => {}, send: async () => { await config.ask({ title: "pending", detail: "" }); } };
  };
  const service = openExternalAgents({ directory, binding: () => binding, factory });
  try {
    await service.send({ id: randomUUID(), text: "one" });
    await until(() => service.snapshot().external.approvals.length === 1);
    const id = service.snapshot().external.approvals[0]!.id;
    fail(new Error("process exited")); await until(() => !service.busy);
    assert.equal(service.snapshot().external.status, "failed");
    assert.equal(service.snapshot().external.approvals.length, 0);
    assert.throws(() => service.answer({ id, allow: true }), /过期/);
  } finally { await service.close(); }
}));

test("failed intent persistence is rolled back so the same request can be retried", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  let executions = 0;
  const factory: DriverFactory = async () => ({ send: async () => { executions++; }, close: async () => {}, abort: async () => {} });
  const service = openExternalAgents({ directory, binding: () => binding, factory });
  try {
    await service.newSession();
    const blocked = join(directory, "external-agent-sessions.json.tmp"); await mkdir(blocked);
    const input = { id: randomUUID(), text: "one" };
    await assert.rejects(service.send(input));
    assert.equal(service.snapshot().messages.length, 0);
    assert.equal(service.snapshot().external.status, "idle");
    await rmdir(blocked); await service.send(input); await until(() => !service.busy);
    assert.equal(executions, 1); assert.equal(service.snapshot().external.status, "done");
  } finally { await service.close(); }
}));

test("a new-session transition rejects concurrent send instead of hiding running messages", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  const service = openExternalAgents({ directory, binding: () => binding });
  try {
    const changing = service.newSession();
    await assert.rejects(service.send({ id: randomUUID(), text: "racing message" }), /正在切换/);
    await changing; assert.equal(service.snapshot().messages.length, 0);
  } finally { await service.close(); }
}));

async function executable(directory: string, body: string) {
  const bin = join(directory, "agent-fixture.mjs");
  await writeFile(bin, `#!${process.execPath}\n${body}`); await chmod(bin, 0o755); return bin;
}
test("executable discovery rejects blank commands and directories", async () => temporary(async directory => {
  assert.throws(() => resolveAgentExecutable(""), /配置/);
  assert.throws(() => resolveAgentExecutable(directory), /找不到/);
  assert.equal(resolveAgentExecutable(process.execPath), process.execPath);
}));
for (const inherit of [true, false]) test(`stopping an exited wrapper also stops descendants (inherited pipes=${inherit})`, { skip: process.platform === "win32" }, async () => temporary(async directory => {
  const bin = await executable(directory, `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: ${inherit ? "'inherit'" : "'ignore'"}});
process.stdout.write(String(child.pid)+'\\n');
setTimeout(() => process.exit(0), 50);`);
  const child = spawnAgent(bin, [], directory);
  const descendant = await new Promise<number>((resolve, reject) => { child.stdout.once("data", data => resolve(Number(String(data).trim()))); child.once("error", reject); });
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
  await stopAgent(child);
  assert.throws(() => process.kill(descendant, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
}));
test("Codex native protocol negotiates sandbox, streams two turns, rejects permissions and resumes", async () => temporary(async directory => {
  const bin = await executable(directory, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
let turn = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); appendFileSync('calls.jsonl', line + '\\n');
 if (m.method === 'initialize') send({id:m.id,result:{}});
 if (m.method === 'thread/start' || m.method === 'thread/resume') send({id:m.id,result:{thread:{id:'native-codex',turns:[]}}});
 if (m.method === 'turn/start') { turn++; send({id:m.id,result:{turn:{id:'turn-'+turn}}}); if(turn===2) { send({method:'turn/completed',params:{threadId:'native-codex',turn:{id:'turn-1',status:'completed'}}}); send({method:'item/agentMessage/delta',params:{threadId:'native-codex',turnId:'turn-1',itemId:'stale',delta:'stale'}}); } send({method:'turn/started',params:{threadId:'native-codex',turn:{id:'turn-'+turn}}}); send({id:'permission-'+turn,method:'item/commandExecution/requestApproval',params:{threadId:'native-codex',turnId:'turn-'+turn,command:'fixture'}}); }
 if (String(m.id).startsWith('permission-')) { send({method:'item/agentMessage/delta',params:{threadId:'native-codex',turnId:'turn-'+turn,itemId:'answer',delta:'hello'}}); send({method:'item/completed',params:{threadId:'native-codex',turnId:'turn-'+turn,item:{id:'answer',type:'agentMessage',text:'hello'}}}); send({method:'turn/completed',params:{threadId:'native-codex',turn:{id:'turn-'+turn,status:'completed'}}}); }
});`);
  const events: AgentEvent[] = [], config = options(directory, bin, events);
  const driver = await openCodex(config);
  try { await driver.send("first", randomUUID()); await driver.send("second", randomUUID()); } finally { await driver.close(); }
  const resumed = await openCodex({ ...config, sessionId: "native-codex" }); await resumed.close();
  const calls = (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.find(call => call.method === "thread/start").params.sandbox, "workspace-write");
  assert.equal(calls.find(call => call.method === "thread/start").params.approvalPolicy, "untrusted");
  assert.ok(calls.some(call => call.method === "thread/resume" && call.params.threadId === "native-codex"));
  assert.equal(calls.filter(call => String(call.id).startsWith("permission-") && call.result?.decision === "decline").length, 2);
  assert.equal(events.filter(event => event.type === "text" && event.delta).length, 2);
  assert.ok(!events.some(event => event.type === "text" && event.text === "stale"));
}));

test("generic ACP supports literal arguments, native mode, permissions and multiple turns", async () => temporary(async directory => {
  const bin = await executable(directory, `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:false}}});
 if(m.method==='session/new') send({id:m.id,result:{sessionId:'acp-native',modes:{currentModeId:'review',availableModes:[{id:'review',name:'Review'}]}}});
 if(m.method==='session/set_mode') send({id:m.id,result:{}});
 if(m.method==='session/prompt') {send({method:'session/update',params:{sessionId:'acp-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP answer'}}}});send({id:m.id,result:{stopReason:'end_turn'}});}
});`);
  const events: AgentEvent[] = [], config = options(directory, bin, events); config.config.mode = "review";
  const driver = await openAcp(config);
  try { await driver.send("one", randomUUID()); await driver.send("two", randomUUID()); } finally { await driver.close(); }
  assert.equal(events.filter(event => event.type === "text").length, 2);
  await assert.rejects(openAcp({ ...config, sessionId: "acp-native" }), /不支持恢复/);
  await assert.rejects(openAcp({ ...config, config: { executable: bin, args: [] } }), /模式 ID/);
}));

test("Claude SDK keeps its permission callback, streams content and resumes native session", async () => temporary(async directory => {
  const events: AgentEvent[] = [], calls: Parameters<typeof query>[0][] = [];
  let closed = 0;
  const fakeQuery: typeof query = input => {
    calls.push(input);
    const iterator = (async function* () {
      const answer = await input.options!.canUseTool!("Bash", { command: "fixture" }, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1" });
      assert.equal(answer?.behavior, "deny");
      yield { type: "system", subtype: "init", session_id: "claude-native" } as SDKMessage;
      yield { type: "stream_event", session_id: "claude-native", event: { type: "message_start", message: { id: "answer" } } } as SDKMessage;
      yield { type: "stream_event", session_id: "claude-native", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } } as SDKMessage;
      yield { type: "assistant", session_id: "claude-native", message: { id: "answer", content: [{ type: "text", text: "hello" }] } } as SDKMessage;
      yield { type: "result", session_id: "claude-native", subtype: "success", is_error: false } as SDKMessage;
    })() as Query;
    iterator.close = () => { closed++; }; return iterator;
  };
  const driver = await openClaude(options(directory, process.execPath, events), fakeQuery);
  try { await driver.send("one", randomUUID()); await driver.send("two", randomUUID()); } finally { await driver.close(); }
  assert.equal(calls[0]!.options!.permissionMode, "default");
  assert.equal(calls[0]!.options!.includePartialMessages, true);
  assert.equal(calls[1]!.options!.resume, "claude-native");
  assert.equal(closed, 2);
  assert.ok(events.some(event => event.type === "text" && event.delta));
}));
