import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const entry = new URL("../dist/agent-ipc.js", import.meta.url);
const nativeRequire = createRequire(entry);

test("Agent IPC permits only the current workspace top frame on local or active service URLs", async () => {
  const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>();
  const calls: string[] = [];
  let origin = "https://assistant.example";
  const makeWindow = () => ({ destroyed: false, isDestroyed() { return this.destroyed; }, webContents: { mainFrame: { url: "dee://local/" } } });
  let window = makeWindow();
  let confirm: (() => Promise<boolean>) | undefined;
  let confirmations = 0;
  const exported: { registerDesktopAgent?: (options: unknown) => Promise<unknown> } = {};
  const compiled = transpileModule(readFileSync(entry, "utf8"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { exports: exported, Error, require(name: string) {
    if (name === "electron") return { dialog: {
      showMessageBox: async (owner: unknown) => { assert.equal(owner, window); confirmations++; return { response: 1 }; },
      showOpenDialog: async (owner: unknown) => { assert.equal(owner, window); return { canceled: false, filePaths: ["/workspace"] }; },
    } };
    if (name === "./agent-settings.js") return { openAgentSettings: () => ({}) };
    if (name === "./local-agent.js") return { openDesktopAgent: async (options: { confirm(tool: string, args: unknown): Promise<boolean> }) => {
      confirm = () => options.confirm("write", { path: "/workspace/file" });
      return Object.fromEntries(["snapshot", "newSession", "answerApproval", "send", "approve", "reject", "abort", "chooseWorkspace"].map(name => [name, async () => { calls.push(name); return name; }]));
    } };
    return nativeRequire(name);
  } });
  await exported.registerDesktopAgent!({
    ipc: { handle: (name: string, handler: (event: unknown, input?: unknown) => Promise<unknown>) => handlers.set(name, handler) },
    directory: "/synthetic", localUrl: "dee://local/", getWindow: () => window, getOrigin: () => origin,
    request: async () => {}, openServer: async () => { calls.push("openServer"); }, openConnection: () => { calls.push("openConnection"); },
  });
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const invoke = (name: string, caller: unknown = event(), input?: unknown) => handlers.get(`desktop:agent:${name}`)!(caller, input);
  for (const url of ["dee://local/", "dee://local/#chat", "https://assistant.example/", "https://assistant.example/app?view=1#chat"]) {
    window.webContents.mainFrame.url = url;
    assert.equal(await invoke("snapshot"), "snapshot");
  }
  for (const url of ["dee://other/", "dee://local/other", "dee://local/?query=1", "file:///workspace/index.html", "https://foreign.example/", "https://assistant.example.evil/", "https://assistant.example:444/", "https://fixture@assistant.example/"]) {
    window.webContents.mainFrame.url = url;
    await assert.rejects(invoke("snapshot"), /Untrusted/);
  }
  window.webContents.mainFrame.url = "https://assistant.example/#chat";
  const old = window;
  await assert.rejects(invoke("snapshot", { sender: window.webContents, senderFrame: { url: window.webContents.mainFrame.url } }), /Untrusted/);
  window = makeWindow();
  await assert.rejects(invoke("snapshot", { sender: old.webContents, senderFrame: old.webContents.mainFrame }), /Untrusted/);
  origin = "https://changed.example";
  window.webContents.mainFrame.url = "https://assistant.example/";
  await assert.rejects(invoke("snapshot"), /Untrusted/);
  window.webContents.mainFrame.url = "https://changed.example/#chat";
  assert.equal(await invoke("snapshot"), "snapshot");
  window.webContents.mainFrame.url = "dee://local/#settings";
  for (const name of ["new-session", "answer-approval", "send", "approve", "reject", "abort", "choose-workspace", "open-connection"]) await invoke(name);
  await invoke("open-server", event(), "#tasks");
  await assert.rejects(invoke("open-server", event(), "https://foreign.example"), /无效/);
  assert.deepEqual(calls.slice(-9), ["newSession", "answerApproval", "send", "approve", "reject", "abort", "chooseWorkspace", "openConnection", "openServer"]);
  assert.equal(await confirm!(), true);
  assert.equal(confirmations, 1);
  window.destroyed = true;
  await assert.rejects(invoke("snapshot"), /Untrusted/);
  assert.equal(await confirm!(), false);
  assert.equal(confirmations, 1);
});
