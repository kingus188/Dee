import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCredentialFiles } from "../dist/credential-migration.js";
import { openCredentialStorage } from "../dist/credential-storage.js";
import { decodeConnection } from "../dist/connection-config.js";
import { openPeerCredentials } from "../dist/peer-connection.js";

const legacy = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from("legacy:" + value), decryptString: (value: Buffer) => { assert.match(value.toString(), /^legacy:/); return value.toString().slice(7); } };
const cipher = (value: string) => legacy.encryptString(value).toString("base64");
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "dee-migrate-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const connection = JSON.stringify({ url: "https://assistant.example", username: "demo", encryptedPassword: cipher("fixture password") });
  const peers = JSON.stringify({ "https://assistant.example": cipher("a".repeat(43)) });
  writeFileSync(join(dir, "desktop-connection.json"), connection); writeFileSync(join(dir, "desktop-peers.json"), peers);
  return { dir, connection, peers };
}

test("migration preserves passwords and tokens, saves encrypted backups and never needs legacy storage again", t => {
  const { dir, connection, peers } = fixture(t);
  assert.deepEqual(migrateCredentialFiles(dir, legacy), { files: 2, credentials: 2 });
  assert.equal(readFileSync(join(dir, "desktop-connection.json.keychain-backup"), "utf8"), connection);
  assert.equal(readFileSync(join(dir, "desktop-peers.json.keychain-backup"), "utf8"), peers);
  const store = openCredentialStorage(dir);
  assert.equal(decodeConnection(readFileSync(join(dir, "desktop-connection.json"), "utf8"), store).password, "fixture password");
  assert.equal(openPeerCredentials(dir).get("https://assistant.example"), "a".repeat(43));
  assert.deepEqual(migrateCredentialFiles(dir, { ...legacy, isEncryptionAvailable() { throw new Error("must never access keychain"); } }), { files: 0, credentials: 0 });
});

test("a later decryption failure leaves every original credential file unchanged", t => {
  const { dir, connection, peers } = fixture(t);
  assert.throws(() => migrateCredentialFiles(dir, { ...legacy, decryptString(value) { if (value.toString().includes("aaa")) throw new Error("private fixture detail"); return legacy.decryptString(value); } }), error => error instanceof Error && !error.message.includes("private fixture detail"));
  assert.equal(readFileSync(join(dir, "desktop-connection.json"), "utf8"), connection);
  assert.equal(readFileSync(join(dir, "desktop-peers.json"), "utf8"), peers);
});

test("unavailable legacy storage and conflicting backups cannot overwrite saved credentials", t => {
  const { dir, connection, peers } = fixture(t);
  assert.throws(() => migrateCredentialFiles(dir, { ...legacy, isEncryptionAvailable: () => false }));
  assert.equal(existsSync(join(dir, "credentials")), false);
  writeFileSync(join(dir, "desktop-peers.json.keychain-backup"), "existing unrelated backup");
  assert.throws(() => migrateCredentialFiles(dir, legacy), /备份/);
  assert.equal(readFileSync(join(dir, "desktop-connection.json"), "utf8"), connection);
  assert.equal(readFileSync(join(dir, "desktop-peers.json"), "utf8"), peers);
  assert.equal(existsSync(join(dir, "desktop-connection.json.migration-tmp")), false);
});

test("a previous migration staging file is preserved instead of being overwritten or cleaned up", t => {
  const { dir, connection } = fixture(t), staged = join(dir, "desktop-connection.json.migration-tmp");
  writeFileSync(staged, "previous migration staging");
  assert.throws(() => migrateCredentialFiles(dir, legacy));
  assert.equal(readFileSync(staged, "utf8"), "previous migration staging");
  assert.equal(readFileSync(join(dir, "desktop-connection.json"), "utf8"), connection);
});
