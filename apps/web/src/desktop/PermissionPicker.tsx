import { useEffect, useId, useRef, useState } from "react";
import type { AgentPermissionParameter, DesktopAgentBridge, DesktopAgentSnapshot, ExternalAgentConfig } from "@assistant/contracts";
import { Icon } from "../ui/Icon.js";
import { useComposerPopover } from "./useComposerPopover.js";

const presets = {
  codex: [
    { name: "只读", icon: "lock", description: "只读沙箱，需要额外权限时申请批准。", patch: { sandbox: "read-only", approvalPolicy: "on-request" } },
    { name: "标准", icon: "shield-check", description: "在工作区执行，风险操作需批准。", patch: { sandbox: "workspace-write", approvalPolicy: "untrusted" } },
    { name: "自动编辑", icon: "pencil", description: "工作区内自动执行，超出沙箱时申请批准。", patch: { sandbox: "workspace-write", approvalPolicy: "on-request" } },
    { name: "Full access", icon: "shield-off", description: "不使用沙箱，命令和修改无需批准。", patch: { sandbox: "danger-full-access", approvalPolicy: "never" } },
  ],
  claude: [
    { name: "计划", icon: "lock", description: "使用原生计划模式分析任务。", patch: { permissionMode: "plan" } },
    { name: "标准", icon: "shield-check", description: "由原生默认模式按需请求批准。", patch: { permissionMode: "default" } },
    { name: "自动编辑", icon: "pencil", description: "自动允许文件编辑，其他操作保留原生审批。", patch: { permissionMode: "acceptEdits" } },
    { name: "Full access", icon: "shield-off", description: "绕过原生权限确认，命令和修改无需批准。", patch: { permissionMode: "bypassPermissions" } },
  ],
  gateway: [
    { name: "逐项确认", icon: "lock", description: "工具权限请求逐项确认。", patch: { access: "ask" as const } },
    { name: "Full access", icon: "shield-off", description: "自动批准本机工具权限请求。", patch: { access: "full" as const } },
  ],
};

export function PermissionPicker({ snapshot, bridge, disabled, select, selectPi }: {
  snapshot: DesktopAgentSnapshot | null; bridge: DesktopAgentBridge; disabled: boolean;
  select(config: ExternalAgentConfig): Promise<boolean>;
  selectPi?(access: "ask" | "full"): Promise<boolean>;
}) {
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [parameters, setParameters] = useState<AgentPermissionParameter[]>([]), [loading, setLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), locked = useRef(false);
  const placement = useComposerPopover(open, root, 260), id = useId();
  const kind = snapshot?.agent ?? "pi", native = kind === "codex" || kind === "claude";
  const options = native ? presets[kind] : presets.gateway;
  const config = snapshot?.agentConfig;
  const effective: Partial<ExternalAgentConfig> = kind === "codex" ? { sandbox: config?.sandbox ?? (config?.permission === "readOnly" ? "read-only" : "workspace-write"), approvalPolicy: config?.approvalPolicy ?? (config?.permission === "autoEdit" ? "on-request" : "untrusted") } : kind === "claude" ? { permissionMode: config?.permissionMode ?? (config?.permission === "autoEdit" ? "acceptEdits" : "default") } : { access: kind === "pi" ? snapshot?.piAccess ?? "ask" : config?.access ?? "ask" };
  const current = options.find(option => Object.entries(option.patch).every(([key, value]) => effective[key as keyof ExternalAgentConfig] === value));
  const label = current?.name ?? "自定义权限";
  const supported = (patch: Partial<ExternalAgentConfig>) => native ? Object.entries(patch).every(([key, value]) => parameters.some(parameter => parameter.parameter === key && parameter.values.includes(value as string))) : kind === "pi" ? snapshot?.piAccess !== undefined && !!selectPi : config?.access !== undefined;
  useEffect(() => {
    setOpen(false); setParameters([]); setError("");
  }, [kind]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (!open || !native) return;
    let active = true;
    setParameters([]); setLoading(true); setError("");
    if (!bridge.agentPermissions) { setError("客户端不支持权限查询"); setLoading(false); return; }
    void bridge.agentPermissions().then(values => { if (active) setParameters(values); }).catch(() => { if (active) setError("无法读取原生权限等级"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, native, kind, bridge]);
  async function choose(patch: Partial<ExternalAgentConfig>) {
    if (disabled || locked.current || !supported(patch) || (kind !== "pi" && !config)) return;
    locked.current = true; setSaving(true); setError("");
    try {
      const saved = kind === "pi" ? await selectPi!(patch.access!) : await select({ ...config!, permission: undefined, ...patch });
      if (saved) { setOpen(false); trigger.current?.focus(); }
      else setError("权限未保存，请重试");
    } catch { setError("权限未保存，请重试"); }
    finally { locked.current = false; setSaving(false); }
  }
  return <div className="desktop-permission-picker" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <button className="permission-picker-trigger" ref={trigger} type="button" aria-label={`权限等级：${label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled || saving} onClick={() => setOpen(value => !value)}><Icon name="shield-check" /><span>{label}</span><Icon name="chevron-up" /></button>
    {open && <div className="permission-picker-popover" style={placement} role="dialog" aria-label="权限等级" id={id} aria-busy={loading || saving}>
      <header>权限等级</header>
      <div className="permission-picker-options" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="group" aria-label="可选权限等级">{options.map(option => <button type="button" key={option.name} aria-label={`权限：${option.name}`} aria-pressed={current === option} disabled={disabled || loading || saving || !supported(option.patch)} title={supported(option.patch) ? option.description : "当前客户端未提供该权限等级"} onClick={() => void choose(option.patch)}><Icon name={option.icon} /><span>{option.name}</span>{current === option && <Icon name="check" />}</button>)}</div>
      {current && <><strong>{current.name}</strong><p>{current.description}</p></>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
