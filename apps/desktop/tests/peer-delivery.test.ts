import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, createPeerService, openRuntime } from "@assistant/runtime";
import type { PeerJob } from "@assistant/runtime";
import { openDesktopAgent, type AgentRequest } from "../dist/local-agent.js";
import { openAgentSettings } from "../dist/agent-settings.js";
import { createAgentRequest, PeerConnectionError } from "../dist/peer-connection.js";
import { openCodex } from "../dist/agents/codex.js";
import { createHttpServer } from "../../server/dist/http/server.js";
import { readConfig } from "../../server/dist/config.js";
import type { AppContext } from "../../server/dist/application/context.js";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12000;
  do { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  throw new Error("peer integration timed out");
}
test("authenticated WS delivers both directions, restores an approved busy queue to the same native thread and retries unknown admission once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-peer-e2e-")), token = "p".repeat(43);
  let serverCalls = 0, nativeCalls = 0, resumed: string | undefined, release: (() => void) | undefined;
  const model = { api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 };
  const catalog = await createModelCatalog(model, transcript => { serverCalls++; assert.match(JSON.stringify(transcript.messages), /server original context/); return fauxAssistantMessage("server relay result"); });
  const peers = createPeerService({ nodeId: "server", configured: () => true });
  const runtime = await openRuntime({ dataDir: join(directory, "server"), ...catalog, extensions: [peers.extension], onReport: () => {} }, ctx); peers.bind(runtime, ctx);
  const app = { ...runtime, peers, ctx, config: readConfig({ NODE_ENV: "test", AUTH_DISABLED: "1", PEER_TOKEN: token }), wechat: null, redact: String, exitIfFatal: () => {} } as unknown as AppContext;
  const http = createHttpServer(app); await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const desktop = join(directory, "desktop");
  await mkdir(desktop);
  const executable = join(desktop, "codex-fixture.mjs");
  await writeFile(executable, `#!${process.execPath}
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const stateFile=${JSON.stringify(join(desktop, "native-sessions.json"))};
const releaseFile=${JSON.stringify(join(desktop, "release"))};
let thread,turn=0,text='';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const done=()=>{send({method:'item/completed',params:{threadId:thread,turnId:'turn-'+turn,item:{id:'reply',type:'agentMessage',text:'native answer:'+text}}});send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-'+turn,status:'completed'}}});};
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume'){
  if(m.params.sandbox!=='workspace-write'||m.params.approvalPolicy!=='untrusted'||!m.params.config?.mcp_servers?.dee_peers)throw Error('native permission/tool config missing');
  const sessions=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
  thread=m.params.threadId||'native-'+(Object.keys(sessions).length+1);sessions[thread]??=[];writeFileSync(stateFile,JSON.stringify(sessions));
  send({id:m.id,result:{thread:{id:thread}}});
 }
 if(m.method==='turn/start'){
  turn++;text=m.params.input[0].text;
  const sessions=JSON.parse(readFileSync(stateFile,'utf8'));
  if(text==='peer work'&&!sessions[thread].includes('target original context'))throw Error('resumed wrong native thread');
  if(text.startsWith('协作任务 ')&&!sessions[thread].includes('source original context'))throw Error('continued wrong source native thread');
  sessions[thread].push(text);writeFileSync(stateFile,JSON.stringify(sessions));
  send({id:m.id,result:{turn:{id:'turn-'+turn}}});
  if(text==='hold'){const timer=setInterval(()=>{if(existsSync(releaseFile)){clearInterval(timer);done();}},5);}
  else if(text==='peer work')send({id:'permission',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'turn-'+turn,command:'fixture only'}});
  else done();
 }
 if(m.id==='permission'){if(m.result?.decision!=='decline')throw Error('native permission bypassed');done();}
});`);
  await chmod(executable, 0o700);
  const settings = openAgentSettings(desktop); settings.selectAgent({ kind: "codex", config: { executable, args: [], permission: "default" } });
  const transport = createAgentRequest({ origin: () => origin, serverId: () => origin, username: () => undefined, password: () => undefined, token: () => token, fetch, socket: url => new WebSocket(url) });
  let dropAdmissionResponse = false, dropped = 0;
  const request: AgentRequest = Object.assign(async (path: string, body?: unknown, serverId?: string) => {
    const response = await transport(path, body, serverId);
    if (dropAdmissionResponse && path === "/api/peers/messages") { dropAdmissionResponse = false; dropped++; throw new PeerConnectionError(503); }
    return response;
  }, { onChange: transport.onChange });
  const options = { directory: desktop, settings, request, serverId: () => origin, confirm: async () => false,
    loadModels: async () => ({ ...await createModelCatalog(model, fauxAssistantMessage("local Pi")), model: { ...model, hasApiKey: false } }),
    driverFactory: async (_kind: "codex" | "claude" | "acp" | "omp", config: import("../dist/agents/types.js").DriverOptions) => {
      resumed = config.sessionId;
      const driver = await openCodex(config);
      return { abort: driver.abort, close: driver.close, send: async (text: string, id: string) => {
        nativeCalls++;
        if (text === "hold") release = () => { writeFileSync(join(desktop, "release"), "release"); };
        await driver.send(text, id);
      } };
    } };
  let agent = await openDesktopAgent(options);
  try {
    await (await runtime.root.submit({ type: "input", content: "server original context" }, ctx)).wait(ctx);
    await agent.send({ id: randomUUID(), text: "target original context" }); await until(() => agent.snapshot(), value => !value.busy);
    const target = (await agent.sessions()).find(item => item.agent === "codex")!;
    await agent.newSession();
    await agent.send({ id: randomUUID(), text: "source original context" }); await until(() => agent.snapshot(), value => !value.busy);
    const source = (await agent.sessions()).filter(item => item.agent === "codex").at(-1)!;
    assert.notEqual(source.sessionId, target.sessionId);
    await agent.send({ id: randomUUID(), text: "hold" }); await until(async () => release, Boolean);
    const input = { id: randomUUID(), source: "server", sourceSession: { agent: "pi", sessionId: `pi-${runtime.root.id}` }, target: settings.get().nodeId, targetSession: target, task: "peer work" };
    await request("/api/peers/messages", input);
    await until(() => agent.snapshot(), value => value.jobs.some(job => job.id === input.id));
    assert.equal(nativeCalls, 3, "remote admission did not auto-approve desktop execution");
    await agent.approve(input.id);
    assert.equal((await agent.peerStatus(input.id)).status, "queued", "busy native process retains approved queue intent");
    await agent.close(); agent = await openDesktopAgent(options);
    const waiting = await until(() => agent.snapshot(), value => Boolean(value.external?.approvals.length));
    assert.equal(resumed, "native-1");
    assert.ok(!waiting.messages.some(message => message.text === "peer work"), "background target never replaces selected source");
    await agent.answerApproval({ id: waiting.external!.approvals[0]!.id, allow: false });
    await until(() => peers.get(input.id), value => value?.status === "done");
    assert.equal((await peers.get(input.id))!.result, "native answer:peer work");
    assert.equal((await runtime.root.context(ctx)).entries.filter(entry => entry.kind === "app.peer-result").length, 1);
    dropAdmissionResponse = true;
    const outbound = { id: randomUUID(), source: settings.get().nodeId, sourceSession: source, target: "server", targetSession: { agent: "pi" as const, sessionId: `pi-${runtime.root.id}` }, task: "continue server context" };
    await agent.sendPeer(outbound);
    const result = await until(() => agent.peerStatus(outbound.id), value => value.status === "done");
    assert.equal(result.result, "server relay result"); assert.equal(dropped, 1); assert.equal(serverCalls, 3);
    await until(() => agent.snapshot(), value => !value.busy);
    assert.equal(nativeCalls, 5, "completion starts exactly one source native turn in addition to the target turn");
    const sourceRead = await agent.readSession({ node: settings.get().nodeId, session: source });
    assert.equal(sourceRead.messages.filter(message => message.id === `peer-result:${outbound.id}`).length, 1);
    const nativeBefore = nativeCalls;
    await agent.sendPeer(outbound); await peers.run(outbound.id);
    await agent.close(); agent = await openDesktopAgent(options);
    assert.equal((await agent.peerStatus(outbound.id)).status, "done");
    assert.equal(nativeCalls, nativeBefore); assert.equal(serverCalls, 3);
    assert.equal((await peers.list()).length, 2, "bidirectional receipts do not recursively create new jobs");
    const catalogResponse = await request(`/api/peers/sessions?nodeId=${settings.get().nodeId}`) as { items: Array<{ sessionId: string }> };
    assert.ok(catalogResponse.items.some(item => item.sessionId === target.sessionId));
    await assert.rejects(request("/api/peers/messages", { ...outbound, task: "changed" }));
    assert.equal((await peers.list()).filter((job: PeerJob) => job.id === outbound.id).length, 1);
  } finally {
    release?.(); await agent.close(); transport.close(); http.closeSockets(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    await peers.close(); await runtime.harness.close(ctx); await rm(directory, { recursive: true, force: true });
  }
});
