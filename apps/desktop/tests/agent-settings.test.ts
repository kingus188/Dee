import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentSettings, validateDesktopModel } from "../dist/agent-settings.js";
const model = { api: "openai-completions", baseUrl: "https://model.example/v1", model: "fixture", apiKey: "local-test-secret", contextWindow: 128000, maxTokens: 8192 };
for (const available of [true, false]) test(`desktop model settings preserve identity and never store plaintext (${available})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-settings-"));
  const storage = { isEncryptionAvailable: () => available, encryptString: (text: string) => Buffer.from(text.split("").reverse().join("")), decryptString: (data: Buffer) => data.toString().split("").reverse().join("") };
  try {
    const settings = openAgentSettings(directory, storage), id = settings.get().nodeId;
    assert.equal(settings.saveModel(model).persistedKey, available);
    settings.saveWorkspace(directory);
    assert.equal(settings.get().model.apiKey, model.apiKey);
    assert.ok(!(await readFile(join(directory, "desktop-agent.json"), "utf8")).includes(model.apiKey));
    const reopened = openAgentSettings(directory, storage);
    assert.equal(reopened.get().nodeId, id);
    assert.equal(reopened.get().model.apiKey, available ? model.apiKey : "");
    assert.equal(reopened.get().workspace, directory);
    assert.equal(settings.saveModel({ ...model, apiKey: "" }).persistedKey, available);
    assert.equal(settings.get().model.apiKey, model.apiKey);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("desktop model input rejects remote HTTP, embedded credentials and invalid limits", () => {
  for (const change of [{ baseUrl: "http://model.example/v1" }, { baseUrl: "https://user:secret@model.example" }, { baseUrl: "https://model.example?key=secret" }, { api: "unknown" }, { maxTokens: 128001 }, { contextWindow: NaN }, { apiKey: 123 }]) assert.throws(() => validateDesktopModel({ ...model, ...change }));
  assert.equal(validateDesktopModel({ ...model, baseUrl: "http://127.0.0.1:11434/v1" }).baseUrl, "http://127.0.0.1:11434/v1");
});
