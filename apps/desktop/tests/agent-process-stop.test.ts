import assert from "node:assert/strict";
import test from "node:test";
import { spawnAgent, stopAgent } from "../dist/agents/process.js";

const child = () => ({ pid: 12345, exitCode: null, signalCode: null }) as ReturnType<typeof spawnAgent>;
const failure = (code: string) => Object.assign(new Error(`kill ${code}`), { code });

test("stop waits through an inconclusive macOS exit probe until the owned group disappears", { skip: process.platform === "win32" }, async t => {
  let probes = 0;
  const kill = t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    assert.equal(pid, -12345);
    if (signal === "SIGTERM") return true;
    assert.equal(signal, 0);
    throw failure(++probes < 3 ? "EPERM" : "ESRCH");
  });
  const owned = child();
  const stopping = stopAgent(owned);
  assert.equal(stopAgent(owned), stopping);
  await stopping;
  assert.equal(probes, 3);
  assert.equal(kill.mock.callCount(), 4);
});

test("stop still rejects denied termination signals", { skip: process.platform === "win32" }, async t => {
  const denied = failure("EPERM");
  const kill = t.mock.method(process, "kill", () => { throw denied; });
  await assert.rejects(stopAgent(child()), error => error === denied);
  assert.equal(kill.mock.callCount(), 1);
});

test("an inconclusive probe has a deadline and never reports successful termination", { skip: process.platform === "win32" }, async t => {
  const signals: Array<string | number | undefined> = [];
  t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    signals.push(signal);
    if (signal === "SIGTERM") return true;
    throw failure("EPERM");
  });
  await assert.rejects(stopAgent(child()), /无法确认 Agent/);
  assert.deepEqual(signals.filter(signal => signal !== 0), ["SIGTERM"], "unknown probe results must not trigger forced signalling");
});
