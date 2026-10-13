import type { ViewEntry } from "../types.js";
import { escapeHtml } from "../ui/format.js";

export function renderToolFailure(entry: ViewEntry) {
  return `<div class="error-system-card">
    <div class="error-system-main">这一步没有完成。</div>
    <div class="error-system-sub">可以稍后重试，或告诉我换一种处理方式。</div>
    <details><summary>查看原因</summary><div class="tool-result-content">${escapeHtml(entry.text)}</div></details>
  </div>`;
}
