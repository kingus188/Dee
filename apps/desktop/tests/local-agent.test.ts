import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openAgentSettings } from "../dist/agent-settings.js";
import { openDesktopAgent } from "../dist/local-agent.js";

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const timeout = Date.now() + 15000;
  do { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < timeout);
  throw new Error("Timed out waiting for local Agent");
}
test("local Agent owns model, protects tools, persists approvals and returns one durable peer result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-local-agent-"));
  let calls = 0, allow = false;
  const toolResults: string[] = [];
  const model = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body) as { model: string; messages: Array<{role:string;content?:unknown}> };
    if (input.messages.at(-1)?.role === "tool") toolResults.push(JSON.stringify(input.messages.at(-1)?.content));
    calls++;
    const tool = input.messages.at(-1)?.role !== "tool";
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "read-fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] } : { role: "assistant", content: "本机验证完成" };
    const chunk = { id: "local-agent-test", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const storage = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" };
  const settings = openAgentSettings(directory, storage);
  settings.saveModel({ api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, model: "fixture", apiKey: "local-test-only", contextWindow: 128000, maxTokens: 8192 });
  settings.saveWorkspace(directory); await writeFile(join(directory, "fixture.txt"), "本机资料");
  const incoming = { id: randomUUID(), source: "server", target: settings.get().nodeId, task: "读取工作目录 fixture.txt", status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const completions: unknown[] = []; let confirms = 0;
  const options = { directory, settings, confirm: async () => { confirms++; return allow; }, request: async (path: string, body?: unknown) => {
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
    assert.equal(calls, 2); assert.equal(await readFile(join(directory, "fixture.txt"), "utf8"), "本机资料");
    await agent.close(); agent = await openDesktopAgent(options);
    await until(() => agent.snapshot(), snapshot => snapshot.jobs[0]?.status === "done");
    assert.equal(calls, 2, "reopening cannot repeat completed tools or generation");
    assert.match(toolResults[0]!, /用户未授权/);
    const id = randomUUID(); allow = true; await agent.send({ id, text: "本机聊天" });
    await until(() => agent.snapshot(), snapshot => !snapshot.busy && snapshot.messages.some(message => message.text === "本机验证完成"));
    assert.match(toolResults.at(-1)!, /本机资料/);
    const before = calls; await agent.send({ id, text: "本机聊天" });
    await until(() => agent.snapshot(), snapshot => !snapshot.busy);
    assert.equal(calls, before, "repeated send ID is one submission");
    assert.ok(completions.length > 0);
  } finally { await agent.close(); await new Promise<void>((resolve, reject) => model.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); }
});
