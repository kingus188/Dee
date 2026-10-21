import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../dist/config.js";
import { startServerIntegrations } from "../dist/integrations.js";
import { openTeamsStore } from "../dist/teams-store.js";
import type { TeamsSender } from "../dist/teams-reply-port.js";

const account = { tenantId: "test", clientId: "test", username: "test", password: "not-a-real-password" };

test("offline ignores an explicitly configured malformed Teams file without attaching callbacks or making requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-integrations-offline-"));
  const store = openTeamsStore(dir);
  const sender: TeamsSender = {};
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must stay offline"); };
  try {
    await writeFile(join(dir, "teams-forward-config.json"), "not JSON");
    const close = startServerIntegrations({ config: readConfig({ PI_OFFLINE: "1", TEAMS_CONFIG_DIR: dir }), store, teamsSender: sender });
    await close();
    assert.deepEqual(sender, {});
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Teams is not implicitly enabled from DATA_DIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-integrations-explicit-"));
  const store = openTeamsStore(dir);
  try {
    await writeFile(join(dir, "teams-forward-config.json"), "not JSON");
    const sender: TeamsSender = {};
    await startServerIntegrations({ config: readConfig({ DATA_DIR: dir }), store, teamsSender: sender })();
    assert.deepEqual(sender, {});
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("invalid Teams configuration throws without exposing its contents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-integrations-invalid-"));
  const store = openTeamsStore(dir);
  const config = readConfig({ TEAMS_CONFIG_DIR: dir });
  try {
    for (const content of ["{\"password\":\"private-secret\",", "null", JSON.stringify({ account: { password: "private-secret" } }), JSON.stringify({ ginaHome: "/test", important: { keywords: 123 } })]) {
      await writeFile(join(dir, "teams-forward-config.json"), content);
      assert.throws(() => startServerIntegrations({ config, store, teamsSender: {} }), error => {
        assert.match(String(error), /Teams 配置无效/);
        assert.doesNotMatch(String(error), /private-secret/);
        return true;
      });
    }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Teams synchronizes with WeChat disabled and close detaches stale sender callbacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-integrations-sync-"));
  const store = openTeamsStore(dir);
  const sender: TeamsSender = {};
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    if (url.includes("login.microsoftonline.com")) return Response.json({ access_token: "test", expires_in: 3600 });
    if (url.includes("/me?")) return Response.json({ id: "me" });
    return Response.json({ value: [] });
  };
  let close = async () => {};
  try {
    await writeFile(join(dir, "teams-forward-config.json"), JSON.stringify({ account }));
    close = startServerIntegrations({ config: readConfig({ TEAMS_CONFIG_DIR: dir }), store, teamsSender: sender,
      wechat: { enabled: false, sendURL: "http://localhost:1/must-not-send", sendToken: "test", notify: async () => { throw new Error("disabled"); }, undelivered: async () => { throw new Error("disabled"); } } });
    const refresh = sender.refresh!;
    const send = sender.send!;
    assert.equal((await refresh()).ok, true);
    assert.ok(sender.syncStatus!().lastSuccessAt);
    assert.ok(requests.some(url => url.includes("graph.microsoft.com")));
    assert.ok(requests.every(url => !url.includes("localhost")));
    await close();
    const count = requests.length;
    assert.deepEqual(sender, {});
    assert.equal((await refresh()).ok, false);
    await assert.rejects(send("chat", "text"), /已停止/);
    assert.equal(requests.length, count);
  } finally { await close(); globalThis.fetch = original; store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("close drains an in-flight token request without starting Graph work after shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-integrations-close-"));
  const store = openTeamsStore(dir);
  const sender: TeamsSender = {};
  const original = globalThis.fetch;
  let finishToken!: (response: Response) => void;
  const token = new Promise<Response>(resolve => { finishToken = resolve; });
  const requests: string[] = [];
  globalThis.fetch = async input => { requests.push(String(input)); return token; };
  let close = async () => {};
  try {
    await writeFile(join(dir, "teams-forward-config.json"), JSON.stringify({ account }));
    close = startServerIntegrations({ config: readConfig({ TEAMS_CONFIG_DIR: dir }), store, teamsSender: sender });
    assert.equal(requests.length, 1);
    const stopped = close();
    assert.deepEqual(sender, {});
    finishToken(Response.json({ access_token: "test", expires_in: 3600 }));
    await stopped;
    assert.equal(requests.length, 1);
    await close();
  } finally { finishToken?.(Response.json({ access_token: "test" })); await close(); globalThis.fetch = original; store.close(); await rm(dir, { recursive: true, force: true }); }
});
