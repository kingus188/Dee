import { HttpError } from "./errors.js";
import type { MailService } from "./mail-service.js";

export function mailApi(mail: MailService, method: string, url: URL, body: Record<string, unknown>) {
  const path = url.pathname;
  if (method === "POST" && (path === "/api/mail/delivery" || path === "/api/mail/delivery/ack")) {
    const valid = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
    if (!valid(body.clientId)) throw new HttpError(400, "邮件通知客户端标识无效");
    if (path.endsWith("/ack")) {
      if (!valid(body.id) || !valid(body.token)) throw new HttpError(400, "邮件通知确认无效");
      return { status: 200, data: mail.acknowledgeDelivery(body.clientId, body.id, body.token) };
    }
    return { status: 200, data: mail.claimDelivery(body.clientId) };
  }
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
    const batch = raw === null ? mail.notices(after) : mail.deliveryNotices(after);
    return { status: 200, data: raw === null ? { latest: batch.latest, items: [] } : batch };
  }
  return undefined;
}
