import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("skills preload exposes only named operations and never a generic IPC or file API", async () => {
  const calls: unknown[][] = [];
  const bridges = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
  const source = readFileSync(new URL("../dist/skills-preload.cjs", import.meta.url), "utf8");
  runInNewContext(source, { exports: {}, process: { platform: "darwin" }, require: (name: string) => {
    assert.equal(name, "electron"); return {
      contextBridge: { exposeInMainWorld: (key: string, value: Record<string, (...args: unknown[]) => unknown>) => { bridges.set(key, value); } },
      ipcRenderer: { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(null); } },
    };
  } });
  assert.deepEqual([...bridges.keys()].sort(), ["desktopAgent", "desktopConnection", "desktopServer", "localSkills"]);
  const agent = bridges.get("desktopAgent")!;
  assert.equal(agent.platform, "darwin");
  const operations: [string, string, unknown[]][] = [
    ["snapshot", "snapshot", []], ["selectAgent", "select-agent", ["native"]], ["newSession", "new-session", []],
    ["answerApproval", "answer-approval", [{ id: "approval", allow: true }]], ["send", "send", [{ text: "hello" }]],
    ["peerSessions", "peer-sessions", ["server"]], ["readPeerSession", "read-peer-session", [{ id: "session" }]],
    ["sendPeer", "send-peer", [{ text: "relay" }]], ["peerStatus", "peer-status", ["peer"]],
    ["chooseWorkspace", "choose-workspace", []], ["approve", "approve", ["approval"]], ["reject", "reject", ["approval"]],
    ["abort", "abort", []], ["openServer", "open-server", ["#tasks"]], ["openConnection", "open-connection", []],
  ];
  assert.deepEqual(Object.keys(agent).sort(), ["platform", ...operations.map(([name]) => name)].sort());
  for (const [method, channel, args] of operations) {
    await agent[method]!(...args);
    assert.deepEqual(calls.shift(), [`desktop:agent:${channel}`, ...args]);
  }
  const server = bridges.get("desktopServer")!;
  assert.deepEqual(Object.keys(server), ["platform", "connect", "openSettings", "notificationStatus"]);
  assert.equal(server.platform, "darwin");
  await server.connect!("https://backend.example");
  assert.deepEqual(calls.shift(), ["desktop:server-connect", "https://backend.example"]);
  await server.openSettings!(); await server.notificationStatus!();
  assert.deepEqual(calls.splice(0), [["desktop:connection-open"], ["desktop:notification-status"]]);
  const exposed = bridges.get("localSkills");
  assert.ok(exposed);
  assert.deepEqual(Object.keys(exposed).sort(), ["version", "list", "read", "reveal", "addDirectory", "removeDirectory", "importSkill"].sort());
  await exposed.list!(); await exposed.read!("skill_id"); await exposed.reveal!("skill_id");
  await exposed.addDirectory!("/ignored"); await exposed.removeDirectory!("root_id"); await exposed.importSkill!("/ignored");
  assert.deepEqual(calls, [["desktop:skills-list"], ["desktop:skills-read", "skill_id"], ["desktop:skills-reveal", "skill_id"], ["desktop:skills-add-directory"], ["desktop:skills-remove-directory", "root_id"], ["desktop:skills-import"]]);
});
