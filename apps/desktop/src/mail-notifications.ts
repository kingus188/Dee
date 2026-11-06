import { randomUUID } from "node:crypto";
type Notice = { sequence: number; message: { sender?: string; address?: string; subject?: string; importance?: "low" | "normal" | "high" } };
type Delivery = { id: string; token: string; leaseUntil: number };
type NoticeBatch = { latest: number; items: Notice[]; cursor?: number; total?: number; urgent?: boolean; delivery?: Delivery };
export type MailNotificationStatus =
  | { state: "retrying"; reason: "timeout" | "authorization" | "unavailable" }
  | { state: "connected" };

const pollIntervalMs = 15000;
const requestTimeoutMs = 10000;

export function showMailNotification(notification: {
  show(): void; close(): void;
  once(event: "show" | "failed" | "close", listener: () => void): unknown;
  removeListener(event: "show" | "failed" | "close", listener: () => void): unknown;
}): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(showTimer); if (closeTimer) clearTimeout(closeTimer);
      notification.removeListener("show", shown);
      notification.removeListener("failed", failed);
      notification.removeListener("close", closed);
    };
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(showTimer); resolve(success);
    };
    const closed = () => { finish(false); cleanup(); };
    const failed = () => { finish(false); cleanup(); try { notification.close(); } catch {} };
    const shown = () => {
      if (settled) return;
      finish(true);
      notification.removeListener("failed", failed);
      closeTimer = setTimeout(() => { cleanup(); try { notification.close(); } catch {} }, 5000);
      closeTimer.unref();
    };
    // Native show() returning is not proof that the OS accepted the notification.
    const showTimer = setTimeout(failed, 4000);
    showTimer.unref();
    notification.once("show", shown); notification.once("failed", failed); notification.once("close", closed);
    try { notification.show(); } catch { failed(); }
  });
}

export function startMailNotifications(
  baseUrl: string,
  authorization: string | undefined,
  notify: (title: string, body: string) => boolean | void | Promise<boolean | void>,
  fetcher: typeof fetch = fetch,
  onStatus?: (status: MailNotificationStatus) => void,
) {
  const clientId = randomUUID();
  const displayed = new Set<string>();
  let pendingAck: Pick<Delivery, "id" | "token"> | undefined;
  let stopped = false;
  let active: AbortController | undefined;
  let lastStatus: MailNotificationStatus | undefined;
  const reportStatus = (status: MailNotificationStatus) => {
    // Surface state changes without repeating the same failure on every poll.
    if (lastStatus?.state === status.state && (status.state === "connected" ||
      (lastStatus.state === "retrying" && lastStatus.reason === status.reason))) return;
    lastStatus = status;
    try { onStatus?.(status); } catch { /* status presentation must not interrupt polling */ }
  };
  const poll = async () => {
    if (stopped || active) return;
    const controller = new AbortController();
    active = controller;
    let reason: Extract<MailNotificationStatus, { state: "retrying" }>["reason"] = "unavailable";
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const timeout = setTimeout(() => {
      reason = "timeout";
      controller.abort(new Error("Mail notification request timed out"));
    }, requestTimeoutMs);
    timeout.unref();
    try {
      const headers = { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) };
      const post = async (path: string, body: object) => {
        controller.signal.throwIfAborted();
        const response = await fetcher(new URL(path, baseUrl), {
          method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) reason = "authorization";
          throw new Error("Mail notification request failed");
        }
        const data: unknown = await response.json();
        controller.signal.throwIfAborted();
        return data;
      };
      const acknowledge = async () => {
        if (!pendingAck) return;
        const result = await post("/api/mail/delivery/ack", { clientId, ...pendingAck }) as { acknowledged?: boolean };
        if (typeof result?.acknowledged !== "boolean") throw new Error("Invalid mail acknowledgement response");
        // A false response means the old lease was superseded/cancelled. Claim again
        // rather than suppressing the delivery; displayed IDs prevent local repeats.
        pendingAck = undefined;
      };
      // Race the entire claim/show/ack operation, including JSON, so a fetch that
      // ignores cancellation cannot wedge polling or apply any late result.
      const request = (async () => {
        await acknowledge();
        const batch = await post("/api/mail/delivery", { clientId }) as NoticeBatch;
        if (!Number.isSafeInteger(batch?.latest) || batch.latest < 0 || !Array.isArray(batch.items) ||
          batch.items.some(item => !Number.isSafeInteger(item?.sequence) || item.sequence < 0 || !item.message || typeof item.message !== "object") ||
          (batch.cursor !== undefined && (!Number.isSafeInteger(batch.cursor) || batch.cursor < 0)) ||
          (batch.total !== undefined && (!Number.isSafeInteger(batch.total) || batch.total < 0)) ||
          (batch.urgent !== undefined && typeof batch.urgent !== "boolean") ||
          (batch.delivery !== undefined && (typeof batch.delivery.id !== "string" || !batch.delivery.id ||
            typeof batch.delivery.token !== "string" || !batch.delivery.token || !Number.isFinite(batch.delivery.leaseUntil))) ||
          (batch.items.length > 0 && !batch.delivery)) {
          throw new Error("Invalid mail notification response");
        }
        if (stopped || controller.signal.aborted || !batch.delivery || batch.delivery.leaseUntil <= Date.now()) return;
        const delivery = batch.delivery;
        if (!displayed.has(delivery.id) && batch.items.length) {
          const latest = batch.items.findLast(item => item.message.importance === "high") ?? batch.items[batch.items.length - 1];
          const count = batch.total ?? batch.items.length;
          const title = count > 1 ? `Outlook · ${count} 封新邮件${batch.urgent ? "（含重要邮件）" : ""}` :
            batch.urgent ? "Outlook 重要邮件" : "Outlook 新邮件";
          const shown = await notify(title, `${latest.message.sender || latest.message.address || "未知发件人"}：${latest.message.subject || "（无主题）"}`);
          if (stopped || controller.signal.aborted || delivery.leaseUntil <= Date.now()) return;
          if (shown === false) throw new Error("Mail notification was not displayed");
          displayed.add(delivery.id);
        }
        pendingAck = { id: delivery.id, token: delivery.token };
        await acknowledge();
      })();
      await Promise.race([request, aborted]);
      if (stopped || controller.signal.aborted) return;
      reportStatus({ state: "connected" });
    } catch {
      if (!stopped) reportStatus({ state: "retrying", reason });
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", rejectAbort);
      if (active === controller) active = undefined;
    }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, pollIntervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    active?.abort(new Error("Mail notification polling stopped"));
  };
}
