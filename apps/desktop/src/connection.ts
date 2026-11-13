import { app } from "electron";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodeConnection, encodeConnection, type ConnectionConfig } from "./connection-config.js";
import { openCredentialStorage } from "./credential-storage.js";

export function loadConnection(): { config?: ConnectionConfig; password?: string; error?: string } {
  const path = join(app.getPath("userData"), "desktop-connection.json");
  if (!existsSync(path)) return {};
  try { return decodeConnection(readFileSync(path, "utf8"), openCredentialStorage(app.getPath("userData"))); }
  catch { return { error: "已保存的连接配置读取失败。请从应用菜单打开「连接设置…」检查后台地址；原配置文件已保留。" }; }
}

export function saveConnection(config: ConnectionConfig, password: string | undefined): { persistedPassword: boolean } {
  const dir = app.getPath("userData"); mkdirSync(dir, { recursive: true });
  const encoded = encodeConnection(config, password, openCredentialStorage(dir));
  const path = join(dir, "desktop-connection.json"); const tmp = `${path}.tmp`;
  writeFileSync(tmp, encoded.text, { mode: 0o600 }); renameSync(tmp, path);
  return { persistedPassword: encoded.persistedPassword };
}
