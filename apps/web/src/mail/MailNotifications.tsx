import { useEffect, useState } from "react";
import type { MailNotice, MailNotices } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";

// 每个页面独立游标，不会由一个页面消费掉其他页面的提醒；刷新只监听之后的新邮件。
export function MailNotifications() {
  const [notice, setNotice] = useState<MailNotice | null>(null);
  useEffect(() => {
    let live = true, busy = false, cursor: number | undefined;
    async function poll() {
      if (busy) return;
      busy = true;
      try {
        const data = await request<MailNotices>(`/api/mail/notices${cursor === undefined ? "" : `?after=${cursor}`}`);
        if (!live) return;
        if (cursor === undefined) cursor = data.latest;
        else if (data.items.length) { cursor = data.items[data.items.length - 1].sequence; setNotice(data.items[data.items.length - 1]); }
      } catch { /* 断线后保留游标，重连继续；不把读取失败当成没有新邮件。 */ }
      finally { busy = false; }
    }
    void poll(); const timer = setInterval(() => void poll(), 15000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (!notice) return null;
  return <aside className="mail-notice mail-notice-toast" role="status" aria-live="polite" aria-atomic="true" aria-label="新邮件提醒">
    <span className="mail-notice-icon"><Icon name="mail" /></span>
    <div className="mail-notice-copy">
      <p className="mail-notice-source">Outlook <span>新邮件</span></p>
      <h2 className="mail-notice-subject">{notice.message.subject || "（无主题）"}</h2>
      <p className="mail-notice-sender">{notice.message.sender || notice.message.address || "未知发件人"}</p>
      <p className="mail-notice-hint">在对话中问「查看最新邮件」</p>
    </div>
    <button type="button" className="mail-notice-close" onClick={() => setNotice(null)} aria-label="关闭新邮件提醒"><Icon name="x" /></button>
  </aside>;
}
