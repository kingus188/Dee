import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentSessionStore } from "../dist/agents/store.js";
import { openExternalAgents } from "../dist/agents/service.js";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dee-session-store-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const binding = JSON.stringify({ kind: "codex", cwd: "/tmp", config: { executable: "fixture", args: [] } });
const record = (directory: string, id: string) => join(directory, "external-agent-sessions", `${createHash("sha256").update(id).digest("hex")}.json`);

test("legacy history exceeding the former aggregate limit migrates without deleting history", async () => temporary(async directory => {
  const path = join(directory, "external-agent-sessions.json");
  const sessions = Array.from({ length: 22 }, (_, i) => ({ id: String(i), binding, status: "done", messages: [{ id: "m", role: "assistant", text: "x".repeat(1_000_000) }], activities: [] }));
  const original = JSON.stringify({ version: 1, sessions });
  await writeFile(path, original);
  const store = openAgentSessionStore(directory);
  assert.equal(store.error, undefined);
  const next = store.create(binding);
  next.messages.push({ id: "new", role: "user", text: "continue" }); store.persist(next);
  assert.equal(await readFile(`${path}.v1.backup`, "utf8"), original);
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
  const reopened = openAgentSessionStore(directory);
  assert.equal(reopened.history().length, 23);
  assert.equal(reopened.byId("0")!.messages[0]!.text.length, 1_000_000);
  assert.equal(reopened.byId(next.id)!.messages[0]!.text, "continue");
}));

test("persisting a session does not rewrite unrelated history and missing records fail closed", async () => temporary(async directory => {
  const store = openAgentSessionStore(directory);
  const first = store.create(binding), second = store.create(binding);
  const previous = await readFile(record(directory, first.id), "utf8");
  first.messages.push({ id: "unsaved", role: "user", text: "not persisted" });
  second.messages.push({ id: "saved", role: "user", text: "persisted" }); store.persist(second);
  assert.equal(await readFile(record(directory, first.id), "utf8"), previous);
  assert.equal(openAgentSessionStore(directory).byId(second.id)!.messages.length, 1);
  await rm(record(directory, first.id));
  const broken = openAgentSessionStore(directory);
  assert.match(broken.error!, /原文件已保留/);
  assert.throws(() => broken.create(binding));
  assert.equal((await readdir(join(directory, "external-agent-sessions"))).length, 1);
}));

test("streaming writes are coalesced while final state is immediately flushed", async () => temporary(async directory => {
  let emit!: (text: string) => void, complete!: () => void;
  const service = openExternalAgents({ directory, binding: () => JSON.parse(binding), factory: async (_kind, options) => ({
    close: async () => {}, abort: async () => {}, send: async () => {
      emit = text => options.emit({ type: "text", id: "reply", text, delta: true });
      await new Promise<void>(resolve => { complete = resolve; });
    },
  }) });
  try {
    await service.send({ id: "turn", text: "hello" });
    while (!emit) await new Promise(resolve => setTimeout(resolve, 1));
    const path = record(directory, service.sessions()[0]!.sessionId);
    for (let i = 0; i < 100; i++) emit("x");
    assert.equal(service.snapshot().messages[1]!.text.length, 100);
    assert.equal(JSON.parse(await readFile(path, "utf8")).messages.length, 1, "deltas are not individually persisted");
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(JSON.parse(await readFile(path, "utf8")).messages[1].text.length, 100);
    emit("final"); complete();
    while (service.busy) await new Promise(resolve => setTimeout(resolve, 1));
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.status, "done"); assert.equal(saved.messages[1].text.length, 105);
    assert.equal(saved.requests.turn.status, "done");
  } finally { complete?.(); await service.close(); }
}));


test("failed migration leaves the legacy file authoritative and can be retried", async () => temporary(async directory => {
  const path = join(directory, "external-agent-sessions.json");
  const original = JSON.stringify({ version: 1, sessions: [{ id: "legacy", binding, status: "done", messages: [], activities: [] }] });
  await writeFile(path, original);
  await mkdir(`${path}.tmp`);
  const store = openAgentSessionStore(directory);
  assert.throws(() => store.create(binding));
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(openAgentSessionStore(directory).history().length, 1);
  await rm(`${path}.tmp`, { recursive: true });
  store.create(binding);
  assert.equal(openAgentSessionStore(directory).history().length, 2);
}));
