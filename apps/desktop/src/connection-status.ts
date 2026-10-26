import { validateWebUrl } from "./policy.js";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** A non-privileged main-window state, never a credential form. */
export function connectionStatusPage(origin: string, error?: string): string {
  const url = escapeHtml(validateWebUrl(origin));
  const title = error ? "暂时未连接" : "正在连接小 D";
  const message = error ?? "正在使用已保存的连接，稍后进入你的工作空间。";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>小 D · 你的个人智能助手</title><style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; color: #252824; background: #fafbf8; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(520px, calc(100% - 80px)); padding: 40px 0; }
.brand { font-size: 32px; font-weight: 700; margin-bottom: 48px; } h1 { font-size: 30px; }
p { line-height: 1.8; color: #656b60; overflow-wrap: anywhere; } .origin { font-size: 14px; }
a { display: inline-block; margin-top: 20px; padding: 12px 24px; background: #2b2f29; color: #fff; border-radius: 12px; text-decoration: none; }
a:focus-visible { outline: 3px solid #77935a; outline-offset: 4px; }
@media (prefers-color-scheme: dark) { :root { color: #e5e9df; background: #20241e; } p { color: #b6bdaf; } a { background: #e5e9df; color: #20241e; } }
</style></head><body><main><div class="brand">小 D:</div><h1>${title}</h1><p role="status">${escapeHtml(message)}</p>
<p class="origin">${url}</p>${error ? `<a href="${url}">重新连接</a><p>需要更换地址时，可从应用菜单手动打开「连接设置…」。</p>` : ""}
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
