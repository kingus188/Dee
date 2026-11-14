import { useEffect, useRef, useState } from "react";
import { request } from "../api/request.js";

type Selection = { message: { entryId: number; role: string; text: string; truncated: boolean } };
export function SearchMessage({ conversationId, entryId }: { conversationId: number; entryId: number }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, [conversationId, entryId]);
  const [result, setResult] = useState<Selection | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let current = true; setResult(null); setError("");
    void request<Selection>(`/api/conversations/search/message?conversationId=${conversationId}&entryId=${entryId}`).then(value => { if (current) setResult(value); }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message : "消息读取失败"); });
    return () => { current = false; };
  }, [conversationId, entryId]);
  return <section ref={panel} tabIndex={-1} className="search-message" aria-label="搜索定位消息"><header><strong>Matched message</strong><a href={`#chat/${conversationId}`}>Close</a></header>{error ? <p role="alert">{error}</p> : result ? <><small>{result.message.role} · #{result.message.entryId}</small><pre>{result.message.text}</pre>{result.message.truncated && <p>此消息显示前 2000 字，请在下方对话查看完整内容。</p>}</> : <p role="status">正在读取原消息…</p>}</section>;
}
