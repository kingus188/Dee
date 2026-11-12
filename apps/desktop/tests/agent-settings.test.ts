import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentSettings, validateAgentSelection } from "../dist/agent-settings.js";
test("local assistant creates its default directory and upgrades an unselected legacy directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-default-directory-"));
  try {
    const settings = openAgentSettings(directory);
    const workspace = join(directory, "local-agent", "workspace");
    assert.equal(settings.get().workspace, workspace);
    assert.ok((await stat(workspace)).isDirectory());
    const path = join(directory, "desktop-agent.json");
    const stored = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...stored, workspace: null }));
    assert.equal(openAgentSettings(directory).get().workspace, workspace);
    settings.saveWorkspace(directory);
    assert.equal(openAgentSettings(directory).get().workspace, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("desktop settings preserve legacy model data without loading credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-settings-"));
  try {
    const settings = openAgentSettings(directory), id = settings.get().nodeId;
    const path = join(directory, "desktop-agent.json");
    assert.equal("model" in JSON.parse(await readFile(path, "utf8")), false);
    const legacy = { ...settings.get(), model: { model: "old-unused" }, encryptedKey: "legacy-ciphertext" };
    await writeFile(path, JSON.stringify(legacy));
    const reopened = openAgentSettings(directory);
    reopened.saveWorkspace(directory);
    assert.equal(reopened.get().nodeId, id);
    assert.equal("model" in reopened.get(), false);
    assert.equal(reopened.get().workspace, directory);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.model, legacy.model);
    assert.equal(saved.encryptedKey, legacy.encryptedKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("agent selection upgrades old settings, preserves Pi and rejects shell-style native arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-agent-selection-"));
  try {
    let settings = openAgentSettings(directory);
    assert.equal(settings.get().agent, "pi");
    settings.selectAgent({ kind: "codex", config: { executable: "/usr/local/bin/codex", args: [] } });
    settings = openAgentSettings(directory);
    assert.equal(settings.get().agent, "codex");
    assert.equal(settings.get().agents.codex.executable, "/usr/local/bin/codex");
    settings.selectAgent({ kind: "acp", config: { executable: "/opt/agent", args: ["literal $(touch unsafe)", "--stdio"], mode: "review" } });
    assert.deepEqual(settings.get().agents.acp.args, ["literal $(touch unsafe)", "--stdio"]);
    assert.throws(() => validateAgentSelection({ kind: "unknown" }), /类型/);
    assert.throws(() => validateAgentSelection({ kind: "codex", config: { executable: "codex", args: ["--dangerously-bypass-approvals-and-sandbox"] } }), /额外启动参数/);
    assert.throws(() => validateAgentSelection({ kind: "acp", config: { executable: "agent\ncommand", args: [] } }), /可执行文件/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
