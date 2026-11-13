import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalCredential, openCredentialStorage } from "../dist/credential-storage.js";
import { encodeConnection, decodeConnection } from "../dist/connection-config.js";
import { openPeerCredentials } from "../dist/peer-connection.js";

function temporary(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "dee-credentials-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Dee-owned storage persists empty and Unicode credentials across reopen with unique nonces", t => {
  const dir = temporary(t), store = openCredentialStorage(dir);
  assert.equal(existsSync(join(dir, "credentials")), false, "opening storage must not create or request a key");
  for (const secret of ["", "private fixture password", "口令 🔐"]) {
    const cipher = store.encryptString(secret);
    assert.equal(isLocalCredential(cipher), true);
    assert.equal(openCredentialStorage(dir).decryptString(cipher), secret);
    assert.notDeepEqual(store.encryptString(secret), cipher);
    if (secret) assert.equal(cipher.includes(Buffer.from(secret)), false);
  }
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dir, "credentials")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "credentials/key")).mode & 0o777, 0o600);
  }
});

test("tampering and truncated ciphertext fail closed without exposing the secret", t => {
  const store = openCredentialStorage(temporary(t)), secret = "private fixture password", cipher = store.encryptString(secret);
  for (const index of [20, cipher.length - 1]) {
    const corrupted = Buffer.from(cipher); corrupted[index] ^= 1;
    assert.throws(() => store.decryptString(corrupted), error => error instanceof Error && !error.message.includes(secret));
  }
  assert.throws(() => store.decryptString(cipher.subarray(0, 20)));
});

test("a missing or corrupted key is never silently replaced", t => {
  const dir = temporary(t), store = openCredentialStorage(dir), cipher = store.encryptString("fixture");
  const path = join(dir, "credentials/key"), key = readFileSync(path); unlinkSync(path);
  assert.throws(() => store.decryptString(cipher));
  assert.throws(() => store.encryptString("replacement"));
  assert.equal(existsSync(path), false);
  writeFileSync(path, Buffer.alloc(32), { mode: 0o600 }); assert.throws(() => store.decryptString(cipher));
  writeFileSync(path, key); assert.equal(store.decryptString(cipher), "fixture");
});

test("legacy OS ciphertext is rejected without creating a local key", t => {
  const dir = temporary(t);
  assert.throws(() => openCredentialStorage(dir).decryptString(Buffer.from("v10 legacy fixture")), /尚未迁移/);
  assert.equal(existsSync(join(dir, "credentials")), false);
});

test("losing the entire vault cannot silently replace a key used by saved credentials", t => {
  for (const name of ["desktop-connection.json", "desktop-peers.json"]) {
    const dir = temporary(t), store = openCredentialStorage(dir);
    const cipher = store.encryptString("fixture").toString("base64");
    const original = JSON.stringify(name === "desktop-connection.json" ? { url: "https://assistant.example", encryptedPassword: cipher } : { "https://assistant.example": cipher });
    writeFileSync(join(dir, name), original);
    rmSync(join(dir, "credentials"), { recursive: true });
    assert.throws(() => store.encryptString("replacement"));
    assert.equal(existsSync(join(dir, "credentials")), false);
    assert.equal(readFileSync(join(dir, name), "utf8"), original);
  }
});

test("credentials remain readable after copying the Dee credential directory to another profile", t => {
  const first = temporary(t), second = temporary(t), cipher = openCredentialStorage(first).encryptString("portable fixture");
  cpSync(join(first, "credentials"), join(second, "credentials"), { recursive: true });
  chmodSync(join(second, "credentials"), 0o700); chmodSync(join(second, "credentials/key"), 0o600);
  assert.equal(openCredentialStorage(second).decryptString(cipher), "portable fixture");
});

test("key symlinks and permissive key modes are rejected", { skip: process.platform === "win32" }, t => {
  const dir = temporary(t), store = openCredentialStorage(dir), cipher = store.encryptString("fixture"), path = join(dir, "credentials/key");
  chmodSync(path, 0o644); assert.throws(() => store.decryptString(cipher)); chmodSync(path, 0o600);
  const target = join(dir, "elsewhere"); writeFileSync(target, readFileSync(path), { mode: 0o600 }); unlinkSync(path); symlinkSync(target, path);
  assert.throws(() => store.encryptString("fixture")); assert.throws(() => store.decryptString(cipher));
});

test("connection passwords and device tokens share Dee storage and remain compatible with their callers", t => {
  const dir = temporary(t), secret = "fixture password", storage = openCredentialStorage(dir);
  const encoded = encodeConnection({ url: "https://assistant.example" }, secret, storage);
  assert.equal(encoded.persistedPassword, true); assert.equal(decodeConnection(encoded.text, openCredentialStorage(dir)).password, secret);
  const peers = openPeerCredentials(dir), token = "a".repeat(43); peers.save("https://assistant.example", token);
  assert.equal(readFileSync(join(dir, "desktop-peers.json"), "utf8").includes(token), false);
  assert.equal(openPeerCredentials(dir).get("https://assistant.example"), token);
});
