import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { DesktopAgentKind, DesktopAgentSnapshot } from "@assistant/contracts";
import { Icon } from "../ui/Icon.js";

export const agentNames = { pi: "Pi", codex: "Codex", claude: "Claude Code", acp: "ACP Agent" };
const kinds = Object.keys(agentNames) as DesktopAgentKind[];

function AgentMark({ kind }: { kind: DesktopAgentKind }) {
  if (kind === "codex") return <Icon name="terminal" />;
  if (kind === "claude") return <Icon name="sun" />;
  if (kind === "acp") return <Icon name="plug" />;
  return <span aria-hidden="true">π</span>;
}

export function AgentPicker({ snapshot, disabled, select, settings }: {
  snapshot: DesktopAgentSnapshot | null;
  disabled: boolean;
  select(kind: DesktopAgentKind): Promise<boolean>;
  settings(): void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DesktopAgentKind | "all">("all");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null), selecting = useRef(false), restoreFocus = useRef(false);
  const id = useId();
  const current = snapshot?.agent ?? "pi";
  const model = (kind: DesktopAgentKind) => kind === "pi" ? snapshot?.model.model || "未配置模型" : "默认模型";
  const visible = kinds.filter(kind => (filter === "all" || kind === filter) && `${agentNames[kind]} ${model(kind)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  function close() {
    restoreFocus.current = true;
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (!open && !disabled && restoreFocus.current) {
      restoreFocus.current = false; trigger.current?.focus();
    }
  }, [open, disabled]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Enter" && event.target === search.current) {
      event.preventDefault();
      if (visible[0]) void choose(visible[0]);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...root.current!.querySelectorAll<HTMLButtonElement>(".agent-picker-option")];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (document.activeElement !== search.current && index === -1) return;
    event.preventDefault();
    const next = index === -1 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  }
  async function choose(kind: DesktopAgentKind) {
    if (disabled || selecting.current) return;
    if (kind === current && kind !== "pi") { close(); return; }
    selecting.current = true;
    try { if (await select(kind)) close(); }
    finally { selecting.current = false; }
  }

  return <div className="desktop-agent-picker" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>
    <button className="agent-picker-trigger" type="button" ref={trigger} aria-label="执行 Agent" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} title={`${agentNames[current]} · ${model(current)}`} onClick={() => { setQuery(""); setFilter("all"); setOpen(value => !value); }}>
      <span className="agent-picker-mark" data-agent={current}><AgentMark kind={current} /></span>
      <span className="agent-picker-current">{agentNames[current]}<span className="agent-picker-model"> · {model(current)}</span></span>
    </button>
    {open && <div className="agent-picker-popover" id={id} role="dialog" aria-label="选择 Agent 与模型" onKeyDown={navigate}>
      <nav className="agent-picker-rail" aria-label="筛选 Agent">
        <button type="button" aria-label="全部 Agent" aria-pressed={filter === "all"} title="全部 Agent" onClick={() => setFilter("all")}><Icon name="grid-2x2" /></button>
        {kinds.map(kind => <button type="button" key={kind} aria-label={`筛选 ${agentNames[kind]}`} aria-pressed={filter === kind} title={agentNames[kind]} data-agent={kind} onClick={() => setFilter(kind)}><AgentMark kind={kind} /></button>)}
      </nav>
      <div className="agent-picker-main">
        <label className="agent-picker-search"><Icon name="search" /><input ref={search} aria-label="搜索 Agent 或模型" placeholder="搜索 Agent 或模型…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="agent-picker-options" role="group" aria-label="可用 Agent">
          {visible.map(kind => <button className="agent-picker-option" type="button" key={kind} aria-label={`选择 ${agentNames[kind]}`} aria-pressed={current === kind} disabled={disabled} onClick={() => void choose(kind)}>
            <span className="agent-picker-mark" data-agent={kind}><AgentMark kind={kind} /></span>
            <span className="agent-picker-option-text"><span>{agentNames[kind]}</span><span className="agent-picker-option-model">{model(kind)}</span></span>
            {current === kind && <Icon name="check" />}
          </button>)}
          {!visible.length && <p className="agent-picker-empty" role="status">没有匹配的 Agent 或模型</p>}
        </div>
      </div>
      <div className="agent-picker-footer"><span>{agentNames[current]}</span>{current !== "pi" && <button type="button" disabled={disabled} onClick={() => { close(); settings(); }}><Icon name="settings" />设置</button>}</div>
    </div>}
  </div>;
}
