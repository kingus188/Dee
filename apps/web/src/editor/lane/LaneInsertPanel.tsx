import { useState } from "react";
import type { InsertKind } from "./LaneToolbar.js";
interface Props { kind: InsertKind; selected: string; disabled: boolean; apply: (markdown: string) => void; cancel: () => void }
export function LaneInsertPanel({ kind, selected, disabled, apply, cancel }: Props) {
  const [value, setValue] = useState(""), [label, setLabel] = useState(selected), [error, setError] = useState("");
  const title = kind === "link" ? "链接" : kind === "image" ? "图片地址" : "行内公式";
  function submit() {
    const address = value.trim();
    if (!address) { setError("请填写内容。"); return; }
    const allowed = kind === "link" ? /^(?:https?:\/\/|mailto:|#)[^\s<>"\\]+$/i.test(address) : kind === "image" ? /^(?:https:\/\/[^\s<>"()\\]+|data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/]+=*)$/i.test(address) : !/[\r\n$]/.test(address);
    if (!allowed) { setError(kind === "image" ? "请输入 HTTPS 图片地址或 PNG、JPEG、GIF、WebP 数据地址。" : kind === "link" ? "请输入 HTTP、HTTPS、邮件或文档锚点地址。" : "请填写单行 LaTeX 公式，不包含美元符号。"); return; }
    const text = (label || (kind === "image" ? "图片" : "链接")).replace(/[\\[\]]/g, "\\$&");
    apply(kind === "inline-math" ? `$${address}$` : `${kind === "image" ? "!" : ""}[${text}](<${address}>)`);
  }
  return <div className="lane-insert-panel" role="dialog" aria-label={`插入${title}`}>
    <label>{kind === "inline-math" ? "LaTeX" : title}<input autoFocus value={value} disabled={disabled} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter") { event.preventDefault(); submit(); } if (event.key === "Escape") cancel(); }} /></label>
    {kind !== "inline-math" && <label>{kind === "image" ? "图片说明" : "链接文字"}<input value={label} disabled={disabled} onChange={event => setLabel(event.target.value)} /></label>}
    <button type="button" disabled={disabled} onClick={submit}>插入</button><button type="button" onClick={cancel}>取消</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
