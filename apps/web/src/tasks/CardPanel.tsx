import { useEffect, useRef, useState } from "react";
import type { ConversationView, Management, PersonalData } from "@assistant/contracts";
import type { CardAction, ConversationCard } from "../chat/cards.js";
import { managementCards } from "./management.js";
import { personalCards } from "../personal/panel.js";
import { noteCards } from "./panels.js";
import { cardGroupsForTurn, visibleCards } from "./context.js";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";

function CardActions({ actions, pending, onAction }: { actions: CardAction[] | undefined; pending: boolean; onAction: (action: CardAction) => void }) {
  if (!actions?.length) return null;
  return <div className="conversation-card-actions">{actions.map((action, i) => action.kind === "link" ?
    <a key={i} href={action.href} download={action.download}>{action.label}</a> : <button key={i} type="button" disabled={pending} onClick={() => onAction(action)}>{pending ? "处理中…" : action.label}</button>)}</div>;
}

export function Card({ card, pending, onAction }: { card: ConversationCard; pending: boolean; onAction: (action: CardAction) => void }) {
  if (card.key === "notes:todo" || card.key === "notes:memo") return <article className="conversation-card notes-card" data-card-key={card.key} aria-label={card.title} aria-busy={pending}>
    <details className="note-summary"><summary><Icon name="notebook-pen" /><span>{card.title}</span><span className="note-meta">{card.meta}</span><Icon name="chevron-down" /></summary>
      <div className="note-content"><p className="conversation-card-text">{card.text}</p><CardActions actions={card.actions} pending={pending} onAction={onAction} /></div>
    </details>
  </article>;
  return <article className="conversation-card" data-card-key={card.key} aria-label={card.title} aria-busy={pending}>
    <header className="conversation-card-header"><h3>{card.title}</h3>{card.status && <span className={`conversation-card-status ${card.tone || ""}`}>{card.status}</span>}</header>
    <p className="conversation-card-text">{card.text}</p>{card.meta && <p className="conversation-card-meta">{card.meta}</p>}
    {card.details && <details><summary>查看详情</summary><pre>{card.details}</pre></details>}
    <CardActions actions={card.actions} pending={pending} onAction={onAction} />
  </article>;
}

export function CardPanel({ view, onPrompt }: {
  view: ConversationView | null; onPrompt: (text: string) => void;
}) {
  const [cards, setCards] = useState<ConversationCard[]>([]), [loaded, setLoaded] = useState(false);
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
    setErrors(results.some(result => result.status === "rejected")); setLoaded(true);
  }
  const toolId = view?.entries.findLast(entry => entry.kind === "tool")?.id;
  const userId = view?.entries.findLast(entry => entry.kind === "user")?.id;
  useEffect(() => {
    if (lastUser.current !== undefined && userId !== lastUser.current) setKept(new Set());
    lastUser.current = userId;
  }, [userId]);
  useEffect(() => { setCards([]); setLoaded(false); setFeedback(""); setKept(new Set()); }, [owner]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => { clearInterval(timer); sequence.current++; };
  }, [owner, toolId]);
  async function act(card: ConversationCard, action: CardAction) {
    if (action.kind === "prompt") { onPrompt(action.text); return; }
    if (action.kind === "refresh") { await refresh(); return; }
    if (action.kind !== "request" && action.kind !== "edit" || inFlight.current.has(card.key)) return;
    const text = action.kind === "edit" ? window.prompt("修改这条记忆", action.text)?.trim() : undefined;
    if (action.kind === "edit" && (!text || text === action.text)) return;
    inFlight.current.add(card.key); setPending(new Set(inFlight.current)); setKept(old => new Set([...old, card.key])); setFeedback("正在处理…");
    try {
      await request(action.path, text === undefined ? {} : { text });
      if (owner === currentOwner.current) { setFeedback("操作已完成。"); await refresh(); }
    } catch {
      if (owner === currentOwner.current) { setFeedback("操作未能确认，请核对最新状态后再操作。"); await refresh(); }
    } finally { inFlight.current.delete(card.key); setPending(new Set(inFlight.current)); }
  }
  const shown = visibleCards([...cards, ...noteCards(view?.notes)], null, kept, cardGroupsForTurn(view?.entries ?? []));
  if (errors) shown.push({ key: "load-error", group: "tasks", title: "暂时无法更新卡片", text: "资料读取失败，请检查连接后重试。", tone: "error", actions: [{ label: "重新读取", kind: "refresh" }] });
  return <><div id="conversation-cards" aria-label="对话卡片" aria-busy={!loaded}>{shown.map(card => <Card key={card.key} card={card} pending={pending.has(card.key)} onAction={action => void act(card, action)} />)}</div><p id="card-feedback" role="status" aria-live="polite">{feedback}</p></>;
}
