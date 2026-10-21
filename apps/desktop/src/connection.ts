import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodeConnection, encodeConnection, type ConnectionConfig } from "./connection-config.js";

const credentialStorage = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value: string) => safeStorage.encryptString(value),
  decryptString: (value: Buffer) => safeStorage.decryptString(value),
  ...(process.platform === "linux" ? { getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend() } : {}),
};

export function loadConnection(): { config?: ConnectionConfig; password?: string } {
  const path = join(app.getPath("userData"), "desktop-connection.json");
  if (!existsSync(path)) return {};
  try { return decodeConnection(readFileSync(path, "utf8"), credentialStorage); }
  catch { return {}; }
}

export function saveConnection(config: ConnectionConfig, password: string | undefined): { persistedPassword: boolean } {
  const encoded = encodeConnection(config, password, credentialStorage);
  const dir = app.getPath("userData"); mkdirSync(dir, { recursive: true });
  const path = join(dir, "desktop-connection.json"); const tmp = `${path}.tmp`;
  writeFileSync(tmp, encoded.text, { mode: 0o600 }); renameSync(tmp, path);
  return { persistedPassword: encoded.persistedPassword };
}
