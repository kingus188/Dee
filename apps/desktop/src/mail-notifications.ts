type Notice = { sequence: number; message: { sender?: string; address?: string; subject?: string } };
type NoticeBatch = { latest: number; items: Notice[] };

export function startMailNotifications(
  baseUrl: string,
  authorization: string | undefined,
  notify: (title: string, body: string) => void,
  fetcher: typeof fetch = fetch,
) {
  let cursor = 0;
  let stopped = false;
  let initialized = false;
  let running: Promise<void> | undefined;
  const poll = async () => {
    if (stopped || running) return;
    running = (async () => {
      try {
        const url = new URL("/api/mail/notices", baseUrl);
        if (initialized) url.searchParams.set("after", String(cursor));
        const headers = authorization ? { Authorization: authorization } : undefined;
        const response = await fetcher(url, { headers, redirect: "error" });
        if (!response.ok) return;
        const batch = await response.json() as NoticeBatch;
        if (stopped) return;
        if (!initialized) { cursor = batch.latest; initialized = true; }
        else if (batch.items.length) {
          const latest = batch.items[batch.items.length - 1];
          notify(batch.items.length > 1 ? `Outlook · ${batch.items.length} 封新邮件` : "Outlook 新邮件",
            `${latest.message.sender || latest.message.address}：${latest.message.subject || "（无主题）"}`);
          cursor = latest.sequence;
        }
      } catch { /* offline and rejected redirects are retried on the next interval */ }
      finally { running = undefined; }
    })();
    await running;
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, 15000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
