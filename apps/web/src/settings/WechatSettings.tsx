import { useEffect, useRef, useState } from "react";
import type { WechatSettings as Settings, WechatSettingsInput } from "@assistant/contracts";
import { request } from "../api/request.js";
import { Icon } from "../ui/Icon.js";

const DEFAULT_SEND_URL = "http://127.0.0.1:18790/v1/send";

export function WechatSettings() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false), [sendUrl, setSendUrl] = useState(DEFAULT_SEND_URL);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const sending = useRef(false);
  function apply(data: Settings) { setSaved(data); setEnabled(data.enabled); setSendUrl(data.sendUrl || DEFAULT_SEND_URL); }
  useEffect(() => {
    let live = true;
    request<Settings>("/api/settings/wechat").then(data => { if (live) apply(data); }).catch(() => { if (live) setError("暂时无法读取微信配置，请稍后重试。"); });
    return () => { live = false; };
  }, []);
  async function save(regenerate = false) {
    if (sending.current) return;
    sending.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const input: WechatSettingsInput = { enabled, sendUrl: sendUrl.trim(), ...(regenerate ? { regenerate } : {}) };
      const data = await request<Settings>("/api/settings/wechat", input);
      apply(data); setFeedback(data.restartRequired ? "已保存，重启应用后生效。" : "已保存，配置与当前运行一致。");
    } catch (error) { setError(error instanceof Error ? error.message : "保存未能确认，请重新读取配置后核对。"); }
    finally { sending.current = false; setPending(false); }
  }
  const webhook = `${globalThis.location?.origin ?? ""}/channels/wechat/incoming`;
  return <section className="settings-form" aria-labelledby="wechat-title">
    <h2 id="wechat-title">微信 Bot</h2>
    {!saved ? <p role={error ? "alert" : "status"}>{error || "正在读取微信配置…"}</p> : <form onSubmit={event => { event.preventDefault(); void save(); }} aria-busy={pending}>
      <fieldset disabled={pending}>
        <label htmlFor="wechat-enabled"><input id="wechat-enabled" type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setFeedback(""); }} /> 启用微信通道</label>
        <p className="settings-field-hint">微信扫码、收发由独立的 wx-bot 进程完成（见 docs/WECHAT.md），这里只配置小 D 这一侧。</p>
        <label htmlFor="wechat-send-url">wx-bot 发送地址</label>
        <input id="wechat-send-url" type="url" required maxLength={2048} value={sendUrl} onChange={event => { setSendUrl(event.target.value); setFeedback(""); }} autoComplete="off" spellCheck={false} />
        {([["Webhook 地址（填入 wx-bot binding.webhook.url）", webhook], ["WECHAT_WEBHOOK_KEY", saved.webhookKey], ["WECHAT_SEND_TOKEN", saved.sendToken]] as const).map(([label, value]) => <div key={label}>
          <label>{label}</label>
          <input readOnly value={value || "保存后自动生成"} onFocus={event => event.target.select()} spellCheck={false} />
        </div>)}
        <p className="settings-field-hint">Webhook 端口在桌面版每次启动都会变化，端口变化后需同步更新 wx-bot 配置。</p>
      </fieldset>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p>
      <div className="settings-actions"><button className="header-button" type="button" disabled={pending} onClick={() => void save(true)}>重新生成密钥</button>
        <button className="settings-save" type="submit" disabled={pending}>{pending ? <Icon name="loader-circle" /> : <Icon name="check" />}{pending ? "正在保存…" : "保存配置"}</button></div>
    </form>}
  </section>;
}
