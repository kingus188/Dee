import { useEffect, useRef, useState } from "react";
import type { ModelSettings as Settings, ModelSettingsInput } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";
import { ServerConnection } from "./ServerConnection.js";
import { MailSettings } from "./MailSettings.js";
import { WechatSettings } from "./WechatSettings.js";
import { NotificationSettings } from "./NotificationSettings.js";

export function ModelSettings({ onBack }: { onBack: () => void }) {
  const [saved, setSaved] = useState<Settings | null>(null), [modelId, setModelId] = useState("");
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const heading = useRef<HTMLHeadingElement>(null), version = useRef(0), sending = useRef(false);
  function apply(data: Settings) { setSaved(data); setModelId(data.selectedModel); }
  async function load() {
    const current = ++version.current;
    setLoading(true); setError(""); setFeedback("");
    try {
      const data = await request<Settings>("/api/settings/model");
      if (current === version.current) apply(data);
    } catch { if (current === version.current) setError("暂时未能读取服务器模型列表，请重试。"); }
    finally { if (current === version.current) setLoading(false); }
  }
  useEffect(() => { heading.current?.focus(); void load(); return () => { version.current++; }; }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current || !saved || !saved.models.some(item => item.id === modelId)) return;
    sending.current = true; setPending(true); setError(""); setFeedback("");
    const current = version.current;
    try {
      const input: ModelSettingsInput = { modelId };
      const data = await request<Settings>("/api/settings/model", input);
      if (current === version.current) { apply(data); setFeedback(data.restartRequired ? "已选择，重启后台服务后生效。" : "已选择，当前模型已生效。"); }
    } catch (error) {
      if (current === version.current) setError(error instanceof Error ? error.message : "选择结果尚未确认，请重新读取列表后核对。");
    } finally { sending.current = false; if (current === version.current) setPending(false); }
  }
  const activeName = saved?.models.find(item => item.id === saved.activeModel)?.name;
  return <section className="model-settings" aria-labelledby="settings-title">
    <div className="settings-heading"><div><p className="settings-eyebrow">个人空间 / 设置</p><h1 id="settings-title" ref={heading} tabIndex={-1}>连接与模型</h1><p>连接后台服务器，选择服务器已配置的模型。</p></div><button className="icon-button" type="button" aria-label="关闭设置" onClick={onBack}><Icon name="x" /></button></div>
    <div className="settings-content">
      <ServerConnection />
      {loading ? <p role="status">正在读取服务器模型列表…</p> : !saved ? <div className="settings-load-error"><p role="alert">{error}</p><button className="header-button" type="button" onClick={() => void load()}>重新读取</button></div> : <>
        <div className="settings-status"><Icon name="plug" /><div><strong>{saved.restartRequired ? "已选择，等待后台重启" : saved.activeModel ? "当前模型" : "服务器尚未配置模型"}</strong><p>{activeName || saved.activeModel || "请由服务器管理员配置模型，再重新读取列表。"}{saved.restartRequired ? " · 新选择将在后台服务重启后使用" : ""}</p></div></div>
        {saved.models.length > 0 && <form className="settings-form" onSubmit={event => void save(event)} aria-busy={pending}>
          <fieldset disabled={pending}>
            <label htmlFor="server-model">可用模型<span>列表由后台服务器提供</span></label>
            <select id="server-model" value={modelId} onChange={event => { setModelId(event.target.value); setFeedback(""); }}>{saved.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <p className="settings-field-hint">模型连接、接口协议和访问密钥统一在服务器端管理。</p>
          </fieldset>
          {error && <p className="settings-error" role="alert">{error}</p>}
          <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p>
          <div className="settings-actions"><button className="header-button" type="button" disabled={pending} onClick={() => void load()}>重新读取列表</button><button className="settings-save" type="submit" disabled={pending || !modelId}>{pending ? <Icon name="loader-circle" /> : <Icon name="check" />}{pending ? "正在选择…" : "选择模型"}</button></div>
        </form>}
        {saved.models.length === 0 && <button className="header-button" type="button" onClick={() => void load()}>重新读取列表</button>}
      </>}
      <WechatSettings />
      <MailSettings />
      <NotificationSettings />
    </div>
  </section>;
}
