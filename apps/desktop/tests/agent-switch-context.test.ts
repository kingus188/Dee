import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { openExternalAgents, type DriverFactory, type ExternalBinding } from "../dist/agents/service.js";
import { openDesktopAgent } from "../dist/local-agent.js";
import { openAgentSettings } from "../dist/agent-settings.js";
import { createModelCatalog } from "@assistant/runtime";

const kinds = ["codex", "claude", "acp", "omp"] as const;
const recall = "RECALL";

async function until(ready: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await ready()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for switch/context test");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(run: (value: {
  service: ReturnType<typeof openExternalAgents>;
  switchTo(kind: ExternalBinding["kind"], workspace?: string, executable?: string): Promise<void>;
  restart(): Promise<void>;
  say(text: string): Promise<string>;
  opens: Array<{ kind: string; nativeId: string; resumed: boolean }>;
  prompts: Array<{ kind: string; text: string }>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dee-agent-switch-"));
  let binding: ExternalBinding = { kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } };
  // Native memory belongs to each fake provider, not Dee's stored transcript.
  const native = new Map<string, string[]>(), opens: Array<{ kind: string; nativeId: string; resumed: boolean }> = [], prompts: Array<{ kind: string; text: string }> = [];
  const factory: DriverFactory = async (kind, options) => {
    const id = options.sessionId ?? `${kind}-${randomUUID()}`;
    if (options.sessionId) assert.ok(native.has(id), "resume must use an existing native session");
    else native.set(id, []);
    opens.push({ kind, nativeId: id, resumed: Boolean(options.sessionId) });
    options.emit({ type: "session", id });
    return {
      abort: async () => {}, close: async () => {},
      send: async text => {
        prompts.push({ kind, text });
        const facts = native.get(id)!;
        if (text.startsWith("REMEMBER ")) facts.push(text.slice("REMEMBER ".length));
        options.emit({ type: "text", id: "answer", text: text === recall ? JSON.stringify(facts) : "ACK" });
      },
    };
  };
  const options = { directory, binding: () => binding, factory };
  let service = openExternalAgents(options);
  try {
    await run({
      get service() { return service; }, opens, prompts,
      async switchTo(kind, workspace = directory, executable = "fixture") {
        await service.detach(); binding = { kind, cwd: workspace, config: { executable, args: [] } };
      },
      async restart() { await service.close(); service = openExternalAgents(options); },
      async say(text) {
        const id = randomUUID(); await service.send({ id, text }); await until(() => !service.busy);
        assert.equal(service.snapshot().external.status, "done", service.snapshot().error);
        return service.snapshot().messages.find(message => message.role === "assistant" && message.id.startsWith(`${id}:`))!.text;
      },
    });
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
}

for (const source of kinds) for (const target of kinds) {
  if (source === target) continue;
  test(`current handoff gap: ${source} → ${target} does not forward the source context`, async () => fixture(async f => {
    await f.switchTo(source);
    const fact = `synthetic-${randomUUID()}`;
    await f.say(`REMEMBER ${fact}`);
    await f.switchTo(target);
    assert.equal(f.service.snapshot().messages.length, 0, "target has its own transcript");
    const observed = await f.say(recall);
    assert.equal(observed, "[]", "characterization: cross-Agent handoff is not implemented");
    assert.equal(f.prompts.at(-1)!.text, recall, "only the new user message reaches the target");
    assert.ok(!f.prompts.filter(prompt => prompt.kind === target).some(prompt => prompt.text.includes(fact)));
    assert.equal(f.opens.at(-1)!.resumed, false);
  }));
}

for (const source of kinds) test(`${source}: switching back resumes its facts but misses work done by another Agent`, async () => fixture(async f => {
  const other = source === "claude" ? "codex" : "claude";
  await f.switchTo(source); await f.say("REMEMBER source-v1");
  const first = f.service.snapshot().external.sessionId;
  await f.switchTo(other); await f.say("REMEMBER changed-in-other-agent");
  await f.switchTo(source);
  assert.deepEqual(JSON.parse(await f.say(recall)), ["source-v1"]);
  assert.equal(f.service.snapshot().external.sessionId, first);
  assert.equal(f.opens.at(-1)!.resumed, true);
  await f.restart();
  assert.deepEqual(JSON.parse(await f.say(recall)), ["source-v1"]);
  assert.equal(f.service.snapshot().external.sessionId, first);
  assert.ok(!f.prompts.at(-1)!.text.includes("changed-in-other-agent"));
}));

test("context stays isolated across workspace/command changes and an explicit new session", async () => fixture(async f => {
  await f.say("REMEMBER workspace-A"); const original = f.service.snapshot().external.sessionId;
  await f.switchTo("codex", "/synthetic/other-workspace");
  assert.deepEqual(JSON.parse(await f.say(recall)), []);
  await f.switchTo("codex", undefined, "other-executable");
  assert.deepEqual(JSON.parse(await f.say(recall)), []);
  await f.switchTo("codex");
  assert.deepEqual(JSON.parse(await f.say(recall)), ["workspace-A"]);
  assert.equal(f.service.snapshot().external.sessionId, original);
  await f.service.newSession();
  assert.deepEqual(JSON.parse(await f.say(recall)), []);
  assert.notEqual(f.service.snapshot().external.sessionId, original);
  await f.restart(); assert.deepEqual(JSON.parse(await f.say(recall)), []);
}));

test("24 switches and restart preserve native memory without duplicating messages", async () => fixture(async f => {
  const expected = { codex: [] as string[], claude: [] as string[], acp: [] as string[], omp: [] as string[] };
  for (let round = 0; round < 24; round++) {
    const kind = kinds[round % kinds.length]!;
    await f.switchTo(kind);
    const fact = `fact-${round}`;
    expected[kind].push(fact); await f.say(`REMEMBER ${fact}`);
    assert.deepEqual(JSON.parse(await f.say(recall)), expected[kind]);
    if (round === 11) await f.restart();
  }
  for (const kind of kinds) {
    await f.switchTo(kind); assert.deepEqual(JSON.parse(await f.say(recall)), expected[kind]);
    const messages = f.service.snapshot().messages;
    assert.equal(new Set(messages.map(message => `${message.role}:${message.id}`)).size, messages.length);
  }
}));

test("desktop public entry switches Pi ↔ Codex, restores local memory and exposes missing cross-Agent handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-desktop-switch-"));
  const model = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const messages = (JSON.parse(body) as { messages: Array<{ role: string; content?: unknown }> }).messages;
    const latest = messages.findLast(message => message.role === "user");
    const latestText = typeof latest?.content === "string" ? latest.content : JSON.stringify(latest?.content);
    const facts = messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).filter(text => text.includes("PI_SYNTHETIC_FACT"));
    const answer = latestText?.includes("RECALL") ? facts.length ? "PI_SYNTHETIC_FACT" : "UNKNOWN" : "ACK";
    const chunk = { id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const settings = openAgentSettings(directory);
  const modelConfig = { api: "openai-completions", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: "fixture", apiKey: "fixture-only", contextWindow: 128000, maxTokens: 4096 };
  const loadModels = async () => ({ ...await createModelCatalog(modelConfig), model: { api: modelConfig.api, baseUrl: "", model: modelConfig.model, contextWindow: modelConfig.contextWindow, maxTokens: modelConfig.maxTokens, hasApiKey: true } });
  settings.saveWorkspace(directory);
  const bin = join(directory, "codex-fixture.mjs");
  await writeFile(bin, `#!${process.execPath}
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
let facts=[],threadId,turn=0;
const send=value=>process.stdout.write(JSON.stringify(value)+"\\n");
createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);appendFileSync("protocol.jsonl",line+"\\n");
 if(m.method==="initialize")send({id:m.id,result:{}});
 if(m.method==="thread/start"||m.method==="thread/resume"){
  threadId=m.params.threadId??randomUUID();const file=threadId+".json";
  facts=existsSync(file)?JSON.parse(readFileSync(file,"utf8")):[];
  send({id:m.id,result:{thread:{id:threadId}}});
 }
 if(m.method==="turn/start"){
  const turnId="turn-"+(++turn),text=m.params.input[0].text;
  if(text.startsWith("REMEMBER "))facts.push(text.slice(9));
  writeFileSync(threadId+".json",JSON.stringify(facts));
  send({id:m.id,result:{turn:{id:turnId}}});
  if(text==="WAIT")return;
  const answer=text==="RECALL"?JSON.stringify(facts):"ACK";
  send({method:"item/completed",params:{threadId,turnId,item:{type:"agentMessage",id:turnId,text:answer}}});
  send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed"}}});
 }
});`);
  await chmod(bin, 0o755);
  const options = { directory, settings, loadModels, confirm: async () => false, request: async () => ({ items: [] }) };
  let agent: Awaited<ReturnType<typeof openDesktopAgent>> | undefined;
  try {
    agent = await openDesktopAgent(options);
    const say = async (text: string) => { await agent!.send({ id: randomUUID(), text }); await until(async () => !(await agent!.snapshot()).busy); return (await agent!.snapshot()).messages.filter(message => message.role === "assistant").at(-1)!.text; };
    assert.equal(await say("PI_SYNTHETIC_FACT"), "ACK");
    await agent.selectAgent({ kind: "codex", config: { executable: bin, args: [] } });
    assert.equal(await say(recall), "[]", "Pi history is not sent to Codex");
    await say("REMEMBER CODEX_SYNTHETIC_FACT");
    const codexId = (await agent.snapshot()).external!.sessionId;
    await agent.selectAgent({ kind: "pi" });
    assert.equal(await say(recall), "PI_SYNTHETIC_FACT");
    assert.ok(!(await agent.snapshot()).messages.some(message => message.text.includes("CODEX_SYNTHETIC_FACT")));
    await agent.selectAgent({ kind: "codex" });
    assert.deepEqual(JSON.parse(await say(recall)), ["CODEX_SYNTHETIC_FACT"]);
    assert.equal((await agent.snapshot()).external!.sessionId, codexId);
    await agent.close(); agent = await openDesktopAgent(options);
    assert.deepEqual(JSON.parse(await say(recall)), ["CODEX_SYNTHETIC_FACT"]);
    await agent.send({ id: randomUUID(), text: "WAIT" });
    await until(async () => (await readFile(join(directory, "protocol.jsonl"), "utf8")).includes('"text":"WAIT"'));
    await assert.rejects(agent.selectAgent({ kind: "pi" }), /停止/);
    await assert.rejects(agent.chooseWorkspace("/synthetic/other-workspace"), /停止/);
    await assert.rejects(agent.newSession(), /停止/);
    await agent.abort();
    assert.equal((await agent.snapshot()).agent, "codex");
  } finally {
    await agent?.close();
    await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
