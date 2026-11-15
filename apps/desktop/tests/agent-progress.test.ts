import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openExternalAgents } from "../dist/agents/service.js";
import type { DriverOptions } from "../dist/agents/types.js";

test("snapshot polling does not manufacture provider activity and progress resets per request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-progress-"));
  let config: DriverOptions | undefined, finish: (() => void) | undefined;
  const service = openExternalAgents({ directory, binding: () => ({ kind: "codex", cwd: directory, config: { executable: "fixture", args: [] } }), factory: async (_kind, options) => {
    config = options;
    return { send: () => new Promise<void>(resolve => { finish = resolve; }), close: async () => {}, abort: async () => {} };
  } });
  try {
    await service.send({ id: "first", text: "work" });
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    const start = service.snapshot().external.progress!;
    assert.equal(start.requestId, "first"); assert.equal(start.lastEventAt, undefined);
    assert.deepEqual(service.snapshot().external.progress, start);
    config!.emit({ type: "text", id: "result", text: "working" });
    const observed = service.snapshot().external.progress!;
    assert.ok(observed.lastEventAt); assert.deepEqual(service.snapshot().external.progress, observed);
    finish(); while (service.busy) await new Promise(resolve => setTimeout(resolve, 1));
    await service.send({ id: "second", text: "continue" });
    assert.equal(service.snapshot().external.progress?.requestId, "second");
    assert.equal(service.snapshot().external.progress?.lastEventAt, undefined);
    while (!service.busy) await new Promise(resolve => setTimeout(resolve, 1));
    finish(); while (service.busy) await new Promise(resolve => setTimeout(resolve, 1));
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
