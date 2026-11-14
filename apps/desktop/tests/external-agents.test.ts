import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openExternalAgents, type ExternalBinding, type DriverFactory } from "../dist/agents/service.js";
import { openCodex } from "../dist/agents/codex.js";
import { openAcp } from "../dist/agents/acp.js";
import { openOmp } from "../dist/agents/omp.js";
import { readAgentModels } from "../dist/agents/models.js";
import { openClaude } from "../dist/agents/claude.js";
import { resolveAgentExecutable, spawnAgent, stopAgent } from "../dist/agents/process.js";
import { openCodexRpc } from "../dist/agents/codex-rpc.js";
import type { AgentEvent, DriverOptions } from "../dist/agents/types.js";
import type { query, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dee-external-agent-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("OMP model discovery and selection use the advertised ACP model parameter", async () => temporary(async directory => {
  const bin = await executable(directory, `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');
let selected = false, thought = false;
const configOptions = [{id:'native-model',name:'Model',category:'model',type:'select',currentValue:'a',options:[{value:'a',name:'A'},{value:'b',name:'B'}]},{id:'thinking',name:'Thinking',category:'thought_level',type:'select',currentValue:'low',options:[{value:'low',name:'Low'},{value:'high',name:'High'}]}];
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(m.method==='session/new') send({id:m.id,result:{sessionId:'models',configOptions}});
 if(m.method==='session/set_config_option') { if(m.params.configId==='native-model') selected = m.params.value==='b'; if(m.params.configId==='thinking') thought=m.params.value==='high'; send({id:m.id,result:{configOptions}}); }
 if(m.method==='session/prompt') send({id:m.id,result:{stopReason:selected && thought?'end_turn':'cancelled'}});
});`);
  assert.deepEqual(await readAgentModels("omp", { executable: bin, args: [] }, directory), [{ id: "a", name: "A", efforts: ["low", "high"] }, { id: "b", name: "B", efforts: ["low", "high"] }]);
  const config = options(directory, bin, []);
  const driver = await openOmp({ ...config, config: { ...config.config, model: "b", effort: "high" } });
  try { await driver.send("verify model", randomUUID()); } finally { await driver.close(); }
  await assert.rejects(openOmp({ ...config, config: { ...config.config, model: "b", effort: "unsupported" } }), /不支持所选思考强度/);
}));

test("Finder-style PATH discovers nvm Agents while explicit PATH retains priority", async () => temporary(async directory => {
  const name = `dee-nvm-fixture-${randomUUID()}`;
  const older = join(directory, ".nvm/versions/node/v22.19.0/bin"), newer = join(directory, ".nvm/versions/node/v24.14.1/bin");
  for (const bin of [older, newer]) {
    await mkdir(bin, { recursive: true }); await writeFile(join(bin, name), "#!/bin/sh\n"); await chmod(join(bin, name), 0o700);
  }
  assert.equal(resolveAgentExecutable(name, "/usr/bin:/bin", directory), join(newer, name));
  assert.equal(resolveAgentExecutable(name, older, directory), join(older, name));
  assert.equal(resolveAgentExecutable(join(older, name), "", directory), join(older, name));
  assert.throws(() => resolveAgentExecutable(name, "", join(directory, "missing-home")), /找不到/);
}));

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
    const sessionId = service.sessions()[0]!.sessionId;
    const blocked = join(directory, "external-agent-sessions", `${createHash("sha256").update(sessionId).digest("hex")}.json.tmp`); await mkdir(blocked);
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
test("Codex close delivers EOF before terminating the process tree", async () => temporary(async directory => {
  const bin = await executable(directory, `import {writeFileSync} from 'node:fs'; process.stdin.resume(); process.stdin.on('end',()=>{writeFileSync('closed.txt','EOF');process.exit(0);});`);
  const rpc = openCodexRpc({ executable: bin, cwd: directory, notify() {}, request: async () => ({}), failed() {} });
  await rpc.close();
  assert.equal(await readFile(join(directory, "closed.txt"), "utf8"), "EOF");
}));
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
  config.config.model = "native-model";
  config.config.effort = "ultra";
  try { await driver.send("first", randomUUID()); await driver.send("second", randomUUID()); } finally { await driver.close(); }
  config.config.sandbox = "read-only";
  config.config.approvalPolicy = "on-request";
  const resumed = await openCodex({ ...config, sessionId: "native-codex" }); await resumed.close();
  const calls = (await readFile(join(directory, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.find(call => call.method === "turn/start").params.model, "native-model");
  assert.equal(calls.find(call => call.method === "turn/start").params.effort, "ultra");
  assert.equal(calls.find(call => call.method === "thread/start").params.sandbox, "workspace-write");
  assert.equal(calls.find(call => call.method === "thread/start").params.approvalPolicy, "untrusted");
  assert.equal(calls.find(call => call.method === "thread/resume").params.sandbox, "read-only");
  assert.equal(calls.find(call => call.method === "thread/resume").params.approvalPolicy, "on-request");
  assert.ok(calls.some(call => call.method === "thread/resume" && call.params.threadId === "native-codex"));
  assert.equal(calls.filter(call => String(call.id).startsWith("permission-") && call.result?.decision === "decline").length, 2);
  assert.equal(events.filter(event => event.type === "text" && event.delta).length, 2);
  assert.ok(!events.some(event => event.type === "text" && event.text === "stale"));
}));

for (const [allow, full] of [[false, false], [true, false], [true, true]]) test(`Codex 0.167.1 MCP tool elicitation uses explicit single-call user approval (${allow}, full=${full})`, async () => temporary(async directory => {
  const bin = await executable(directory, `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync('mcp-calls.jsonl',line+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native'}}});
 if(m.method==='turn/start'){
  send({id:'mcp-approval',method:'mcpServer/elicitation/request',params:{threadId:'native',turnId:'turn',serverName:'dee_peers',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call',persist:['session','always'],tool_name:'peer_sessions',tool_params:{}},message:'Allow peer_sessions?',requestedSchema:{type:'object',properties:{}}}});
  send({id:m.id,result:{turn:{id:'turn'}}});
 }
 if(m.id==='mcp-approval')send({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}});
});`);
  let asks = 0;
  const config = options(directory, bin, []);
  if (full) Object.assign(config.config, { sandbox: "danger-full-access", approvalPolicy: "never" });
  const driver = await openCodex({ ...config, ask: async request => { asks++; assert.match(request.title, /MCP/); assert.match(request.detail, /dee_peers/); assert.match(request.detail, /peer_sessions/); return { id: "approval", allow }; } });
  try { await driver.send("call peer_sessions", randomUUID()); } finally { await driver.close(); }
  assert.equal(asks, full ? 0 : 1, "MCP tool approval must reach the user approval callback");
  const calls = (await readFile(join(directory, "mcp-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.find(call => call.method === "thread/start").params.approvalPolicy, full ? "never" : "untrusted");
  assert.deepEqual(calls.find(call => call.id === "mcp-approval" && !call.method).result, allow ? { action: "accept", content: {} } : { action: "decline" });
}));

test("Codex declines unrelated MCP elicitations and rejects stale turns without granting permissions", async () => temporary(async directory => {
  const bin = await executable(directory, `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
let responses=0;const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync('mcp-calls.jsonl',line+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'native'}}});
 if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'turn'}}});
  const params={threadId:'native',turnId:'turn',serverName:'dee_peers',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call',tool_name:'peer_sessions'},requestedSchema:{type:'object',properties:{}}};
  send({id:'stale',method:'mcpServer/elicitation/request',params:{...params,turnId:'old-turn'}});
  send({id:'unrelated',method:'mcpServer/elicitation/request',params:{...params,_meta:{}}});
  send({id:'form',method:'mcpServer/elicitation/request',params:{...params,requestedSchema:{type:'object',properties:{secret:{type:'string'}}}}});
 }
 if(['stale','unrelated','form'].includes(m.id)&&!m.method&&++responses===3)send({method:'turn/completed',params:{threadId:'native',turn:{id:'turn',status:'completed'}}});
});`);
  let asks = 0;
  const driver = await openCodex({ ...options(directory, bin, []), ask: async () => { asks++; return { id: "must-not-ask", allow: true }; } });
  try { await driver.send("fixture", randomUUID()); } finally { await driver.close(); }
  assert.equal(asks, 0);
  const replies = (await readFile(join(directory, "mcp-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(call => !call.method);
  assert.ok(replies.find(call => call.id === "stale").error);
  for (const id of ["unrelated", "form"]) assert.deepEqual(replies.find(call => call.id === id).result, { action: "decline" });
}));

test("generic ACP supports literal arguments, native mode, permissions and multiple turns", async () => temporary(async directory => {
  const bin = await executable(directory, `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value}) + '\\n');
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:false}}});
 if(m.method==='session/new') send({id:m.id,result:{sessionId:'acp-native',modes:{currentModeId:process.argv.includes('--missing-mode')?'missing':'review',availableModes:[{id:'review',name:'Review'}]}}});
 if(m.method==='session/set_mode') send({id:m.id,result:{}});
 if(m.method==='session/prompt') {send({method:'session/update',params:{sessionId:'acp-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP answer'}}}});send({id:m.id,result:{stopReason:'end_turn'}});}
});`);
  const events: AgentEvent[] = [], config = options(directory, bin, events); config.config.mode = "review";
  const driver = await openAcp(config);
  try { await driver.send("one", randomUUID()); await driver.send("two", randomUUID()); } finally { await driver.close(); }
  assert.equal(events.filter(event => event.type === "text").length, 2);
  assert.ok(events.some(event => event.type === "capabilities" && !event.nativeResume));
  await assert.rejects(openAcp({ ...config, sessionId: "acp-native" }), /不支持恢复/);
  const defaultDriver = await openAcp({ ...config, config: { executable: bin, args: [] } });
  try { await defaultDriver.send("default mode", randomUUID()); } finally { await defaultDriver.close(); }
  await assert.rejects(openAcp({ ...config, config: { executable: bin, args: [], mode: "unknown" } }), /模式 ID/);
  await assert.rejects(openAcp({ ...config, config: { executable: bin, args: ["--missing-mode"] } }), /模式 ID/);
}));

test("OMP uses ACP mode, streams replies, resumes native sessions and forwards peer MCP", async () => temporary(async directory => {
  const bin = await executable(directory, `
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\\n');
createInterface({input: process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if (m.method === 'session/new' || m.method === 'session/load') {
  if (m.params.mcpServers[0]?.name !== 'dee_peers' || m.params.mcpServers[0]?.env[0]?.value !== 'mcp') throw Error('wrong MCP');
  send({id:m.id,result:{sessionId:'omp-native',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'},{id:'plan',name:'Plan'}]}}});
 }
 if (m.method === 'session/set_mode') throw Error('must preserve the advertised current mode');
 if (m.method === 'session/prompt') {
  send({method:'session/update',params:{sessionId:'omp-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OMP answer'}}}});
  send({id:m.id,result:{stopReason:'end_turn'}});
 }
});`);
  const events: AgentEvent[] = [], config = options(directory, bin, events);
  config.peerMcp = { command: process.execPath, args: ["--version"], env: { DEE_FIXTURE: "mcp" } };
  const driver = await openOmp(config);
  try { await driver.send("one", randomUUID()); } finally { await driver.close(); }
  assert.ok(events.some(event => event.type === "capabilities" && event.nativeResume));
  const resumed = await openOmp({ ...config, sessionId: "omp-native" });
  try { await resumed.send("two", randomUUID()); } finally { await resumed.close(); }
  assert.equal(events.filter(event => event.type === "text").length, 2);
}));
for (const full of [false, true]) test(`Claude SDK permissions, streaming and native resume (full=${full})`, async () => temporary(async cwd => {
  const events: AgentEvent[] = [], calls: Parameters<typeof query>[0][] = [];
  let closed = 0;
  const fakeQuery: typeof query = input => {
    calls.push(input);
    const iterator = (async function* () {
      const answer = await input.options!.canUseTool!("Bash", { command: "fixture" }, { signal: new AbortController().signal, toolUseID: "tool-1", requestId: "request-1" });
      assert.equal(answer?.behavior, full ? "allow" : "deny");
      yield { type: "system", subtype: "init", session_id: "claude-native" } as SDKMessage;
      yield { type: "stream_event", session_id: "claude-native", event: { type: "message_start", message: { id: "answer" } } } as SDKMessage;
      yield { type: "stream_event", session_id: "claude-native", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } } } as SDKMessage;
      yield { type: "assistant", session_id: "claude-native", message: { id: "answer", content: [{ type: "text", text: "hello" }] } } as SDKMessage;
      yield { type: "result", session_id: "claude-native", subtype: "success", is_error: false } as SDKMessage;
    })() as Query;
    iterator.close = () => { closed++; }; return iterator;
  };
  const config = options(cwd, process.execPath, events);
  config.config.model = "native-claude-model";
  config.config.permissionMode = full ? "bypassPermissions" : "plan";
  config.config.effort = "max";
  config.peerMcp = { command: process.execPath, args: ["--version"], env: { DEE_FIXTURE: "mcp" } };
  const driver = await openClaude(config, fakeQuery);
  try { await driver.send("one", randomUUID()); await driver.send("two", randomUUID()); } finally { await driver.close(); }
  assert.equal(calls[0]!.options!.permissionMode, full ? "bypassPermissions" : "plan");
  assert.equal(calls[0]!.options!.model, "native-claude-model");
  assert.equal(calls[0]!.options!.effort, "max");
  assert.equal(calls[0]!.options!.includePartialMessages, true);
  assert.equal(calls[1]!.options!.resume, "claude-native");
  assert.deepEqual(calls[0]!.options!.mcpServers, { dee_peers: config.peerMcp });
  assert.deepEqual(calls[1]!.options!.mcpServers, { dee_peers: config.peerMcp });
  assert.equal(calls[0]!.options!.allowDangerouslySkipPermissions, full ? true : undefined);
  assert.equal(closed, 2);
  assert.ok(events.some(event => event.type === "text" && event.delta));
}));

for (const full of [false, true]) test(`ACP native resume preserves peer MCP and applies tool permission (full=${full})`, async () => temporary(async directory => {
  const bin = await executable(directory, `
import {createInterface} from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
let pending;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(m.method==='session/new')throw Error('unexpected new session');
 if(m.method==='session/load'){
  if(m.params.sessionId!=='existing-acp'||m.params.mcpServers[0]?.name!=='dee_peers'||m.params.mcpServers[0]?.env[0]?.value!=='mcp')throw Error('wrong session or MCP binding');
  send({method:'session/update',params:{sessionId:'existing-acp',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old history must not duplicate'}}}});
  send({id:m.id,result:{}});
 }
 if(m.method==='session/prompt'){
  pending=m.id;
  send({id:'permission',method:'session/request_permission',params:{sessionId:'existing-acp',toolCall:{toolCallId:'tool',title:'fixture'},options:[{optionId:'once',name:'Allow',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});
 }
 if(m.id==='permission'){
  if(m.result?.outcome?.optionId!=='${full ? 'once' : 'deny'}')throw Error('permission bypass');
  send({method:'session/update',params:{sessionId:'existing-acp',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'resumed answer'}}}});
  send({id:pending,result:{stopReason:'end_turn'}});
 }
});`);
  const events: AgentEvent[] = [], config = options(directory, bin, events);
  config.sessionId = "existing-acp"; config.peerMcp = { command: process.execPath, args: ["--version"], env: { DEE_FIXTURE: "mcp" } };
  config.config.access = full ? "full" : "ask";
  const driver = await openAcp(config);
  try { await driver.send("continue", randomUUID()); } finally { await driver.close(); }
  assert.deepEqual(events.filter(event => event.type === "text").map(event => event.text), ["resumed answer"]);
}));

test("colliding provider message IDs stay inside their own request and peer result", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  const factory: DriverFactory = async (_kind, options) => ({
    abort: async () => {}, close: async () => {},
    send: async text => {
      const id = text === "first" ? "b:x" : "x";
      options.emit({ type: "text", id, text, delta: true });
      options.emit({ type: "text", id, text: " reply", delta: true });
    },
  });
  const service = openExternalAgents({ directory, binding: () => binding, factory });
  try {
    await service.send({ id: "peer:a", text: "first" }); await until(() => !service.busy);
    await service.send({ id: "peer:a:b", text: "second" }); await until(() => !service.busy);
    assert.deepEqual(service.snapshot().runs.map(run => run.result), ["first reply", "second reply"]);
    const target = service.sessions()[0]!;
    const base = { source: "server", target: "desktop", targetSession: target, status: "queued" as const, createdAt: "now", updatedAt: "now" };
    assert.equal((await service.runSession({ ...base, id: "a", task: "first" }))?.result, "first reply");
    assert.equal((await service.runSession({ ...base, id: "a:b", task: "second" }))?.result, "second reply");
  } finally { await service.close(); }
}));

test("peer cancellation persists before native admission and never replays after restart", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  let sends = 0;
  const factory: DriverFactory = async () => ({ abort: async () => {}, close: async () => {}, send: async () => { sends++; } });
  let service = openExternalAgents({ directory, binding: () => binding, factory });
  await service.newSession();
  const job = { id: randomUUID(), source: "server", target: "desktop", targetSession: service.sessions()[0]!, task: "must not execute", status: "queued" as const, createdAt: "now", updatedAt: "now" };
  try {
    assert.equal(await service.cancelPeer(job), true);
    assert.equal((await service.runSession(job))?.status, "failed");
    await service.close();
    service = openExternalAgents({ directory, binding: () => binding, factory });
    assert.equal(await service.cancelPeer(job), true);
    assert.equal((await service.runSession(job))?.status, "failed");
    assert.equal(sends, 0);
  } finally { await service.close(); }
}));

test("native peer receives fixed workspace, constraints and acceptance criteria", async () => temporary(async directory => {
  const binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  let prompt = "";
  const factory: DriverFactory = async () => ({ abort: async () => {}, close: async () => {}, send: async text => { prompt = text; } });
  const service = openExternalAgents({ directory, binding: () => binding, factory });
  try {
    await service.newSession();
    const job = { id: randomUUID(), source: "server", target: "desktop", targetSession: service.sessions()[0]!, task: "implement", workspace: directory, constraints: "No deployment", acceptanceCriteria: "Tests pass", status: "queued" as const, createdAt: "now", updatedAt: "now" };
    assert.equal((await service.runSession(job))?.status, "done");
    assert.match(prompt, /Required workspace:/);
    assert.match(prompt, /Constraints: No deployment/);
    assert.match(prompt, /Acceptance criteria: Tests pass/);
  } finally { await service.close(); }
}));
