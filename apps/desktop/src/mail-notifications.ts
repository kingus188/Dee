import type { startServer } from "@assistant/server";
type ReadNotices = Awaited<ReturnType<typeof startServer>>["mail"]["notices"];

export function startMailNotifications(read: ReadNotices, notify: (title: string, body: string) => void) {
  let cursor = read(0).latest;
  const timer = setInterval(() => {
    const batch = read(cursor);
    if (!batch.items.length) return;
    const latest = batch.items[batch.items.length - 1];
    notify(batch.items.length > 1 ? `Outlook · ${batch.items.length} 封新邮件` : "Outlook 新邮件",
      `${latest.message.sender || latest.message.address}：${latest.message.subject || "（无主题）"}`);
    cursor = latest.sequence;
  }, 15000);
  timer.unref();
  return () => clearInterval(timer);
}
