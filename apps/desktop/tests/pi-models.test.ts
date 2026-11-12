import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPiModels } from "../dist/pi-models.js";
import { openAgentSettings } from "../dist/agent-settings.js";
import { openDesktopAgent } from "../dist/local-agent.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "dee-native-pi-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pkg = join(directory, "node_modules/@earendil-works/pi-coding-agent"), bin = join(directory, "bin");
  await mkdir(pkg, { recursive: true }); await mkdir(bin);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "./index.js", exports: { ".": { import: "./index.js" } } }));
  await writeFile(join(pkg, "cli.js"), "#!/usr/bin/env node\n");
  await chmod(join(pkg, "cli.js"), 0o755); await symlink(join(pkg, "cli.js"), join(bin, "pi"));
  await writeFile(join(pkg, "index.js"), `
export const state = { configured: true, missing: false, broken: false, calls: [] };
export const SettingsManager = { create(cwd, directory) {
  state.calls.push({ cwd, directory });
  return { getDefaultProvider: () => "native-provider", getDefaultModel: () => "native-model", drainErrors: () => [] };
} };
export const ModelRuntime = { async create(options) {
  state.calls.push(options);
  if (state.broken) throw new Error("fixture-secret-must-not-leak");
  return {
    getError: () => undefined,
    hasConfiguredAuth: provider => provider === "native-provider" && state.configured,
    getModel: (provider, id) => !state.missing && provider === "native-provider" && id === "native-model" ? {
      id, provider, api: "openai-responses", baseUrl: "https://native.invalid/?secret=fixture-secret-must-not-leak",
      contextWindow: 64000, maxTokens: 4096, headers: { authorization: "fixture-secret-must-not-leak" }
    } : undefined
  };
} };
`);
  const { state } = await import(pathToFileURL(join(pkg, "index.js")).href) as { state: { configured: boolean; missing: boolean; broken: boolean; calls: unknown[] } };
  return { directory, bin, state, options: { cwd: directory, searchPath: bin, env: { PI_CODING_AGENT_DIR: join(directory, "native-config") } } };
}

test("Pi uses its installed SDK, workspace settings and native auth without exposing credentials", async t => {
  const f = await fixture(t);
  const catalog = await loadPiModels(f.options);
  assert.equal(catalog.configured, true);
  assert.deepEqual(catalog.agentModel, { provider: "native-provider", modelId: "native-model" });
  assert.equal(catalog.model.model, "native-model");
  assert.equal(catalog.model.contextWindow, 64000);
  assert.equal(catalog.model.baseUrl, "");
  assert.equal("apiKey" in catalog.model, false);
  assert.ok(!JSON.stringify(catalog.model).includes("fixture-secret"));
  assert.deepEqual(f.state.calls, [
    { cwd: f.directory, directory: f.options.env.PI_CODING_AGENT_DIR },
    { allowModelNetwork: false, authPath: join(f.options.env.PI_CODING_AGENT_DIR, "auth.json"), modelsPath: join(f.options.env.PI_CODING_AGENT_DIR, "models.json") },
  ]);
});

test("missing Pi model, auth or compatible SDK fails closed with safe guidance", async t => {
  const f = await fixture(t);
  f.state.configured = false;
  let catalog = await loadPiModels(f.options);
  assert.equal(catalog.configured, false); assert.match(catalog.error!, /认证/);
  f.state.missing = true;
  catalog = await loadPiModels(f.options);
  assert.equal(catalog.configured, false); assert.match(catalog.error!, /默认模型/);
  f.state.broken = true;
  catalog = await loadPiModels(f.options);
  assert.equal(catalog.configured, false); assert.match(catalog.error!, /SDK/);
  assert.ok(!JSON.stringify(catalog).includes("fixture-secret"));
});

test("unavailable Pi config does not prevent switching to Codex", async t => {
  const f = await fixture(t);
  f.state.broken = true;
  const settings = openAgentSettings(f.directory);
  const agent = await openDesktopAgent({ directory: f.directory, settings, searchPath: f.bin,
    env: f.options.env, confirm: async () => false, request: async () => ({ items: [] }) });
  t.after(() => agent.close());
  let snapshot = await agent.snapshot();
  assert.equal(snapshot.piConfigured, false);
  assert.match(snapshot.error!, /Pi/);
  await agent.selectAgent({ kind: "codex", config: { executable: process.execPath, args: [] } });
  snapshot = await agent.snapshot();
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.error, undefined);
});
