import { useState } from "react";

export function validateServerUrl(value: string): string {
  const input = value.trim();
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("请输入完整的后台服务器根地址，例如 https://assistant.example。"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("远程服务器请使用 HTTPS，本机服务器可使用 HTTP。");
  if (!/^https?:\/\/[^/?#\\@\s]+\/?$/i.test(input) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("服务器地址只填写根地址，请移除账号口令、路径、查询参数和片段。");
  }
  return url.origin;
}

type ServerConnectionProps = { onConnect?: (target: string) => void };
declare global { interface Window { desktopServer?: { connect(url: string): Promise<{ ok: boolean; error?: string }> } } }

export function ServerConnection({ onConnect }: ServerConnectionProps = {}) {
  const [address, setAddress] = useState(() => window.location.origin);
  const [error, setError] = useState(""), [feedback, setFeedback] = useState("");
  const [connecting, setConnecting] = useState(false);
  async function connect() {
    if (connecting) return;
    setError(""); setFeedback("");
    try {
      const origin = validateServerUrl(address);
      setAddress(origin);
      if (origin === window.location.origin) { setFeedback("当前已连接此后台服务器。"); return; }
      const target = origin + "/#settings";
      if (onConnect) onConnect(target);
      else if (window.desktopServer) {
        setConnecting(true);
        const result = await window.desktopServer.connect(origin);
        if (!result.ok) throw new Error(result.error || "保存后台地址失败，请重试。");
        setFeedback("正在连接新的后台服务器…");
      } else window.location.assign(target);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "连接地址无效，请检查后重试。"); }
    finally { setConnecting(false); }
  }
  return <section className="settings-form" aria-labelledby="server-connection-title">
    <h2 id="server-connection-title">服务器连接</h2>
    <p className="settings-field-hint">填写后台服务器地址并连接。首次连接时，请按服务器提示登录。</p>
    <form onSubmit={event => { event.preventDefault(); connect(); }}>
      <label htmlFor="server-url">后台服务器地址</label>
      <input id="server-url" name="server-url" type="text" inputMode="url" required value={address} placeholder="http://127.0.0.1:3000" autoComplete="url" spellCheck={false}
        aria-describedby="server-url-hint" aria-invalid={error ? true : undefined} onChange={event => { setAddress(event.target.value); setError(""); setFeedback(""); }} />
      <p id="server-url-hint" className="settings-field-hint">使用 HTTPS 根地址，本机可使用 HTTP；地址不包含账号口令、路径、查询参数或片段。</p>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <p className="settings-feedback" role="status" aria-live="polite">{feedback}</p>
      <div className="settings-actions"><button className="settings-save" type="submit" disabled={connecting}>{connecting ? "正在连接…" : "连接服务器"}</button></div>
    </form>
  </section>;
}
