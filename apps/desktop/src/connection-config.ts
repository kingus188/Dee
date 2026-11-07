import { validateLanUrl, validateWebUrl } from "./policy.js";
export type ConnectionConfig = { url: string; username?: string; lanUrl?: string };
export type CredentialStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
};
type StoredConfig = ConnectionConfig & { encryptedPassword?: string };

export function encodeConnection(config: ConnectionConfig, password: string | undefined, storage: CredentialStorage) {
  const stored: StoredConfig = { url: validateWebUrl(config.url), username: config.username };
  if (config.lanUrl !== undefined) stored.lanUrl = validateLanUrl(config.lanUrl);
  // Electron's Linux basic_text backend is not encryption, despite reporting available.
  const persistedPassword = password !== undefined && storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text";
  if (persistedPassword) stored.encryptedPassword = storage.encryptString(password!).toString("base64");
  return { text: JSON.stringify(stored), persistedPassword };
}

export function decodeConnection(text: string, storage: CredentialStorage): { config: ConnectionConfig; password?: string; error?: string } {
  const stored = JSON.parse(text) as StoredConfig;
  const config: ConnectionConfig = { url: validateWebUrl(stored.url), username: stored.username };
  if (stored.lanUrl !== undefined) config.lanUrl = validateLanUrl(stored.lanUrl);
  if (config.username !== undefined && (typeof config.username !== "string" || /[:\r\n]/.test(config.username))) throw new Error("Invalid BasicAuth username");
  let password: string | undefined;
  if (stored.encryptedPassword) {
    try {
      if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === "basic_text") throw new Error("Credential storage unavailable");
      password = storage.decryptString(Buffer.from(stored.encryptedPassword, "base64"));
    } catch {
      return { config, error: "已保存的登录信息读取失败。请从应用菜单打开「连接设置…」重新输入密码；后台地址已保留。" };
    }
  }
  return { config, password };
}

export function basicAuth(username: string | undefined, password: string | undefined): string | undefined {
  return password !== undefined ? `Basic ${Buffer.from(`${username || "demo"}:${password}`).toString("base64")}` : undefined;
}
