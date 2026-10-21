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
  for (const value of ["http://example.com", "http://127.0.0.1.evil.test", "https://u:p@example.com", "https://example.com/#x", "https://example.com/?x", "https://example.com/path", "https://example.com/foo/..", "https://example.com/%2e", "https://example.com\\path", "file:///tmp/index.html"]) assert.throws(() => validateWebUrl(value), value);
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

test("BasicAuth remains a request header, including Unicode and empty passwords", () => {
  assert.equal(basicAuth("demo", undefined), undefined);
  assert.equal(basicAuth(undefined, "secret"), `Basic ${Buffer.from("demo:secret").toString("base64")}`);
  assert.equal(basicAuth("demo", ""), `Basic ${Buffer.from("demo:").toString("base64")}`);
  assert.equal(basicAuth("demo", "口令"), `Basic ${Buffer.from("demo:口令").toString("base64")}`);
});
