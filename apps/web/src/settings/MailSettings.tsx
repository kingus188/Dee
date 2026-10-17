import { useEffect, useRef, useState } from "react";
import type { MailStatus } from "@assistant/contracts";
import { request } from "../api/request.js";

export function MailSettings() {
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [tenantId, setTenantId] = useState(""), [clientId, setClientId] = useState(""), [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const live = useRef(false), busy = useRef(false), draft = useRef(false);
  function apply(data: MailStatus, fields = false) {
    if (typeof data?.tenantId !== "string" || typeof data.clientId !== "string" || typeof data.enabled !== "boolean") throw new Error("Outlook 配置响应无效");
    setStatus(data);
    if (fields || !draft.current) { setTenantId(data.tenantId); setClientId(data.clientId); setEnabled(data.enabled); }
    if (fields) draft.current = false;
  }
  useEffect(() => {
    live.current = true;
    request<MailStatus>("/api/settings/mail").then(data => { if (live.current) apply(data, true); }).catch(() => { if (live.current) setError("暂时无法读取 Outlook 配置，请重新读取。"); });
    let polling = false;
    const timer = setInterval(() => {
      if (polling || busy.current) return;
      polling = true;
      void request<MailStatus>("/api/settings/mail").then(data => { if (live.current && !busy.current) apply(data); })
        .catch(() => { if (live.current) setError("Outlook 状态读取失败，请重新读取。"); }).finally(() => { polling = false; });
    }, 5000);
    return () => { live.current = false; clearInterval(timer); };
  }, []);
  async function action(path: string, body: object = {}, feedback = "") {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(""); setFeedback("");
    try {
      const data = await request<MailStatus>(path, body);
      if (live.current) { apply(data, true); setFeedback(feedback); }
    } catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : "操作未能确认，请重新读取后核对。"); }
    finally { busy.current = false; if (live.current) setPending(false); }
  }
  const dirty = !!status && (tenantId.trim() !== status.tenantId || clientId.trim() !== status.clientId || enabled !== status.enabled);
  return <section className="settings-form" aria-labelledby="mail-title">
    <h2 id="mail-title">Outlook 邮件</h2>
    <p className="settings-field-hint">公司 Microsoft 365 收件箱，只读同步。首次获取近 30 天，之后约每分钟监听，最多保留 90 天；不发送邮件、不改已读状态、不下载附件。</p>
    {!status ? <><p role={error ? "alert" : "status"}>{error || "正在读取 Outlook 配置…"}</p><button type="button" className="header-button" onClick={() => { void request<MailStatus>("/api/settings/mail").then(data => { if (live.current) { apply(data, true); setError(""); } }).catch(() => { if (live.current) setError("读取失败，请稍后重试。"); }); }}>重新读取</button></> : <>
      {status.savedAccountAvailable && <div className="settings-status"><p>已找到本机账号配置。首次接入会自动连接；暂停或断开后不会自动恢复。密码仅从原文件读取，不在网页中展示或另存。</p>
        <button type="button" className="header-button" disabled={pending || dirty || status.offline || !!status.login} onClick={() => void action("/api/mail/login-account", {}, "已使用现有账号连接，后台将自动同步收件箱。")}>{status.authMode === "account" && status.connected ? "使用现有账号重新连接" : "使用现有账号连接"}</button>
      </div>}
      <form onSubmit={event => { event.preventDefault(); void action("/api/settings/mail", { enabled, tenantId: tenantId.trim(), clientId: clientId.trim() }, "配置已保存，无需重启。"); }} aria-busy={pending}>
        <fieldset disabled={pending}>
          <label htmlFor="mail-enabled"><input id="mail-enabled" type="checkbox" checked={enabled} onChange={event => { draft.current = true; setEnabled(event.target.checked); }} /> 启用邮件监听</label>
          <label htmlFor="mail-tenant">Tenant ID（租户 ID）</label>
          <input id="mail-tenant" required maxLength={36} value={tenantId} onChange={event => { draft.current = true; setTenantId(event.target.value); }} autoComplete="off" spellCheck={false} />
          <label htmlFor="mail-client">Client ID（应用 ID）</label>
          <input id="mail-client" required maxLength={36} value={clientId} onChange={event => { draft.current = true; setClientId(event.target.value); }} autoComplete="off" spellCheck={false} />
          <p className="settings-field-hint">Entra 应用需启用公共客户端流，配置 Microsoft Graph 委托权限 Mail.Read；公司可能要求管理员同意。手动登录无需客户端密钥或邮箱密码，支持 MFA，但仍受公司设备代码登录策略限制。现有账号方式只适用于公司允许的密码授权，要求 MFA 时请改用下方交互登录。</p>
          <p className="settings-field-hint">令牌和邮件保存在当前实例的 SQLite，备份需按凭据保管。用小 D 查询时，相关邮件会进入所配置模型的上下文。</p>
        </fieldset>
        <div className="settings-actions"><span>修改应用或重新登录会清空旧账号的邮件缓存。</span><button type="submit" className="settings-save" disabled={pending}>保存邮件配置</button></div>
      </form>
      <div className="settings-status"><div><strong>{status.offline ? "离线模式，邮件连接已禁用" : status.connected ? status.enabled ? "已登录，监听已启用" : "已登录，监听已暂停" : "尚未登录"}</strong>
        <p>登录方式：{status.authMode === "account" ? "现有账号配置（密码授权 + 令牌续期）" : "微软交互授权"}</p>
        <p>{status.syncing ? "正在同步…" : status.lastSuccessAt ? `最后同步：${new Date(status.lastSuccessAt).toLocaleString("zh-CN")}` : "尚未完成首次同步"}</p>
        {status.enabled && status.connected && !status.initialComplete && <p>首次同步期间不提醒历史邮件。</p>}
        {status.error && <p role="alert">{status.error}</p>}
      </div></div>
      {status.login && <div role="status"><p>在微软页面输入代码：<strong>{status.login.userCode}</strong>（有效至 {new Date(status.login.expiresAt).toLocaleTimeString("zh-CN")}）</p>
        <p><a href={status.login.verificationUri} target="_blank" rel="noopener noreferrer">打开微软登录页面</a>，完成登录后会自动开始同步。</p></div>}
      <div className="settings-actions">
        <button type="button" className="header-button" disabled={pending || dirty || !status.enabled || status.offline || !!status.login} onClick={() => void action("/api/mail/login", {}, "请打开微软登录页面，输入代码完成授权。")}>{status.connected ? "重新登录 / 切换账号" : "登录微软邮箱"}</button>
        <button type="button" className="header-button" disabled={pending || dirty || !status.connected || !status.enabled || status.offline} onClick={() => void action("/api/mail/refresh", {}, "同步请求已结束，请核对同步状态。")}>立即同步</button>
        <button type="button" className="header-button" disabled={pending} onClick={() => void action("/api/mail/disconnect", {}, "已断开，当前实例的邮件缓存和令牌已清除。")}>断开并清除缓存</button>
      </div>
      {dirty && <p className="settings-field-hint">请先保存修改后的配置，再登录或同步。</p>}
      {error && <p className="settings-error" role="alert">{error}</p>}
      <p className="settings-feedback" role="status">{feedback}</p>
    </>}
  </section>;
}
