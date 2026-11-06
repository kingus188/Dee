export function messageText(message: { body?: { content?: string; contentType?: string }; attachments?: { name?: string }[] }) {
  const body = message.body?.content ?? "";
  const text = (message.body?.contentType === "html" ? body.replace(/<[^>]*>/g, " ") : body)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim().slice(0, 2000);
  return [text, /<img\b/i.test(body) ? "[截图]" : "", ...(message.attachments ?? []).map(file => `[附件：${file.name || "未命名附件"}]`)].filter(Boolean).join(" ");
}
