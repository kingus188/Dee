import assert from "node:assert/strict";
import test from "node:test";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isPinnedCertificate } from "../dist/certificate-trust.js";

// Public certificate fixture; no private key is included or required.
const pem = readFileSync(new URL("../tests/fixtures/certificate.pem", import.meta.url), "utf8");
const certificate = new X509Certificate(pem);
const origin = "https://192.168.31.5:3443", hostname = "192.168.31.5";
const pin = { origin, certificate: pem };
const validAt = Date.parse(certificate.validFrom) + 1000;

test("desktop certificate trust requires an exact configured origin and hostname", t => {
  t.mock.timers.enable({ apis: ["Date"], now: validAt });
  assert.equal(isPinnedCertificate(origin, pin, hostname, pem), true);
  assert.equal(isPinnedCertificate("https://192.168.31.5:3444", pin, hostname, pem), false);
  assert.equal(isPinnedCertificate(origin, pin, "other.example", pem), false);
  const http = "http://192.168.31.5";
  assert.equal(isPinnedCertificate(http, { ...pin, origin: http }, hostname, pem), false);
  const other = "https://other.example";
  assert.equal(isPinnedCertificate(other, { ...pin, origin: other }, "other.example", pem), false);
});

test("desktop certificate trust rejects missing pins, malformed data and changed certificates", t => {
  t.mock.timers.enable({ apis: ["Date"], now: validAt });
  for (const value of [undefined, null, {}, { origin, certificate: "invalid" }]) {
    assert.equal(isPinnedCertificate(origin, value, hostname, pem), false);
  }
  const changed = Buffer.from(certificate.raw);
  changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
  assert.equal(isPinnedCertificate(origin, pin, hostname, new X509Certificate(changed).toString()), false);
  assert.equal(isPinnedCertificate(origin, pin, hostname, "invalid"), false);
});

test("desktop certificate trust rejects expired and not-yet-valid certificates", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(certificate.validFrom) - 1 });
  assert.equal(isPinnedCertificate(origin, pin, hostname, pem), false);
  t.mock.timers.setTime(Date.parse(certificate.validTo) + 1);
  assert.equal(isPinnedCertificate(origin, pin, hostname, pem), false);
});
