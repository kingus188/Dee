import { useRef, useState } from "react";
import type { DesktopAgentBridge, DesktopAgentSnapshot } from "@assistant/contracts";

export function ExternalAgentSettings({ snapshot, bridge, busy, saved }: { snapshot: DesktopAgentSnapshot; bridge: DesktopAgentBridge; busy: boolean; saved(): Promise<void> }) {
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const locked = useRef(false);
  return <form className="settings-form desktop-model-form" aria-label="外部 Agent 设置" aria-busy={saving} onSubmit={event => {
    event.preventDefault();
    if (locked.current || busy) return;
    const data = new FormData(event.currentTarget);
    locked.current = true; setSaving(true); setError("");
    void bridge.selectAgent({ kind: snapshot.agent!, config: { executable: String(data.get("executable") ?? ""), args: snapshot.agent === "acp" ? String(data.get("args") ?? "").split(/\r?\n/).filter(Boolean) : [], ...(snapshot.agent === "acp" ? { mode: String(data.get("mode") ?? "") } : {}) } })
      .then(saved).catch(() => setError("Agent 配置未保存，请检查可执行文件和参数。")).finally(() => { locked.current = false; setSaving(false); });
  }}>
    <fieldset disabled={saving || busy}>
      <label>可执行文件<input name="executable" required defaultValue={snapshot.agentConfig?.executable ?? ""} autoComplete="off" /></label>
      {snapshot.agent === "acp" && <>
        <label>启动参数（每行一个）<textarea name="args" rows={3} defaultValue={snapshot.agentConfig?.args.join("\n") ?? ""} autoComplete="off" /></label>
        <label>模式 ID<input name="mode" defaultValue={snapshot.agentConfig?.mode ?? ""} autoComplete="off" /></label>
      </>}
    </fieldset>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <button className="settings-save" type="submit" disabled={saving || busy}>{saving ? "正在保存…" : "保存 Agent"}</button>
  </form>;
}
