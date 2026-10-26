import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("skills preload exposes only named operations and never a generic IPC or file API", async () => {
  const calls: unknown[][] = [];
  const bridges = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
  const source = readFileSync(new URL("../dist/skills-preload.cjs", import.meta.url), "utf8");
  runInNewContext(source, { exports: {}, require: (name: string) => {
    assert.equal(name, "electron"); return {
      contextBridge: { exposeInMainWorld: (key: string, value: Record<string, (...args: unknown[]) => unknown>) => { bridges.set(key, value); } },
      ipcRenderer: { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(null); } },
    };
  } });
  assert.deepEqual([...bridges.keys()].sort(), ["desktopServer", "localSkills"]);
  const server = bridges.get("desktopServer")!;
  assert.deepEqual(Object.keys(server), ["connect"]);
  await server.connect!("https://backend.example");
  assert.deepEqual(calls.shift(), ["desktop:server-connect", "https://backend.example"]);
  const exposed = bridges.get("localSkills");
  assert.ok(exposed);
  assert.deepEqual(Object.keys(exposed).sort(), ["version", "list", "read", "reveal", "addDirectory", "removeDirectory", "importSkill"].sort());
  await exposed.list!(); await exposed.read!("skill_id"); await exposed.reveal!("skill_id");
  await exposed.addDirectory!("/ignored"); await exposed.removeDirectory!("root_id"); await exposed.importSkill!("/ignored");
  assert.deepEqual(calls, [["desktop:skills-list"], ["desktop:skills-read", "skill_id"], ["desktop:skills-reveal", "skill_id"], ["desktop:skills-add-directory"], ["desktop:skills-remove-directory", "root_id"], ["desktop:skills-import"]]);
});
