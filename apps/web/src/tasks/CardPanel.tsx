import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConversationView, Management, PersonalData } from "@assistant/contracts";
import type { CardAction, ConversationCard } from "../chat/cards.js";
import { managementCards } from "./management.js";
import { personalCards } from "../personal/panel.js";
import { noteCards } from "./panels.js";
import { cardGroupsForTurn, visibleCards } from "./context.js";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";
import { isDaylightSnapshot } from "../today/data.js";
import { relatedTaskCards, relatedTaskIds } from "./related.js";
import { RunDetails } from "./RunDetails.js";
import { RelatedTaskDetails } from "./RelatedTaskDetails.js";

function CardActions({ actions, pending, onAction }: { actions: CardAction[] | undefined; pending: boolean; onAction: (action: CardAction) => void }) {
  if (!actions?.length) return null;
  return <div className="conversation-card-actions">{actions.map((action, i) => action.kind === "link" ?
    <a key={i} href={action.href} download={action.download}>{action.label}</a> : <button key={i} type="button" disabled={pending} onClick={() => onAction(action)}>{pending ? "处理中…" : action.label}</button>)}</div>;
}

export function Card({ card, pending, onAction }: { card: ConversationCard; pending: boolean; onAction: (action: CardAction) => void }) {
  if (card.daylight) return <article className="related-task-detail" data-card-key={card.key} aria-label={card.title}><RelatedTaskDetails card={card} /><CardActions actions={card.actions} pending={pending} onAction={onAction} /></article>;
  if (card.key === "notes:todo" || card.key === "notes:memo") return <article className="conversation-card notes-card" data-card-key={card.key} aria-label={card.title} aria-busy={pending}>
    <details className="note-summary"><summary><Icon name="notebook-pen" /><span>{card.title}</span><span className="note-meta">{card.meta}</span><Icon name="chevron-down" /></summary>
      <div className="note-content"><p className="conversation-card-text">{card.text}</p><CardActions actions={card.actions} pending={pending} onAction={onAction} /></div>
    </details>
  </article>;
  return <article className="conversation-card" data-card-key={card.key} aria-label={card.title} aria-busy={pending}>
    <header className="conversation-card-header"><h3>{card.title}</h3>{card.status && <span className={`conversation-card-status ${card.tone || ""}`}>{card.status}</span>}</header>
    <p className="conversation-card-text">{card.text}</p>{card.meta && <p className="conversation-card-meta">{card.meta}</p>}
    {!card.runs?.length && card.details && <details><summary>查看详情</summary><pre>{card.details}</pre></details>}
    {!!card.runs?.length && <section aria-label="逐次执行与验收">{card.runs.map(run => <RunDetails key={run.id + run.revision} run={run} pending={pending} onAction={onAction} />)}</section>}
    <CardActions actions={card.actions} pending={pending} onAction={onAction} />
  </article>;
}

export function CardPanel({ view, onPrompt, compactTasks = false, detailsHost, onRelatedCount, onOpenDetails }: {
  view: ConversationView | null; onPrompt: (text: string) => void; compactTasks?: boolean;
  detailsHost?: HTMLElement | null; onRelatedCount?: (count: number) => void; onOpenDetails?: () => void;
}) {
  const [cards, setCards] = useState<ConversationCard[]>([]), [loaded, setLoaded] = useState(false);
  const [loadedOwner, setLoadedOwner] = useState<number | null>(null);
  const [daylight, setDaylight] = useState<ConversationCard[]>([]), [selected, setSelected] = useState("");
  const [errors, setErrors] = useState(false), [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(new Set<string>()), [kept, setKept] = useState(new Set<string>());
  const owner = view?.conversationId ?? null, currentOwner = useRef(owner), sequence = useRef(0);
  const inFlight = useRef(new Set<string>()), lastUser = useRef<number | undefined>(undefined);
  currentOwner.current = owner;
  async function refresh() {
    const version = ++sequence.current;
    const results = await Promise.allSettled([
      owner === null ? Promise.resolve({ schedules: [], reminders: [], background: [] } as Management) : request<Management>(`/api/conversations/${owner}/management`),
      request<PersonalData>("/api/personal"),
    ]);
    if (version !== sequence.current || owner !== currentOwner.current) return;
    const [management, personal] = results;
    setCards([...(management.status === "fulfilled" && owner !== null ? managementCards(management.value, String(owner)) : []),
      ...(personal.status === "fulfilled" ? personalCards(personal.value) : [])]);
    setErrors(results.some(result => result.status === "rejected")); setLoaded(true); setLoadedOwner(owner);
    if (compactTasks) {
      const ids = relatedTaskIds(view?.entries ?? [], management.status === "fulfilled" ? management.value : undefined);
      if (!ids.length) { setDaylight([]); return; }
      try {
        const snapshot: unknown = await request("/api/daylight");
        if (!isDaylightSnapshot(snapshot)) throw new Error("待办数据格式不正确");
        if (version === sequence.current && owner === currentOwner.current) setDaylight(relatedTaskCards(ids, snapshot));
      } catch {
        if (version === sequence.current && owner === currentOwner.current) setDaylight([{ key: "daylight:load-error", group: "tasks", title: "关联待办暂时无法读取", text: "请检查连接后重新读取最新状态。", tone: "error", actions: [{ label: "重新读取", kind: "refresh" }] }]);
      }
    }
  }
  const toolId = view?.entries.findLast(entry => entry.kind === "tool")?.id;
  const userId = view?.entries.findLast(entry => entry.kind === "user")?.id;
  useEffect(() => {
    if (lastUser.current !== undefined && userId !== lastUser.current) setKept(new Set());
    lastUser.current = userId;
  }, [userId]);
  useEffect(() => { setCards([]); setDaylight([]); setSelected(""); setLoaded(false); setFeedback(""); setKept(new Set()); }, [owner]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { clearInterval(timer); sequence.current++; };
  }, [owner, toolId, compactTasks]);
  async function act(card: ConversationCard, action: CardAction) {
    if (action.kind === "prompt") { onPrompt(action.text); return; }
    if (action.kind === "refresh") { await refresh(); return; }
    if (action.kind !== "request" && action.kind !== "edit" || inFlight.current.has(card.key)) return;
    const text = action.kind === "edit" ? window.prompt("修改这条记忆", action.text)?.trim() : undefined;
    if (action.kind === "edit" && (!text || text === action.text)) return;
    inFlight.current.add(card.key); setPending(new Set(inFlight.current)); setKept(old => new Set([...old, card.key])); setFeedback("正在处理…");
    try {
      await request(action.path, action.kind === "request" ? action.body ?? {} : { text });
      if (owner === currentOwner.current) { setFeedback("操作已完成。"); await refresh(); }
    } catch {
      if (owner === currentOwner.current) { setFeedback("操作未能确认，请核对最新状态后再操作。"); await refresh(); }
    } finally { inFlight.current.delete(card.key); setPending(new Set(inFlight.current)); }
  }
  const currentCards = owner === loadedOwner ? cards : [], currentDaylight = compactTasks && owner === loadedOwner ? daylight : [];
  const shown = [...currentDaylight, ...visibleCards([...currentCards, ...noteCards(view?.notes)], null, kept, cardGroupsForTurn(view?.entries ?? []))];
  if (errors && owner === loadedOwner) shown.push({ key: "load-error", group: "tasks", title: "暂时无法更新卡片", text: "资料读取失败，请检查连接后重试。", tone: "error", actions: [{ label: "重新读取", kind: "refresh" }] });
  const related = [...currentDaylight, ...currentCards.filter(card => card.group === "tasks")];
  useEffect(() => { onRelatedCount?.(compactTasks ? related.length : 0); }, [compactTasks, related.length, onRelatedCount]);
  const current = related.find(card => card.key === selected) ?? related[0];
  function open(card: ConversationCard) { setSelected(card.key); onOpenDetails?.(); }
  // The thread shows only the selected (by default most recent) task; the side panel lists the rest.
  const threadCards = compactTasks ? shown.filter(card => card.group !== "tasks" || card.key === "load-error" || card === current) : shown;
  return <><div id="conversation-cards" aria-label="对话卡片" aria-busy={!loaded}>{threadCards.map(card => compactTasks && card.group === "tasks" && card.key !== "load-error" ?
    <article className="related-task-summary" data-card-key={card.key} key={card.key}><div className="related-summary-body">
      <button type="button" className="related-summary-open" aria-controls="related-tasks-panel" onClick={() => open(card)}>
        <span className="related-summary-icon"><Icon name={card.daylight ? "square-check" : "list-todo"} /></span><span className="related-summary-copy"><strong>{card.daylight || card.key.startsWith("daylight:") ? card.title : card.text.split("\n")[0] || card.title}</strong><small>{card.daylight ? card.meta || "关联待办" : card.title}</small></span>{card.status && <span className="related-summary-status">{card.status}</span>}
      </button>
      {!!card.daylight?.task.checklist.length && <ul className="related-summary-checklist" aria-label="子任务（只读）">{card.daylight.task.checklist.map(item => <li key={item.id} data-done={item.done}>{item.title}<span className="sr-only">{item.done ? "已完成" : "未完成"}</span></li>)}</ul>}
      {card.daylight && <div className="related-summary-actions"><a href={`#tasks/${encodeURIComponent(card.daylight.task.id)}`}>在待办中查看</a></div>}
    </div></article> : <Card key={card.key} card={card} pending={pending.has(card.key)} onAction={action => void act(card, action)} />)}</div><p id="card-feedback" role="status" aria-live="polite">{feedback}</p>
    {compactTasks && detailsHost && createPortal(<>
      {related.length > 1 && <label className="related-task-picker"><span>当前任务</span><select value={current?.key ?? ""} onChange={event => setSelected(event.target.value)}>{related.map(card => <option key={card.key} value={card.key}>{card.daylight ? card.title : `${card.title} · ${card.text.split("\n")[0]}`}</option>)}</select></label>}
      {current && <Card key={current.key} card={current} pending={pending.has(current.key)} onAction={action => void act(current, action)} />}
      {feedback && <p className="related-task-feedback" role="status">{feedback}</p>}
    </>, detailsHost)}
  </>;
}
