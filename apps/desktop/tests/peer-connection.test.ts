import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRequest, openPeerCredentials, PeerConnectionError } from "../dist/peer-connection.js";

test("peer credentials are encrypted, isolated by canonical server and reject plaintext storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dee-peer-auth-")), token = "a".repeat(43);
  const storage = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from([...text].map(char => char.charCodeAt(0) + 1)), decryptString: (bytes: Buffer) => [...bytes].map(byte => String.fromCharCode(byte - 1)).join("") };
  try {
    const credentials = openPeerCredentials(directory, storage);
    credentials.save("https://one.example", token);
    assert.equal(credentials.get("https://one.example"), token);
    assert.equal(credentials.get("https://two.example"), undefined);
    assert.ok(!(await readFile(join(directory, "desktop-peers.json"), "utf8")).includes(token));
    assert.throws(() => openPeerCredentials(directory, { ...storage, getSelectedStorageBackend: () => "basic_text" }).save("https://one.example", token));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("peer WebSocket uses scoped credentials and exact routes; health can probe an unpaired server", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let status = 200;
  let receive: (text: string) => void;
  const request = createAgentRequest({ origin: () => "https://lan.example", serverId: () => "https://public.example", username: () => undefined, password: () => undefined, token: server => { assert.equal(server, "https://public.example"); return "b".repeat(43); }, fetch: async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ items: [] }), { status });
  }, socket: (url, headers, origin) => {
    calls.push({ url, authorization: headers.authorization! }); assert.equal(origin, "https://lan.example");
    const socket = Object.assign(new EventTarget(), { readyState: 0, bufferedAmount: 0, close() { socket.readyState = 3; socket.dispatchEvent(new Event("close")); }, send(text: unknown) { receive(String(text)); } });
    receive = text => { const input = JSON.parse(text); const event = new Event("message"); Object.defineProperty(event, "data", { value: JSON.stringify(input.type === "peer-auth" ? { type: "peer-authenticated" } : { type: "response", id: input.id, status, data: { items: [] } }) }); socket.dispatchEvent(event); };
    queueMicrotask(() => { socket.readyState = 1; socket.dispatchEvent(new Event("open")); });
    return socket;
  } });
  try {
    await request("/api/info"); await request("/api/peers/devices");
    assert.deepEqual(calls, [{ url: "wss://lan.example/api/peers/socket", authorization: "Bearer " + "b".repeat(43) }]);
    await assert.rejects(request("https://evil.example/api/peers/devices"));
    await assert.rejects(request("/api/goals"));
    await assert.rejects(request("/api/info", {}));
    await assert.rejects(request("/api/peers/devices", undefined, "https://old.example"));
    status = 404; await assert.rejects(request("/api/peers/devices"), error => error instanceof PeerConnectionError && error.status === 404);
  } finally { request.close(); }
  const unpaired = createAgentRequest({ origin: () => "https://lan.example", serverId: () => "https://public.example", username: () => undefined, password: () => undefined, token: () => undefined, socket: () => { throw new Error("must not open without pairing"); }, fetch: async (_url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), null); return Response.json({ healthy: true });
  } });
  try { assert.deepEqual(await unpaired("/api/info"), { healthy: true }); await assert.rejects(unpaired("/api/peers/devices"), { status: 401 }); }
  finally { unpaired.close(); }
});
