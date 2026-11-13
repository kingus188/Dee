import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStorage } from "./connection-config.js";

const header = Buffer.from("DEE-CREDENTIALS-V1\0");
const nonceBytes = 12, tagBytes = 16;

export function isLocalCredential(value: Buffer): boolean {
  return value.subarray(0, header.length).equals(header);
}

export function openCredentialStorage(directory: string): CredentialStorage {
  const vault = join(directory, "credentials"), file = join(vault, "key");
  function key(create: boolean): Buffer {
    if (create && !existsSync(vault)) {
      for (const name of ["desktop-connection.json", "desktop-peers.json"]) {
        const saved = join(directory, name);
        if (!existsSync(saved)) continue;
        const data = JSON.parse(readFileSync(saved, "utf8"));
        const values = name === "desktop-connection.json" ? [data.encryptedPassword] : Object.values(data);
        if (values.some(value => typeof value === "string" && isLocalCredential(Buffer.from(value, "base64")))) {
          throw new Error("已有凭据的密钥目录丢失，请恢复原目录");
        }
      }
      mkdirSync(directory, { recursive: true });
      mkdirSync(vault, { mode: 0o700 });
      writeFileSync(file, randomBytes(32), { flag: "wx", mode: 0o600 });
    }
    const folder = lstatSync(vault), info = lstatSync(file);
    if (folder.isSymbolicLink() || !folder.isDirectory() || info.isSymbolicLink() || !info.isFile()
      || (process.platform !== "win32" && ((folder.mode & 0o077) !== 0 || (info.mode & 0o077) !== 0))) {
      throw new Error("Dee 凭据目录或密钥文件的访问权限无效");
    }
    const bytes = readFileSync(file);
    if (bytes.length !== 32) throw new Error("Dee 凭据密钥损坏，请恢复原密钥");
    return bytes;
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string): Buffer {
      try {
        const nonce = randomBytes(nonceBytes), cipher = createCipheriv("aes-256-gcm", key(true), nonce);
        cipher.setAAD(header);
        const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return Buffer.concat([header, nonce, cipher.getAuthTag(), encrypted]);
      } catch { throw new Error("Dee 无法保存凭据，请检查凭据目录和原密钥；已有凭据未更改。"); }
    },
    decryptString(value: Buffer): string {
      if (!isLocalCredential(value)) throw new Error("旧版钥匙串凭据尚未迁移，请迁移或重新输入凭据。");
      if (value.length < header.length + nonceBytes + tagBytes) throw new Error("Dee 凭据格式无效");
      try {
        const offset = header.length, nonce = value.subarray(offset, offset + nonceBytes);
        const decipher = createDecipheriv("aes-256-gcm", key(false), nonce);
        decipher.setAAD(header);
        decipher.setAuthTag(value.subarray(offset + nonceBytes, offset + nonceBytes + tagBytes));
        return Buffer.concat([decipher.update(value.subarray(offset + nonceBytes + tagBytes)), decipher.final()]).toString("utf8");
      } catch { throw new Error("Dee 无法读取凭据，请恢复原密钥或重新输入凭据；原文件已保留。"); }
    },
  };
}
