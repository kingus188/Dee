import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const entry = new URL("../dist/agent-ipc.js", import.meta.url);
const nativeRequire = createRequire(entry);

for (const fails of [false, true]) test(`Agent shutdown drains admitted snapshot before closing runtime (snapshot fails=${fails})`, async () => {
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  const window = { isDestroyed: () => false, webContents: { mainFrame: { url: "dee://local/" } } };
  let release!: () => void, started!: () => void, closed = false, closes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const exported: { registerDesktopAgent?: (options: unknown) => Promise<{ close(): Promise<void> }> } = {};
  const compiled = transpileModule(readFileSync(entry, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { exports: exported, Error, require(name: string) {
    if (name === "electron") return { dialog: {} };
    if (name === "./agent-settings.js") return { openAgentSettings: () => ({}) };
    if (name === "./local-agent.js") return { openDesktopAgent: async () => ({
      async snapshot() { started(); await held; assert.equal(closed, false, "runtime must stay open for an admitted snapshot"); if (fails) throw new Error("snapshot failed"); return "snapshot"; },
      async close() { closes++; closed = true; },
    }) };
    return nativeRequire(name);
  } });
  const agent = await exported.registerDesktopAgent!({ ipc: { handle: (name: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(name, handler) }, directory: "/synthetic", localUrl: "dee://local/", getWindow: () => window, getOrigin: () => "https://assistant.example", request: async () => {}, openServer: async () => {}, openConnection() {} });
  const invoke = () => handlers.get("desktop:agent:snapshot")!({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const pending = invoke();
  await admitted;
  const closing = agent.close();
  assert.equal(closed, false);
  assert.equal(agent.close(), closing, "cleanup is idempotent");
  await assert.rejects(invoke(), /退出/);
  release();
  if (fails) await assert.rejects(pending, /snapshot failed/);
  else assert.equal(await pending, "snapshot");
  await closing;
  assert.equal(closed, true);
  assert.equal(closes, 1);
});
