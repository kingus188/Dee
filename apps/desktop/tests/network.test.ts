import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { isOnLocalNetwork, selectServer, transportUrl } from "../dist/network.js";
import { validateLanUrl } from "../dist/policy.js";

const origin = "https://192.168.31.5:3443", publicUrl = "https://assistant.example";
const certificate = readFileSync(new URL("../tests/fixtures/certificate.pem", import.meta.url), "utf8");
const pin = { origin, certificate }, validAt = Date.parse(new X509Certificate(certificate).validFrom) + 1000;
const interfaces = { en0: [{ family: "IPv4" as const, internal: false, address: "192.168.31.25", netmask: "255.255.255.0" }] };
const identity = { pid: 1234, startedAt: "2026-11-05T05:21:37.542Z", boots: 5 };

test("LAN candidates require HTTPS private IPv4 roots and a matching local subnet", () => {
  for (const url of [origin, "https://10.0.0.1", "https://172.16.0.1", "https://172.31.255.1"]) assert.equal(validateLanUrl(url), url);
  for (const url of ["http://192.168.31.5", "https://assistant.example", "https://8.8.8.8", "https://172.32.0.1", "https://127.0.0.1", origin + "/api", origin + "?secret=x"]) assert.throws(() => validateLanUrl(url));
  assert.equal(isOnLocalNetwork(origin, interfaces), true);
  assert.equal(isOnLocalNetwork("https://192.168.32.5", interfaces), false);
  assert.equal(isOnLocalNetwork(origin, { loopback: [{ ...interfaces.en0[0]!, internal: true }] }), false);
  assert.equal(isOnLocalNetwork(origin, { vpn: [{ ...interfaces.en0[0]!, netmask: "0.0.0.0" }] }), false);
});

test("a provisioned LAN certificate is auto-discovered only when both endpoints identify the same server", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: validAt });
  const probes: string[] = [];
  const result = await selectServer({ url: publicUrl }, pin, undefined, { interfaces, probe: async url => { probes.push(url); return identity; } });
  assert.deepEqual(result, { origin, lanUrl: origin });
  assert.deepEqual(probes.sort(), [origin, publicUrl].sort());
  for (const wrong of [{ ...identity, pid: 99 }, { ...identity, boots: 6 }, { ...identity, startedAt: "2026-11-04T05:21:37.542Z" }, null]) {
    assert.deepEqual(await selectServer({ url: publicUrl }, pin, undefined, { interfaces, probe: async url => url === origin ? wrong : identity }), { origin: publicUrl });
  }
});

test("unknown, expired and off-network candidates are never probed", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: validAt });
  let calls = 0;
  const probe = async () => { calls++; return identity; };
  for (const value of [undefined, {}, { origin: "https://8.8.8.8", certificate }, { origin, certificate: "malformed" }]) {
    assert.deepEqual(await selectServer({ url: publicUrl }, value, undefined, { interfaces, probe }), { origin: publicUrl });
  }
  assert.deepEqual(await selectServer({ url: publicUrl }, pin, undefined, { interfaces: {}, probe }), { origin: publicUrl });
  t.mock.timers.setTime(Date.parse(new X509Certificate(certificate).validTo) + 1);
  assert.deepEqual(await selectServer({ url: publicUrl }, pin, undefined, { interfaces, probe }), { origin: publicUrl });
  assert.equal(calls, 0);
});

test("a remembered LAN alias works while public access is down and falls back on probe errors", async () => {
  const probes: string[] = [];
  assert.deepEqual(await selectServer({ url: publicUrl, lanUrl: origin }, pin, undefined, { interfaces, probe: async url => { probes.push(url); return identity; } }), { origin, lanUrl: origin });
  assert.deepEqual(probes, [origin]);
  for (const probe of [async () => null, async () => { throw new Error("offline"); }]) {
    assert.deepEqual(await selectServer({ url: publicUrl, lanUrl: origin }, pin, undefined, { interfaces, probe }), { origin: publicUrl });
  }
});

test("transport rewriting keeps logical device identity and never changes another server's URL", () => {
  assert.equal(transportUrl(publicUrl + "/api/devices/me?cursor=42", publicUrl, origin), origin + "/api/devices/me?cursor=42");
  for (const url of ["https://other.example/api/devices/me", "https://assistant.example.evil.test/api", "https://user@assistant.example/api"]) assert.equal(transportUrl(url, publicUrl, origin), url);
  assert.throws(() => transportUrl(publicUrl + "/api", publicUrl, "http://192.168.31.5"));
});
