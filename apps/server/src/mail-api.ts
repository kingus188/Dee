import { HttpError } from "./errors.js";
import type { MailService } from "./mail-service.js";

export function mailApi(mail: MailService, method: string, url: URL, body: Record<string, unknown>) {
  const path = url.pathname;
  if (path === "/api/settings/mail") {
    if (method === "GET") return { status: 200, data: mail.status() };
    if (method === "POST") return mail.save(body).then(data => ({ status: 200, data }));
  }
  if (method === "POST" && path === "/api/mail/login") return mail.login().then(data => ({ status: 200, data }));
  if (method === "POST" && path === "/api/mail/login-account") return mail.loginAccount().then(data => ({ status: 200, data }));
  if (method === "POST" && path === "/api/mail/disconnect") return mail.disconnect().then(data => ({ status: 200, data }));
  if (method === "POST" && path === "/api/mail/refresh") return mail.refresh().then(() => ({ status: 200, data: mail.status() }));
  if (method === "GET" && path === "/api/mail/notices") {
    const raw = url.searchParams.get("after");
    const after = raw === null ? 0 : Number(raw);
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "邮件通知游标无效");
    const batch = mail.notices(after);
    return { status: 200, data: raw === null ? { latest: batch.latest, items: [] } : batch };
  }
  return undefined;
}
