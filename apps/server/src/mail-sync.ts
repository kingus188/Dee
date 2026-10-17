import type { MailRecord, MailStore } from "./mail-store.js";
import { HttpError } from "./errors.js";

export class MailRetryError extends HttpError {
  constructor(message: string, readonly retryMs: number) { super(502, message); }
}
const GRAPH = "https://graph.microsoft.com/v1.0";
export function mailPagingUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(502, "邮件分页地址无效"); }
  // Graph 实际 nextLink 使用 OData 括号写法；两种形式均严格限定为当前账号的 inbox delta。
  const inbox = ["/v1.0/me/mailfolders/inbox/messages/delta", "/v1.0/me/mailfolders('inbox')/messages/delta"].includes(url.pathname.toLowerCase());
  if (url.origin !== "https://graph.microsoft.com" || !inbox || url.username || url.password || url.hash) throw new HttpError(502, "邮件分页地址不受信任");
  return url.href;
}
function record(raw: Record<string, unknown>, previous?: { message: Omit<MailRecord, "text">; text: string }): MailRecord {
  const old = previous && { ...previous.message, text: previous.text };
  const from = raw.from as { emailAddress?: { name?: string; address?: string } } | undefined;
  const body = raw.body as { contentType?: string; content?: string } | undefined;
  const time = raw.receivedDateTime ?? old?.receivedAt;
  if (typeof raw.id !== "string" || !raw.id || typeof time !== "string" || !Number.isFinite(Date.parse(time))) throw new HttpError(502, "邮件记录格式无效，未推进同步游标");
  const preview = typeof raw.bodyPreview === "string" ? raw.bodyPreview.slice(0, 1000) : old?.preview ?? "";
  // Graph 的 Prefer 应返回 text。若服务忽略它，宁可只缓存纯文本预览，不将 HTML/外部图片交给界面。
  const text = body?.contentType?.toLowerCase() === "text" && typeof body.content === "string" ? body.content.slice(0, 20000) : body ? preview : old?.text ?? preview;
  return { id: raw.id, subject: typeof raw.subject === "string" ? raw.subject.slice(0, 1000) : old?.subject ?? "（无主题）",
    sender: from?.emailAddress?.name?.slice(0, 300) ?? old?.sender ?? "", address: from?.emailAddress?.address?.slice(0, 320) ?? old?.address ?? "",
    receivedAt: new Date(time).toISOString(), preview, text, isRead: typeof raw.isRead === "boolean" ? raw.isRead : old?.isRead ?? false,
    hasAttachments: typeof raw.hasAttachments === "boolean" ? raw.hasAttachments : old?.hasAttachments ?? false };
}
export async function syncMail(store: MailStore, token: (signal: AbortSignal) => Promise<string>, signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const initial = `${GRAPH}/me/mailFolders/inbox/messages/delta?` + new URLSearchParams({
    "$select": "id,subject,from,receivedDateTime,bodyPreview,body,isRead,hasAttachments", "$top": "50", "$filter": `receivedDateTime ge ${store.state().initialSince}`,
  });
  let cursor = store.state().cursor ?? initial;
  for (let page = 0; page < 20; page++) {
    const access = await token(signal);
    let response: Response;
    try { response = await fetchImpl(mailPagingUrl(cursor), { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: "error",
      headers: { Authorization: `Bearer ${access}`, Prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' } }); }
    catch { throw new HttpError(502, "Outlook 网络连接失败，稍后自动重试"); }
    if (signal.aborted) throw new HttpError(409, "邮件同步已停止");
    if (!response.ok) {
      if (response.status === 410) {
        // 全量重建时移除旧缓存，避免已删除或移出收件箱的邮件长期残留；不提醒重建的历史邮件。
        store.reset(store.state().settings, store.state().tokens);
        throw new HttpError(409, "邮件增量游标已过期，将重新同步近 30 天邮件");
      }
      if (response.status === 429 || response.status === 503) {
        const header = response.headers.get("retry-after"), seconds = Number(header);
        const delay = header ? Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now() : 60000;
        throw new MailRetryError("Outlook 请求繁忙，正在按服务要求等待重试", Number.isFinite(delay) ? Math.max(60000, delay) : 60000);
      }
      if (response.status === 401) { const tokens = store.state().tokens; if (tokens) store.update({ tokens: { ...tokens, expiresAt: 0 } }); }
      throw new HttpError(502, response.status === 403 ? "Outlook 读取被拒绝，请检查 Mail.Read 委托权限和管理员授权" : response.status === 429 ? "Outlook 请求限流，稍后自动重试" : `Outlook 同步失败（HTTP ${response.status}），稍后自动重试`);
    }
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; } catch { throw new HttpError(502, "Outlook 返回格式无效"); }
    if (!Array.isArray(data.value)) throw new HttpError(502, "Outlook 邮件列表格式无效");
    const next = data["@odata.nextLink"], delta = data["@odata.deltaLink"];
    if (typeof next !== "string" && typeof delta !== "string") throw new HttpError(502, "Outlook 未返回同步游标");
    const target = mailPagingUrl(typeof next === "string" ? next : String(delta));
    const messages: MailRecord[] = [], removed: string[] = [];
    for (const item of data.value) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") throw new HttpError(502, "Outlook 邮件记录格式无效");
      if (item["@removed"]) removed.push(item.id);
      else messages.push(record(item, store.read(item.id)));
    }
    if (signal.aborted) throw new HttpError(409, "邮件同步已停止");
    store.page(messages, removed, target, typeof next !== "string");
    if (typeof next !== "string") return;
    cursor = target;
  }
  throw new HttpError(503, "邮件较多，本轮已保存部分结果，将在下一轮继续同步");
}
