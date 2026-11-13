import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStorage } from "./connection-config.js";
import { isLocalCredential, openCredentialStorage } from "./credential-storage.js";
import { validateWebUrl } from "./policy.js";

// Invoked only by the one-time migration tool, never during normal startup.
export function migrateCredentialFiles(directory: string, legacy: CredentialStorage): { files: number; credentials: number } {
  const storage = openCredentialStorage(directory);
  const changes: Array<{ file: string; original: string; updated: string }> = [];
  let credentials = 0;
  function convert(value: unknown, peer: boolean): string {
    if (typeof value !== "string" || !value) throw new Error("旧凭据格式无效，原文件已保留");
    const bytes = Buffer.from(value, "base64");
    if (isLocalCredential(bytes)) { storage.decryptString(bytes); return value; }
    if (!legacy.isEncryptionAvailable() || legacy.getSelectedStorageBackend?.() === "basic_text") throw new Error("旧凭据暂时无法解密，原文件已保留");
    let plaintext: string;
    try { plaintext = legacy.decryptString(bytes); }
    catch { throw new Error("旧凭据迁移未完成，请完成最后一次系统授权；原文件已保留。"); }
    if (peer && !/^[A-Za-z0-9_-]{43}$/.test(plaintext)) throw new Error("旧设备令牌无效，原文件已保留");
    const encrypted = storage.encryptString(plaintext);
    if (storage.decryptString(encrypted) !== plaintext) throw new Error("Dee 凭据迁移验证失败，原文件已保留");
    credentials++;
    return encrypted.toString("base64");
  }
  for (const name of ["desktop-connection.json", "desktop-peers.json"]) {
    const file = join(directory, name);
    if (!existsSync(file)) continue;
    const original = readFileSync(file, "utf8"), stored: unknown = JSON.parse(original);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("旧凭据文件格式无效");
    const data = stored as Record<string, unknown>;
    const before = credentials;
    if (name === "desktop-connection.json") {
      validateWebUrl(String(data.url));
      if (data.encryptedPassword !== undefined) data.encryptedPassword = convert(data.encryptedPassword, false);
    } else {
      for (const origin of Object.keys(data)) { validateWebUrl(origin); data[origin] = convert(data[origin], true); }
    }
    if (credentials !== before) changes.push({ file, original, updated: JSON.stringify(data) });
  }
  // Decrypt and verify every value before replacing any credential file.
  const committed: typeof changes = [];
  const staged = new Set<string>();
  try {
    for (const change of changes) {
      if (readFileSync(change.file, "utf8") !== change.original) throw new Error("凭据文件已变化，请关闭 Dee 后重试迁移");
      const backup = change.file + ".keychain-backup";
      if (!existsSync(backup)) writeFileSync(backup, change.original, { flag: "wx", mode: 0o600 });
      else if (readFileSync(backup, "utf8") !== change.original) throw new Error("已有迁移备份与当前凭据不一致，原文件已保留");
      writeFileSync(change.file + ".migration-tmp", change.updated, { flag: "wx", mode: 0o600 });
      staged.add(change.file + ".migration-tmp");
    }
    for (const change of changes) { renameSync(change.file + ".migration-tmp", change.file); staged.delete(change.file + ".migration-tmp"); committed.push(change); }
  } catch (error) {
    for (const change of committed) {
      writeFileSync(change.file + ".migration-rollback", change.original, { flag: "wx", mode: 0o600 });
      renameSync(change.file + ".migration-rollback", change.file);
    }
    throw error;
  } finally {
    for (const file of staged) rmSync(file, { force: true });
  }
  return { files: changes.length, credentials };
}
