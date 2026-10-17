import { useEffect, useState } from "react";
import type { MailNotice, MailNotices } from "@assistant/contracts";
import { request } from "../api/request.js";

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
  if (!notice) return null;
  return <aside className="mail-notice" role="status" aria-label="新邮件提醒">
    <span>Outlook 新邮件 · {notice.message.sender || notice.message.address}：{notice.message.subject || "（无主题）"}。可在对话中问「查看最新邮件」。</span>
    <button type="button" className="text-button" onClick={() => setNotice(null)} aria-label="关闭新邮件提醒">关闭</button>
  </aside>;
}
