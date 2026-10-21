import { validateWebUrl } from "./policy.js";
export type ConnectionConfig = { url: string; username?: string };
export type CredentialStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
};
type StoredConfig = { url: string; username?: string; encryptedPassword?: string };

export function encodeConnection(config: ConnectionConfig, password: string | undefined, storage: CredentialStorage) {
  const stored: StoredConfig = { url: validateWebUrl(config.url), username: config.username };
  // Electron's Linux basic_text backend is not encryption, despite reporting available.
  const persistedPassword = password !== undefined && storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text";
  if (persistedPassword) stored.encryptedPassword = storage.encryptString(password!).toString("base64");
  return { text: JSON.stringify(stored), persistedPassword };
}

export function decodeConnection(text: string, storage: CredentialStorage): { config: ConnectionConfig; password?: string } {
  const stored = JSON.parse(text) as StoredConfig;
  const config = { url: validateWebUrl(stored.url), username: stored.username };
  if (config.username !== undefined && (typeof config.username !== "string" || /[:\r\n]/.test(config.username))) throw new Error("Invalid BasicAuth username");
  const password = stored.encryptedPassword && storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text"
    ? storage.decryptString(Buffer.from(stored.encryptedPassword, "base64")) : undefined;
  return { config, password };
}

export function basicAuth(username: string | undefined, password: string | undefined): string | undefined {
  return password !== undefined ? `Basic ${Buffer.from(`${username || "demo"}:${password}`).toString("base64")}` : undefined;
}
