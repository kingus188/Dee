import { validateWebUrl } from "./policy.js";

/** A local, non-privileged main-window state that remains available offline. */
export function connectionStatusPage(origin: string, error?: string): string {
  const page = new URL("../connection-status.html", import.meta.url);
  page.searchParams.set("origin", validateWebUrl(origin));
  page.searchParams.set("title", error ? "暂时未连接" : "正在连接 Dee");
  page.searchParams.set("message", error ?? "正在使用已保存的连接，稍后进入你的工作空间。");
  return page.href;
}
