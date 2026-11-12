import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("local Agent preload exposes platform without the server window bridge", async () => {
  const source = await readFile(new URL("../dist/agent-preload.cjs", import.meta.url), "utf8");
  const bridges = new Map<string, Record<string, unknown>>();
  runInNewContext(source, { exports: {}, process: { platform: "darwin" }, require: (name: string) => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (key: string, value: Record<string, unknown>) => bridges.set(key, value) }, ipcRenderer: { invoke: async () => {} } };
  } });
  assert.deepEqual([...bridges.keys()], ["desktopAgent"]);
  assert.equal(bridges.get("desktopAgent")!.platform, "darwin");
});
