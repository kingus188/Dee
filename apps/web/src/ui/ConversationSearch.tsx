import { useEffect, useRef, useState } from "react";
import type { ConversationSearchResult, ConversationStatus } from "@assistant/contracts";
import { request } from "../api/request.js";

export function ConversationSearch({ query, archived }: { query: string; archived: boolean }) {
  const [status, setStatus] = useState<ConversationStatus | "">("");
  const [after, setAfter] = useState(""), [before, setBefore] = useState("");
  const [result, setResult] = useState<ConversationSearchResult | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [revision, refresh] = useState(0);
  const generation = useRef(0);
  async function load(cursor?: string, version = generation.current) {
    const params = new URLSearchParams({ q: query.trim(), archived: String(archived) });
    if (status) params.set("status", status);
    if (after) params.set("after", String(new Date(`${after}T00:00:00`).getTime()));
    if (before) params.set("before", String(new Date(`${before}T00:00:00`).getTime()));
    if (cursor) params.set("cursor", cursor);
    setBusy(true); setError("");
    try {
      const next = await request<ConversationSearchResult>(`/api/conversations/search?${params}`);
      if (generation.current !== version) return;
      setResult(previous => ({ ...next, items: cursor ? [...(previous?.items ?? []), ...next.items] : next.items }));
    } catch (reason) { if (generation.current === version) setError(reason instanceof Error ? reason.message : "搜索失败"); }
    finally { if (generation.current === version) setBusy(false); }
  }
  useEffect(() => {
    const version = ++generation.current;
    setResult(null); setError(""); setBusy(false);
    if (!query.trim()) return;
    const timer = setTimeout(() => void load(undefined, version), 250);
    return () => { clearTimeout(timer); generation.current++; };
  }, [query, archived, status, after, before, revision]);
  return <section className="conversation-body-search" aria-label="搜索对话正文">
    <div className="conversation-search-filters">
      <select aria-label="Search status" value={status} onChange={event => setStatus(event.target.value as ConversationStatus | "")}><option value="">All statuses</option><option value="active">Active</option><option value="waiting">Waiting</option><option value="completed">Completed</option></select>
      <label>From<input aria-label="Search from date" type="date" value={after} onChange={event => setAfter(event.target.value)} /></label>
      <label>Before<input aria-label="Search before date" type="date" value={before} onChange={event => setBefore(event.target.value)} /></label>
    </div>
    {busy && <p role="status">正在搜索正文…</p>}
    {error && <p role="alert">{error}<button type="button" onClick={() => refresh(value => value + 1)}>Retry</button></p>}
    {result?.items.map(hit => <a className="conversation-search-hit" key={`${hit.conversation.id}:${hit.entryId}`} href={hit.href}><strong>{hit.conversation.title}</strong><small>{hit.role} · {hit.timestamp !== undefined ? new Date(hit.timestamp).toLocaleString() : "Time unknown"}</small><span>{hit.snippet}</span></a>)}
    {result && !result.items.length && <p className="workspace-muted">{result.nextCursor ? "这一批没有匹配，可继续搜索。" : "没有匹配的正文。"}</p>}
    {result?.nextCursor && <button type="button" disabled={busy} onClick={() => void load(result.nextCursor!)}>Continue search</button>}
  </section>;
}
