import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { HttpError } from "./errors.js";

export type MailAccount = { tenantId: string; clientId: string; username: string; password: string };
export function mailAccountSource(file: string) {
  return {
    available: () => !!file && existsSync(file),
    async read(): Promise<{ account: MailAccount; key: string }> {
      if (!file) throw new HttpError(409, "未指定已有账号配置，请使用微软交互登录");
      let value: unknown;
      try { value = JSON.parse(await readFile(file, "utf8")); }
      catch { throw new HttpError(409, "无法读取已有账号配置，请检查本地文件或使用微软交互登录"); }
      const raw = value && typeof value === "object" && "account" in value ? value.account : null;
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!raw || typeof raw !== "object" || !["tenantId", "clientId", "username", "password"].every(k => k in raw && typeof raw[k as keyof typeof raw] === "string")) throw new HttpError(409, "已有配置缺少完整 account，请使用微软交互登录");
      const account = raw as MailAccount;
      if (!uuid.test(account.tenantId) || !uuid.test(account.clientId) || !account.username.trim() || !account.password) throw new HttpError(409, "已有账号配置格式无效，请检查配置或使用微软交互登录");
      // 仅保存身份指纹用于重启时隔离缓存，密码不参与持久化，也不经 API 返回。
      const key = createHash("sha256").update(JSON.stringify([account.tenantId.toLowerCase(), account.clientId.toLowerCase(), account.username.trim().toLowerCase()])).digest("hex");
      return { account, key };
    },
  };
}
