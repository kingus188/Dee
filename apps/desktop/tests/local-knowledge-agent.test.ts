import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openAgentSettings } from "../dist/agent-settings.js";
import { openDesktopAgent } from "../dist/local-agent.js";
import { createModelCatalog, peerPayloadDigest } from "@assistant/runtime";
import { createLocalKnowledge } from "../dist/local-knowledge.js";
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 12000;
  while (!await read()) { if (Date.now() > deadline) throw new Error("timeout"); await new Promise(r => setTimeout(r, 20)); }
}
test("real desktop tool confirms local searches and refuses peer access to selected knowledge", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dee-knowledge-agent-"));
  let ownedServer: ReturnType<typeof createServer> | undefined;
  let ownedAgent: Awaited<ReturnType<typeof openDesktopAgent>> | undefined;
  t.after(async () => {
    try { await ownedAgent?.close(); }
    finally {
      ownedServer?.closeAllConnections();
      if (ownedServer?.listening) await new Promise<void>(resolve => ownedServer!.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  const settings = openAgentSettings(directory); settings.saveKnowledgeDirectory(settings.get().workspace!);
  settings.selectAgent({ kind: "pi", piAccess: "ask" });
  await writeFile(join(settings.get().workspace!, "notes.txt"), "unique-local-evidence");
  let allow = false, confirms = 0, revokeDuringConfirm = false, readNext = false;
  const results: string[] = [];
  const server = ownedServer = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body), last = input.messages.at(-1); let tool = last?.role !== "tool";
    if (!tool) results.push(JSON.stringify(last.content));
    let readArgs: unknown;
    if (!tool && readNext) {
      const text = typeof last.content === "string" ? last.content : last.content.map((part: {text?:string}) => part.text ?? "").join("");
      const hit = JSON.parse(text).hits[0];
      readArgs = { path: hit.path, revision: hit.revision, line: hit.line }; tool = true; readNext = false;
    }
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: readArgs ? "read_local_knowledge" : "search_local_knowledge", arguments: JSON.stringify(readArgs ?? { query: "unique-local-evidence" }) } }] } : { role: "assistant", content: "done" };
    const chunk = { id: "knowledge-test", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: null }] };
    res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const config = { api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as {port:number}).port}/v1`, model: "fixture", apiKey: "fixture-only", contextWindow: 128000, maxTokens: 8192 };
  const incoming = { id: randomUUID(), source: "server", target: settings.get().nodeId, task: "search local knowledge", status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let exposePeer = false;
  const agent = ownedAgent = await openDesktopAgent({ directory, settings, confirm: async () => { confirms++; if (revokeDuringConfirm) queueMicrotask(() => queueMicrotask(() => { settings.saveKnowledgeDirectory(null); settings.saveKnowledgeDirectory(settings.get().workspace!); })); return allow; },
    loadModels: async () => ({ ...await createModelCatalog(config), model: { ...config, hasApiKey: true } }),
    request: async path => {
      if (path.includes("/authority?")) return { authority: { id: incoming.id, revision: 1, expiresAt: Date.now() + 60000, payloadDigest: peerPayloadDigest(incoming as import("@assistant/runtime").PeerJob), tools: ["read"] } };
      if (path.includes("/complete")) return { item: { ...incoming, status: "done", result: "done" } };
      return { items: exposePeer ? [incoming] : [] };
    } });
  await agent.send({ id: randomUUID(), text: "search" });
  await until(async () => results.length === 1 && !(await agent.snapshot()).busy);
  assert.match(results[0], /用户未授权/); assert.doesNotMatch(results[0], /notes.txt/); assert.equal(confirms, 1);
  allow = true; readNext = true;
  await agent.send({ id: randomUUID(), text: "search again" });
  await until(async () => results.length === 3 && !(await agent.snapshot()).busy);
  assert.match(results[1], /notes.txt/); assert.match(results[1], /unique-local-evidence/); assert.equal(confirms, 3);
  assert.match(results[2], /current_observed_snapshot/); assert.match(results[2], /unique-local-evidence/);
  revokeDuringConfirm = true;
  await agent.send({ id: randomUUID(), text: "search while directory is reselected" });
  await until(async () => results.length === 4 && !(await agent.snapshot()).busy);
  assert.match(results[3], /确认期间资料目录已变更/); assert.doesNotMatch(results[3], /unique-local-evidence|notes.txt/);
  revokeDuringConfirm = false;
  exposePeer = true;
  await until(async () => (await agent.snapshot()).jobs.some(j => j.id === incoming.id));
  await agent.approve(incoming.id);
  await until(async () => results.length === 5 && (await agent.snapshot()).jobs.some(j => j.id === incoming.id && j.status === "done"));
  assert.doesNotMatch(results[4], /unique-local-evidence|notes.txt/); assert.match(results[4], /scope|权限|允许|授权/i);
  assert.equal(confirms, 4, "peer rejection precedes local tool confirmation");
});
test("knowledge versions bind selection generation and exact bytes, credentials are withheld", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dee-knowledge-version-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let revision = 0;
  const reader = createLocalKnowledge(() => ({ directory, revision }));
  await writeFile(join(directory, "a.txt"), "evidence");
  const hit = (await reader.search("evidence")).hits[0];
  revision++;
  await assert.rejects(reader.read(hit.path, hit.revision), /版本已变化/);
  const fresh = (await reader.search("evidence")).hits[0];
  await writeFile(join(directory, "a.txt"), "\ufeffevidence");
  await assert.rejects(reader.read(fresh.path, fresh.revision), /版本已变化/);
  await writeFile(join(directory, "a.txt"), "evidence api_key=sk-abcdefghijklmnopqrstuvwxyz123456");
  const secret = await reader.search("evidence"); assert.equal(secret.hits.length, 0); assert.equal(secret.status, "partial");
});
