import type { NotificationOverview } from "@assistant/contracts";
import type { AppContext } from "./application/context.js";
import { HttpError } from "./errors.js";

export function notificationApi(context: Pick<AppContext, "config" | "notifications">, method: string, url: URL, body: Record<string, unknown>) {
  const { config, notifications } = context;
  if (method === "GET" && url.pathname === "/api/notifications") {
    const status = url.searchParams.get("status");
    if (status !== null && status !== "pending" && status !== "sent" && status !== "failed") throw new HttpError(400, "通知状态无效");
    const data: NotificationOverview = {
      enabled: !config.offline && !!config.notifications.url && config.notifications.mode !== "off",
      mode: config.notifications.mode || "errors", kind: config.notifications.kind || "generic",
      items: notifications.list(status ?? undefined),
    };
    return { status: 200, data };
  }
  if (method === "POST" && url.pathname === "/api/notifications/retry") {
    if (typeof body.id !== "string" || !body.id.trim() || body.id.length > 512) throw new HttpError(400, "通知事件 ID 无效");
    if (config.offline) throw new HttpError(409, "离线模式不能重新投递通知");
    const result = notifications.retry(body.id);
    if (result === "disabled") throw new HttpError(409, "通知投递未启用");
    if (result === "missing") throw new HttpError(404, "当前通知目标中不存在此事件");
    if (result === "conflict") throw new HttpError(409, "仅失败的通知可以重新投递，请刷新记录");
    return { status: 202, data: { ok: true } };
  }
  return undefined;
}
