import { useEffect, useRef, useState } from "react";
import type { DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";

export function ExternalAgentSettings({ snapshot, bridge, busy, saved }: { snapshot: DesktopAgentSnapshot; bridge: DesktopAgentBridge; busy: boolean; saved(): Promise<void> }) {
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const locked = useRef(false);
  const [models, setModels] = useState<Array<{ id: string; name: string; efforts: string[] }>>([]);
  const [model, setModel] = useState(snapshot.agentConfig?.model ?? "");
  const [effort, setEffort] = useState(snapshot.agentConfig?.effort ?? "");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!["codex", "claude"].includes(snapshot.agent!)) { setLoading(false); return; }
    let active = true;
    if (!bridge.agentModels) { setError("客户端不支持模型查询"); setLoading(false); return; }
    void bridge.agentModels().then(values => { if (active) { setModels(values); setModel(current => current || (snapshot.agent === "claude" ? values.find(value => value.id === "default")?.id : values[0]?.id) || ""); } }).catch(() => { if (active) setError("无法读取 Agent 模型，请检查原生登录与配置"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [bridge, snapshot.agent]);
  const efforts = models.find(value => value.id === model)?.efforts ?? [];
  return <form className="settings-form desktop-model-form" aria-label="外部 Agent 设置" aria-busy={saving} onSubmit={event => {
    event.preventDefault();
    if (locked.current || busy) return;
    const data = new FormData(event.currentTarget);
    const permission = String(data.get("permission") ?? "default") as "default" | "readOnly" | "autoEdit";
    locked.current = true; setSaving(true); setError("");
    void bridge.selectAgent({ kind: snapshot.agent!, config: { executable: String(data.get("executable") ?? ""), args: snapshot.agent === "acp" ? String(data.get("args") ?? "").split(/\r?\n/).filter(Boolean) : [], ...(["codex", "claude"].includes(snapshot.agent!) ? { permission, ...(model ? { model } : {}), ...(effort && efforts.includes(effort) ? { effort } : {}) } : {}), ...(snapshot.agent === "acp" ? { mode: String(data.get("mode") ?? "") } : {}) } })
      .then(saved).catch(() => setError("Agent 配置未保存，请检查可执行文件和参数。")).finally(() => { locked.current = false; setSaving(false); });
  }}>
    <fieldset disabled={saving || busy}>
      <label>可执行文件<input name="executable" required defaultValue={snapshot.agentConfig?.executable ?? ""} autoComplete="off" /></label>
      {["codex", "claude"].includes(snapshot.agent!) && <>
        <label>权限<select name="permission" defaultValue={snapshot.agentConfig?.permission ?? "default"}><option value="default">默认审批</option>{snapshot.agent === "codex" && <option value="readOnly">只读沙箱</option>}<option value="autoEdit">自动编辑，按需审批</option></select></label>
        <label>模型<select value={model} disabled={loading} onChange={event => { setModel(event.target.value); setEffort(""); }}><option value="">Agent 默认</option>{models.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
        <label>思考强度<select name="effort" value={efforts.includes(effort) ? effort : ""} disabled={loading || !efforts.length} onChange={event => setEffort(event.target.value)}><option value="">Agent 默认</option>{efforts.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      </>}
      {snapshot.agent === "acp" && <>
        <label>启动参数（每行一个）<textarea name="args" rows={3} defaultValue={snapshot.agentConfig?.args.join("\n") ?? ""} autoComplete="off" /></label>
        <label>模式 ID<input name="mode" defaultValue={snapshot.agentConfig?.mode ?? ""} autoComplete="off" /></label>
      </>}
    </fieldset>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <button className="settings-save" type="submit" disabled={saving || busy}>{saving ? "正在保存…" : "保存 Agent"}</button>
  </form>;
}
