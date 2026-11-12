import assert from "node:assert/strict";
import test from "node:test";
import { basicAuth, decodeConnection, encodeConnection, type CredentialStorage } from "../dist/connection-config.js";
import { validateWebUrl } from "../dist/policy.js";

const storage: CredentialStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value.split("").reverse().join("")),
  decryptString: value => value.toString().split("").reverse().join(""),
};

test("connection URLs only accept secure remote or exact loopback roots", () => {
  assert.equal(validateWebUrl("https://assistant.example/"), "https://assistant.example");
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) assert.equal(validateWebUrl(`http://${host}:8080`), `http://${host}:8080`);
  for (const value of ["http://example.com", "http://127.0.0.1.evil.test", "https://u:p@example.com", "https://:p@example.com", "https://@example.com", "https://exam\nple.com", "https://example.com/#x", "https://example.com/?x", "https://example.com/path", "https://example.com/foo/..", "https://example.com/%2e", "https://example.com\\path", "file:///tmp/index.html"]) assert.throws(() => validateWebUrl(value), value);
});

test("stored connection excludes plaintext credentials and decrypts only encrypted fields", () => {
  const secret = "a unique desktop password";
  const encoded = encodeConnection({ url: "https://assistant.example", username: "demo" }, secret, storage);
  assert.equal(encoded.persistedPassword, true);
  assert.equal(encoded.text.includes(secret), false);
  assert.deepEqual(decodeConnection(encoded.text, storage), { config: { url: "https://assistant.example", username: "demo" }, password: secret });
  assert.equal(decodeConnection('{"url":"https://assistant.example","password":"plaintext"}', storage).password, undefined);
});

test("unavailable and basic_text storage never persist a password", () => {
  for (const unavailable of [{ ...storage, isEncryptionAvailable: () => false }, { ...storage, getSelectedStorageBackend: () => "basic_text" }]) {
    const encoded = encodeConnection({ url: "http://127.0.0.1:8080", username: "demo" }, "secret", unavailable);
    assert.equal(encoded.persistedPassword, false);
    assert.equal(JSON.parse(encoded.text).encryptedPassword, undefined);
    assert.equal(encoded.text.includes("secret"), false);
  }
});

test("session-only connection never calls secure storage without a password to persist", () => {
  const unavailable: CredentialStorage = {
    isEncryptionAvailable: () => { throw new Error("keychain must not be called"); },
    encryptString: () => { throw new Error("keychain must not be called"); },
    decryptString: () => { throw new Error("keychain must not be called"); },
  };
  const encoded = encodeConnection({ url: "http://127.0.0.1:3000" }, undefined, unavailable);
  assert.equal(encoded.persistedPassword, false);
  assert.equal(JSON.parse(encoded.text).encryptedPassword, undefined);
});

test("LAN aliases round-trip without changing the configured server or encrypted credential", () => {
  const config = { url: "https://assistant.example", username: "demo", lanUrl: "https://192.168.31.5:3443" };
  const encoded = encodeConnection(config, "fixture secret", storage);
  assert.equal(encoded.text.includes("fixture secret"), false);
  assert.deepEqual(decodeConnection(encoded.text, storage), { config, password: "fixture secret" });
  for (const lanUrl of ["http://192.168.31.5", "https://other.example", "https://8.8.8.8"]) {
    assert.throws(() => encodeConnection({ ...config, lanUrl }, undefined, storage));
    assert.throws(() => decodeConnection(JSON.stringify({ ...config, lanUrl }), storage));
  }
});

test("BasicAuth remains a request header, including Unicode and empty passwords", () => {
  assert.equal(basicAuth("demo", undefined), undefined);
  assert.equal(basicAuth(undefined, "secret"), `Basic ${Buffer.from("demo:secret").toString("base64")}`);
  assert.equal(basicAuth("demo", ""), `Basic ${Buffer.from("demo:").toString("base64")}`);
  assert.equal(basicAuth("demo", "口令"), `Basic ${Buffer.from("demo:口令").toString("base64")}`);
});

for (const [name, unavailable] of [
  ["decryption failure", { ...storage, decryptString: () => { throw new Error("private keychain detail"); } }],
  ["unavailable storage", { ...storage, isEncryptionAvailable: () => false }],
  ["plaintext backend", { ...storage, getSelectedStorageBackend: () => "basic_text" }],
] as const) {
  test(`${name} preserves the server and reports a recoverable credential error`, () => {
    const encoded = encodeConnection({ url: "https://assistant.example", username: "demo" }, "fixture password", storage);
    const result = decodeConnection(encoded.text, unavailable);
    assert.deepEqual(result.config, { url: "https://assistant.example", username: "demo" });
    assert.equal(result.password, undefined);
    assert.match(result.error!, /连接设置/);
    assert.equal(result.error!.includes("private keychain detail"), false);
    assert.equal(result.error!.includes("fixture password"), false);
  });
}
