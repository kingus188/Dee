import { useEffect, useLayoutEffect, useState } from "react";
import type { MailNotice, MailNotices } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";

// The shared server lease coordinates Web tabs and desktop. Ack only after React
// commits the toast; a failed/late response never consumes the durable delivery.
export function MailNotifications() {
  const [notice, setNotice] = useState<{ latest: MailNotice; total: number; urgent: boolean; leaseUntil: number; shown: () => boolean } | null>(null);
  useEffect(() => {
    let live = true, busy = false;
    const clientId = crypto.randomUUID(), displayed = new Set<string>();
    let pendingAck: { id: string; token: string } | undefined;
    async function bounded<T>(path: string, body: unknown): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([request<T>(path, body), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Mail delivery timed out")), 10_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    const visible = () => document.visibilityState !== "hidden";
    async function ack() {
      if (!live || !visible() || !pendingAck) return;
      const current = pendingAck;
      await bounded("/api/mail/delivery/ack", { clientId, ...current });
      if (pendingAck === current) pendingAck = undefined;
    }
    async function poll() {
      if (!live || !visible() || busy) return;
      busy = true;
      try {
        await ack();
        if (!live || !visible()) return;
        const data = await bounded<MailNotices>("/api/mail/delivery", { clientId });
        if (!live || !visible() || !data.delivery || data.delivery.leaseUntil <= Date.now() || !data.items.length) return;
        const { id, token, leaseUntil } = data.delivery;
        if (displayed.has(id)) { pendingAck = { id, token }; await ack(); return; }
        setNotice({ latest: data.items.findLast(item => item.message.importance === "high") ?? data.items[data.items.length - 1],
          total: data.total ?? data.items.length, urgent: data.urgent ?? false, leaseUntil,
          shown: () => {
            if (!live || !visible() || leaseUntil <= Date.now()) { setNotice(null); return false; }
            displayed.add(id); pendingAck = { id, token }; void ack().catch(() => {}); return true;
          } });
      } catch { /* Unconfirmed delivery stays durable and may be reclaimed after lease expiry. */ }
      finally { busy = false; }
    }
    const visibilityChanged = () => { if (!visible()) setNotice(null); else void poll(); };
    const focused = () => { if (visible()) void poll(); };
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("focus", focused);
    void poll(); const timer = setInterval(() => void poll(), 15000);
    return () => {
      live = false; clearInterval(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("focus", focused);
    };
  }, []);
  useLayoutEffect(() => {
    // Recheck at commit before paint: React may defer a render beyond the lease.
    if (!notice || !notice.shown()) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice || notice.leaseUntil <= Date.now()) return null;
  return <aside className="mail-notice mail-notice-toast" role="status" aria-live="polite" aria-atomic="true" aria-label="新邮件提醒">
    <span className="mail-notice-icon"><Icon name="mail" /></span>
    <div className="mail-notice-copy">
      <p className="mail-notice-source">Outlook <span>{notice.total > 1 ? `${notice.total} 封新邮件${notice.urgent ? "（含重要邮件）" : "摘要"}` : notice.urgent ? "重要邮件" : "新邮件"}</span></p>
      <h2 className="mail-notice-subject">{notice.latest.message.subject || "（无主题）"}</h2>
      <p className="mail-notice-sender">{notice.latest.message.sender || notice.latest.message.address || "未知发件人"}</p>
      <p className="mail-notice-hint">在对话中问「查看最新邮件」</p>
    </div>
    <button type="button" className="mail-notice-close" onClick={() => setNotice(null)} aria-label="关闭新邮件提醒"><Icon name="x" /></button>
  </aside>;
}
