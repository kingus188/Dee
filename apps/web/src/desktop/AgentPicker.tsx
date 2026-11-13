import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { DesktopAgentKind, DesktopAgentSnapshot, ExternalAgentConfig } from "@assistant/contracts";
import { Icon } from "../ui/Icon.js";
import type { DesktopAgentBridge, AgentPermissionParameter } from "@assistant/contracts";

export const agentNames = { pi: "Pi", codex: "Codex", claude: "Claude Code", omp: "OMP", acp: "ACP Agent" };
const kinds = Object.keys(agentNames) as DesktopAgentKind[];

function AgentMark({ kind }: { kind: DesktopAgentKind }) {
  if (kind === "codex" || kind === "omp") return <Icon name="terminal" />;
  if (kind === "claude") return <Icon name="sun" />;
  if (kind === "acp") return <Icon name="plug" />;
  return <span aria-hidden="true">π</span>;
}

export function AgentPicker({ snapshot, disabled, select, settings, bridge, saved }: {
  bridge: DesktopAgentBridge;
  saved(): Promise<void>;
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
  const [models, setModels] = useState<Array<{ id: string; name: string; efforts: string[] }>>([]);
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const native = current === "codex" || current === "claude";
  const [permissions, setPermissions] = useState<AgentPermissionParameter[]>([]);
  const [permissionError, setPermissionError] = useState("");
  useEffect(() => {
    setPermissions([]); setPermissionError("");
    if (!open || !native) return;
    let active = true;
    if (!bridge.agentPermissions) { setPermissionError("客户端不支持权限参数查询"); return; }
    void bridge.agentPermissions().then(values => { if (active) setPermissions(values); }).catch(() => { if (active) setPermissionError("无法读取 Agent 权限参数"); });
    return () => { active = false; };
  }, [open, current, bridge, native]);
  const modelView = native && filter === current;
  const selectedModel = snapshot?.agentConfig?.model ?? "";
  const efforts = models.find(value => value.id === selectedModel)?.efforts ?? (!selectedModel ? models[0]?.efforts : []) ?? [];
  const model = (kind: DesktopAgentKind) => kind === "pi" ? snapshot?.model.model || "未配置模型" : kind === current ? selectedModel || "默认模型" : "默认模型";
  const visible = kinds.filter(kind => (filter === "all" || kind === filter) && `${agentNames[kind]} ${model(kind)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    setModels([]); setError(""); setLoading(false);
    if (!open || !native) return;
    let active = true;
    setLoading(true);
    if (!bridge.agentModels) { setError("客户端不支持模型查询"); setLoading(false); return; }
    void bridge.agentModels().then(values => { if (active) setModels(values); }).catch(() => { if (active) setError("无法读取模型，请检查 Agent 登录与配置"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, current, bridge, native]);
  async function update(patch: Partial<ExternalAgentConfig>) {
    if (disabled || selecting.current || !snapshot?.agentConfig) return;
    selecting.current = true; setSaving(true); setError("");
    try { await bridge.selectAgent({ kind: current, config: { ...snapshot.agentConfig, ...patch } }); await saved(); }
    catch { setError("设置未保存，请重试"); }
    finally { selecting.current = false; setSaving(false); }
  }
  async function browse(kind: DesktopAgentKind) {
    if (disabled || selecting.current) return;
    setQuery("");
    if (kind === current) { setFilter(kind); return; }
    selecting.current = true; setSaving(true);
    try { if (await select(kind)) setFilter(kind); }
    finally { selecting.current = false; setSaving(false); }
  }

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
      root.current?.querySelector<HTMLButtonElement>(".agent-picker-main .agent-picker-option:not(:disabled)")?.click();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...root.current!.querySelectorAll<HTMLButtonElement>(".agent-picker-option:not(:disabled)")];
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
    <button className="agent-picker-trigger" type="button" ref={trigger} aria-label="执行 Agent" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled || saving} title={`${agentNames[current]} · ${model(current)}`} onClick={() => { setQuery(""); setFilter(native ? current : "all"); setOpen(value => !value); }}>
      <span className="agent-picker-mark" data-agent={current}><AgentMark kind={current} /></span>
      <span className="agent-picker-current">{agentNames[current]}<span className="agent-picker-model"> · {model(current)}</span></span>
    </button>
    {open && <div className="agent-picker-popover" data-model-view={modelView} id={id} role="dialog" aria-label="选择 Agent 与模型" aria-busy={loading || saving} onKeyDown={navigate}>
      <nav className="agent-picker-rail" aria-label="筛选 Agent">
        <button type="button" aria-label="全部 Agent" aria-pressed={filter === "all"} title="全部 Agent" onClick={() => setFilter("all")}><Icon name="grid-2x2" /></button>
        {kinds.map(kind => <button type="button" key={kind} disabled={disabled || saving} aria-label={`筛选 ${agentNames[kind]}`} aria-pressed={filter === kind} title={agentNames[kind]} data-agent={kind} onClick={() => { if (kind === "codex" || kind === "claude") void browse(kind); else setFilter(kind); }}><AgentMark kind={kind} /></button>)}
      </nav>
      <div className="agent-picker-main">
        <label className="agent-picker-search"><Icon name="search" /><input ref={search} aria-label="搜索 Agent 或模型" placeholder="搜索 Agent 或模型…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="agent-picker-options" role="group" aria-label="可用 Agent">
          {modelView ? <>
            {!query.trim() && <button type="button" className="agent-picker-option" aria-pressed={!selectedModel} disabled={disabled || saving || loading} onClick={() => void update({ model: undefined, effort: undefined })}>Agent 默认{!selectedModel && <Icon name="check" />}</button>}
            {models.filter(value => `${value.name} ${value.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(value => <button className="agent-picker-option" type="button" key={value.id} title={value.id} aria-label={`选择模型 ${value.name}`} aria-pressed={selectedModel === value.id} disabled={disabled || saving || loading} onClick={() => void update({ model: value.id, effort: undefined })}><span className="agent-picker-mark"><AgentMark kind={current} /></span><span className="agent-picker-option-text">{value.name}</span>{selectedModel === value.id && <Icon name="check" />}</button>)}
            {loading && <p className="agent-picker-empty" role="status">正在读取模型…</p>}
          </> : visible.map(kind => <button className="agent-picker-option" type="button" key={kind} aria-label={`选择 ${agentNames[kind]}`} aria-pressed={current === kind} disabled={disabled || saving} onClick={() => void choose(kind)}>
            <span className="agent-picker-mark" data-agent={kind}><AgentMark kind={kind} /></span>
            <span className="agent-picker-option-text"><span>{agentNames[kind]}</span><span className="agent-picker-option-model">{model(kind)}</span></span>
            {current === kind && <Icon name="check" />}
          </button>)}
          {!modelView && !visible.length && <p className="agent-picker-empty" role="status">没有匹配的 Agent 或模型</p>}
          {error && <p className="agent-picker-empty" role="alert">{error}</p>}
        </div>
      </div>
      {modelView && <div className="agent-picker-reasoning" role="group" aria-label="思考强度"><header>思考强度</header>{["", ...efforts].map(effort => <button className="agent-picker-option" type="button" key={effort} disabled={disabled || saving || loading} aria-pressed={(snapshot?.agentConfig?.effort ?? "") === effort} onClick={() => void update({ effort: effort || undefined })}><span>{effort || "Agent 默认"}</span>{(snapshot?.agentConfig?.effort ?? "") === effort && <Icon name="check" />}</button>)}</div>}
      <div className="agent-picker-footer"><span>{agentNames[current]}</span>{permissions.map(({ parameter, values }) => <label className="agent-picker-permission" key={parameter}><span>{parameter}</span><select aria-label={parameter} disabled={disabled || saving} value={snapshot?.agentConfig?.[parameter] ?? ""} onChange={event => void update({ [parameter]: event.target.value || undefined })}><option value="">未覆盖</option>{values.map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}{permissionError && <span role="alert">{permissionError}</span>}{(current === "acp" || current === "omp") && <button type="button" disabled={disabled || saving} onClick={() => { close(); settings(); }}><Icon name="settings" />设置</button>}</div>
    </div>}
  </div>;
}
