export type NotificationConfig = { url: string; mode: string; kind: string };
export type NotifyEvent = (event: { id: string; type: string; text: string; failed?: boolean }) => Promise<void>;
export function createNotifier(config: NotificationConfig): NotifyEvent {
async function notifyEvent({ id, type, text, failed = false }: { id: string; type: string; text: string; failed?: boolean }) {
  const url = config.url;
  const mode = config.mode || "errors";
  if (!url || mode === "off" || (mode === "errors" && !failed)) return;
  const kind = config.kind || "generic";
  const body = kind === "feishu"
    ? { msg_type: "text", content: { text: text } }
    : { id, type, text, failed, at: new Date().toISOString() };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pi-event-id": String(id) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
  } catch (error) {
    console.error("Webhook 推送失败；请检查接收方与去重设置（细节已隐藏，避免泄露 URL 中的密钥）。");
  }
}


return notifyEvent;
}
