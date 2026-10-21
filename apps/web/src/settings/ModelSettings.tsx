import { useEffect, useRef, useState } from "react";
import type { ModelProvider, ModelSettings as Settings, ModelSettingsInput } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";
import { MailSettings } from "./MailSettings.js";
import { WechatSettings } from "./WechatSettings.js";
import { NotificationSettings } from "./NotificationSettings.js";

const providers: { value: ModelProvider; label: string; hint: string }[] = [
  { value: "openai-completions", label: "OpenAI 兼容 · Chat Completions", hint: "适用于使用 Chat Completions 接口的服务。" },
  { value: "openai-responses", label: "OpenAI 兼容 · Responses", hint: "适用于使用 Responses 接口的服务。" },
  { value: "anthropic-messages", label: "Anthropic 兼容 · Messages", hint: "适用于使用 Anthropic Messages 接口的服务。" },
];

export function ModelSettings({ onBack }: { onBack: () => void }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<ModelProvider>("openai-completions");
  const [baseUrl, setBaseUrl] = useState(""), [model, setModel] = useState(""), [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const heading = useRef<HTMLHeadingElement>(null), version = useRef(0), sending = useRef(false);
  function apply(data: Settings) {
    setSaved(data); setProvider(providers.find(item => item.value === data.provider)?.value ?? "openai-completions");
    setBaseUrl(data.baseUrl); setModel(data.model); setApiKey("");
  }
  async function load() {
    const current = ++version.current;
    setLoading(true); setError("");
    try {
      const data = await request<Settings>("/api/settings/model");
      if (current === version.current) apply(data);
    } catch { if (current === version.current) setError("暂时无法读取配置，请重试。"); }
    finally { if (current === version.current) setLoading(false); }
  }
  useEffect(() => { heading.current?.focus(); void load(); return () => { version.current++; }; }, []);
  const needsKey = !saved?.hasKey || provider !== saved.provider || baseUrl.trim() !== saved.baseUrl;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (sending.current || !saved) return;
    sending.current = true; setPending(true); setError(""); setFeedback("");
    const current = version.current;
    try {
      const input: ModelSettingsInput = { provider, baseUrl: baseUrl.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      const data = await request<Settings>("/api/settings/model", input);
      if (current === version.current) { apply(data); setFeedback(data.restartRequired ? "已保存，重启服务后生效。" : "已保存，配置与当前运行一致。"); }
    } catch (error) {
      if (current === version.current) setError(error instanceof Error ? error.message : "保存未能确认，请重新读取配置后核对。");
    } finally { sending.current = false; if (current === version.current) setPending(false); }
  }
  return <section className="model-settings" aria-labelledby="settings-title">
    <div className="settings-heading"><div><p className="settings-eyebrow">个人空间 / 设置</p><h1 id="settings-title" ref={heading} tabIndex={-1}>模型连接</h1><p>管理小 D 使用的模型服务。</p></div><button className="icon-button" type="button" aria-label="关闭设置" onClick={onBack}><Icon name="x" /></button></div>
    <div className="settings-content">
      {loading ? <p role="status">正在读取配置…</p> : !saved ? <div className="settings-load-error"><p role="alert">{error}</p><button className="header-button" type="button" onClick={() => void load()}>重新读取</button></div> : <>
        <div className="settings-status"><Icon name="plug" /><div><strong>{saved.restartRequired ? "已保存，等待重启" : saved.activeModel ? "当前连接" : "请配置模型"}</strong><p>{saved.activeModel || "填写下面的连接信息"}{saved.restartRequired ? " · 新配置将在服务重启后使用" : " · 保存修改后需重启服务"}</p></div></div>
        <form className="settings-form" onSubmit={event => void save(event)} aria-busy={pending}>
          <fieldset disabled={pending}>
            <label htmlFor="model-provider">Provider<span>选择服务商使用的接口协议</span></label>
            <select id="model-provider" value={provider} onChange={event => { setProvider(event.target.value as ModelProvider); setFeedback(""); }}>{providers.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
            <p className="settings-field-hint">{providers.find(item => item.value === provider)?.hint}</p>
            <label htmlFor="model-base-url">Base URL</label>
            <input id="model-base-url" type="url" required maxLength={2048} value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setFeedback(""); }} placeholder="https://your-provider.example/v1" autoComplete="off" spellCheck={false} aria-describedby="base-url-hint" />
            <p id="base-url-hint" className="settings-field-hint">填写服务商提供的基础地址，不是完整的请求路径。</p>
            <label htmlFor="model-id">模型 ID</label>
            <input id="model-id" required maxLength={200} value={model} onChange={event => { setModel(event.target.value); setFeedback(""); }} placeholder="填写服务商提供的模型 ID" autoComplete="off" spellCheck={false} />
            <label className="settings-key-label" htmlFor="model-api-key">API Key{saved.hasKey && !needsKey && <span className="settings-key-state"><Icon name="shield-check" />已配置</span>}</label>
            <input id="model-api-key" type="password" required={needsKey} maxLength={8192} value={apiKey} onChange={event => { setApiKey(event.target.value); setFeedback(""); }} placeholder={needsKey ? "填写此连接的 API Key" : "留空保留已配置的 Key"} autoComplete="new-password" spellCheck={false} aria-describedby="api-key-hint" />
            <p id="api-key-hint" className="settings-field-hint">Key 仅保存在服务端，不回显。更换地址或协议时需重新填写。</p>
          </fieldset>
          {error && <p className="settings-error" role="alert">{error}</p>}
          <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p>
          <div className="settings-actions"><span>保存后重启服务生效</span><button className="settings-save" type="submit" disabled={pending}>{pending ? <Icon name="loader-circle" /> : <Icon name="check" />}{pending ? "正在保存…" : "保存配置"}</button></div>
        </form>
      </>}
      <WechatSettings />
      <MailSettings />
      <NotificationSettings />
    </div>
  </section>;
}
