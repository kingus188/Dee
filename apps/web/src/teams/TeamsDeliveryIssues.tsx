import { useEffect, useRef, useState } from "react";
import type { TeamsDeliveryIssues as Issues, TeamsDeliveryRecheck } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";

function issues(value: unknown): value is Issues {
  if (!value || typeof value !== "object") return false;
  const data = value as Issues;
  return typeof data.available === "boolean" && typeof data.truncated === "boolean" && Array.isArray(data.items) && data.items.every(item =>
    item && typeof item.id === "string" && ["sending", "unknown"].includes(item.state) && Number.isFinite(item.createdAt)
    && Number.isInteger(item.sourceCount) && item.sourceCount > 0 && ["current", "invalidated"].includes(item.sourceStatus) && item.receipt === "unavailable");
}
export function TeamsDeliveryIssues({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false), [data, setData] = useState<Issues | null>(null);
  const [busy, setBusy] = useState<string | null>(null), [feedback, setFeedback] = useState("");
  const generation = useRef(0), pending = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const current = ++generation.current;
    setData(null);
    if (active && open) {
      setFeedback("");
      void request("/api/teams/delivery-issues").then(value => {
        if (current !== generation.current) return;
        if (!issues(value)) throw new Error("异常记录格式无效，请重新打开核对。");
        setData(value);
      }).catch(error => { if (current === generation.current) setFeedback(error instanceof Error ? error.message : "异常记录读取失败。"); });
    }
    return () => { generation.current++; };
  }, [active, open]);
  async function recheck(id: string) {
    if (!active || pending.current || !data?.available) return;
    const current = generation.current;
    pending.current = true; setBusy(id); setFeedback("");
    try {
      const value = await request<TeamsDeliveryRecheck>("/api/teams/delivery-issues/recheck", { id });
      if (current !== generation.current) return;
      if (!value || value.deliveryCheck !== "unconfirmed" || !["verified", "invalidated"].includes(value.sourceCheck)
          || !issues({ available: true, truncated: false, items: [value.item] }) || value.item.id !== id) throw new Error("核对结果无效，送达仍未确认。");
      setData(old => old ? { ...old, items: old.items.map(item => item.id === id ? value.item : item) } : old);
      setFeedback(value.sourceCheck === "verified" ? "来源已核对。送达仍未确认，没有重发。" : "来源已失效。送达仍未确认，没有重发。");
    } catch (error) {
      if (current === generation.current) setFeedback(error instanceof Error ? error.message : "来源核对失败，送达仍未确认。");
    } finally { pending.current = false; if (mounted.current) setBusy(null); }
  }
  return <details className="teams-sync-preferences" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>提醒送达异常<Icon name="chevron-down" /></summary>
    {open && <div>
      {!data && !feedback && <p role="status">正在读取…</p>}
      {data?.items.length === 0 && <p className="today-note">没有待核对的原文提醒。</p>}
      {data?.items.map(item => <section key={item.id} aria-label="送达未确认">
        <p>送达未确认 · {new Date(item.createdAt).toLocaleString()}</p>
        <p className="today-note">{item.sourceCount} 条来源 · {item.sourceStatus === "current" ? "本地来源版本未变" : "来源已失效"} · 无接收端回执</p>
        <details><summary>操作编号</summary><code style={{ overflowWrap: "anywhere" }}>{item.id}</code></details>
        <div className="teams-triage-actions"><button type="button" className="today-text-button" disabled={!active || !data.available || busy !== null} onClick={() => void recheck(item.id)}>{busy === item.id ? "正在核对…" : "核对来源"}</button></div>
      </section>)}
      {!!data?.items.length && <p className="today-note">已停止自动重发。核对来源不代表已经送达，请到接收端确认。</p>}
      {data?.truncated && <p className="today-note">仅显示前 100 项，未显示的异常仍保留。</p>}
      {feedback && <p role="status">{feedback}</p>}
    </div>}
  </details>;
}
