import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModelCatalog, createPeerService, openRuntime, type PeerJob } from "@assistant/runtime";
import { openDesktopAgent } from "../dist/local-agent.js";
import { openAgentSettings } from "../dist/agent-settings.js";
import { createAgentRequest } from "../dist/peer-connection.js";
import { createHttpServer } from "../../server/dist/http/server.js";
import { readConfig } from "../../server/dist/config.js";
import type { AppContext } from "../../server/dist/application/context.js";

const model = { api: "faux", apiKey: "", baseUrl: "", model: "", contextWindow: 128000, maxTokens: 8192 };
const token = "local-test-only-".padEnd(43, "t");
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 12000;
  do { const value = await read(); if (ready(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  throw new Error("source transport integration timed out");
}

// Only the server runs in the child. The desktop in the test process communicates
// through production HTTP/WS, not direct service calls or fabricated projections.
if (process.argv[2] === "source-worker") {
  const directory = process.argv[3]!;
  let target = "", workspace = "", issue = false;
  const catalog = await createModelCatalog(model, () => {
    if (issue) { issue = false; return fauxAssistantMessage(fauxToolCall("delegate_to_peer", { target, workspace, task: "read fixture.txt" }), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("source acknowledged");
  });
  const peers = createPeerService({ nodeId: "server", configured: () => true, devices: async () => [target] });
  const runtime = await openRuntime({ dataDir: directory, ...catalog, extensions: [peers.extension, peers.accessExtension], beforeToolExecute: peers.guardTool, beforeResume: async value => { peers.bind(value, ctx); }, onReport: () => {} }, ctx);
  const app = { ...runtime, peers, ctx, config: readConfig({ NODE_ENV: "test", AUTH_DISABLED: "1", PEER_TOKEN: token }), wechat: null, redact: String, exitIfFatal: () => {} } as unknown as AppContext;
  const http = createHttpServer(app);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  process.send!({ ready: `http://127.0.0.1:${(http.address() as AddressInfo).port}` });
  process.on("message", async (message: { id: number; command: string; target?: string; workspace?: string; jobId?: string }) => {
    try {
      let value: unknown;
      if (message.command === "issue") {
        target = message.target!; workspace = message.workspace!; issue = true;
        await (await runtime.root.submit({ type: "input", content: "Read the approved desktop workspace fixture." }, ctx)).wait(ctx);
        value = (await peers.list()).at(-1);
      } else if (message.command === "cancel") value = await peers.requestCancel(message.jobId!);
      else if (message.command === "get") value = { job: await peers.get(message.jobId!), receipts: (await runtime.root.context(ctx)).entries.filter(entry => entry.kind === "app.peer-result").length };
      else if (message.command === "close") {
        http.closeSockets(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
        await peers.close(); await runtime.harness.close(ctx);
      } else throw new Error("unknown fixture command");
      process.send!({ id: message.id, value });
      if (message.command === "close") process.disconnect();
    } catch (error) { process.send!({ id: message.id, error: String(error) }); }
  });
} else for (const revoke of [false, true, "cancel-arrived-first"] as const) test(`two-process source proof over real WS/HTTP, cancelled during desktop confirmation=${revoke}`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "dee-source-transport-"));
  let closeDesktop: (() => Promise<void>) | undefined, closeTransport: (() => void) | undefined, releaseConfirmation: (() => void) | undefined;
  const child = fork(fileURLToPath(import.meta.url), ["source-worker", join(directory, "server")], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => {
    try { releaseConfirmation?.(); await closeDesktop?.(); }
    finally {
      closeTransport?.();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGKILL"); await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
  let sequence = 0;
  const command = <T>(name: string, fields: Record<string, unknown> = {}) => new Promise<T>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => fail(new Error(`source ${name} timed out: ${stderr}`)), 15000);
    function cleanup() { clearTimeout(timer); child.off("message", receive); child.off("exit", exited); }
    function fail(error: Error) { cleanup(); reject(error); }
    function exited() { fail(new Error(`source exited during ${name}: ${stderr}`)); }
    function receive(message: { id?: number; value: T; error?: string }) {
      if (message.id !== id) return;
      cleanup(); if (message.error) reject(new Error(message.error)); else resolve(message.value);
    }
    child.on("message", receive); child.once("exit", exited);
    child.send({ id, command: name, ...fields }, error => { if (error) fail(error); });
  });
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`source startup timed out: ${stderr}`)), 15000);
    child.once("message", (message: { ready: string }) => { clearTimeout(timer); resolve(message.ready); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`source startup exited ${code}: ${stderr}`)); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  const desktop = join(directory, "desktop"); await mkdir(desktop);
  const settings = openAgentSettings(desktop); settings.selectAgent({ kind: "pi", piAccess: "ask" });
  const secret = "approved-workspace-content-" + revoke;
  await writeFile(join(settings.get().workspace!, "fixture.txt"), secret);
  let entered = false, release!: () => void, proofRequests = 0, sockets = 0;
  const gate = new Promise<boolean>(resolve => { release = () => resolve(true); });
  releaseConfirmation = release;
  const results: string[] = [];
  const catalog = await createModelCatalog(model, transcript => {
    const last = transcript.messages.at(-1);
    if (last?.role === "toolResult") { results.push(JSON.stringify(last)); return fauxAssistantMessage("desktop checked"); }
    return fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });
  });
  const transport = createAgentRequest({ origin: () => origin, serverId: () => origin, username: () => undefined, password: () => undefined, token: () => token,
    socket: url => { sockets++; return new WebSocket(url); }, fetch: async (url, init) => { if (url.includes("/authority?")) proofRequests++; return fetch(url, init); },
  });
  closeTransport = () => transport.close();
  const agent = await openDesktopAgent({ directory: desktop, settings, request: transport, serverId: () => origin,
    confirm: async () => { entered = true; return gate; }, loadModels: async () => ({ ...catalog, model: { ...model, hasApiKey: false } }),
  });
  closeDesktop = () => agent.close();
  try {
    const job = await command<PeerJob>("issue", { target: settings.get().nodeId, workspace: settings.get().workspace });
    await until(() => agent.snapshot(), snapshot => snapshot.jobs.some(value => value.id === job.id));
    assert.equal(results.length, 0);
    await agent.approve(job.id); await until(async () => entered, Boolean);
    if (revoke) await command("cancel", { jobId: job.id });
    if (revoke === "cancel-arrived-first") {
      await until(() => agent.peerStatus(job.id), value => !!value.cancellation?.requestedAt);
      assert.equal(results.length, 0, "target receives cancellation before approval is released");
    }
    release();
    const final = await until(() => command<{ job: PeerJob; receipts: number }>("get", { jobId: job.id }), value => value.job.status === "done" || value.job.status === "failed");
    if (revoke) {
      assert.ok(final.job.cancellation?.requestedAt);
      if (results.length === 0) {
        // The pushed cancellation can abort the dedicated submission before a
        // denied tool result reaches another model turn. Require durable target
        // confirmation, not merely the absence of model output.
        const stopped = await until(() => agent.peerStatus(job.id), value => value.status === "failed" && !!value.cancellation?.confirmedAt);
        assert.ok(stopped.cancellation?.requestedAt);
        await until(() => agent.snapshot(), value => !value.busy);
        assert.equal(results.length, 0);
        const acknowledged = await until(() => command<{ job: PeerJob }>("get", { jobId: job.id }), value => value.job.status === "failed" && !!value.job.cancellation?.confirmedAt);
        assert.ok(!JSON.stringify([stopped, acknowledged]).includes(secret));
      } else {
        assert.equal(results.length, 1);
        assert.match(results[0]!, /源宿主授权缺失|范围已撤销|有效只读权限/);
      }
      assert.ok(results.every(value => !value.includes(secret)), "revoked source never exposes file content to model");
    } else {
      assert.equal(final.job.status, "done"); assert.equal(results.length, 1); assert.ok(results[0]!.includes(secret));
      await until(() => command<{ receipts: number }>("get", { jobId: job.id }), value => value.receipts === 1);
      await assert.rejects(agent.approve(job.id), /没有可批准/);
      assert.equal((await command<{ receipts: number }>("get", { jobId: job.id })).receipts, 1);
      assert.equal(results.length, 1);
    }
    assert.ok(sockets > 0); assert.ok(proofRequests > 0);
  } finally {
    release(); await agent.close(); closeDesktop = undefined; transport.close(); closeTransport = undefined;
    if (child.connected) await command("close");
  }
});
