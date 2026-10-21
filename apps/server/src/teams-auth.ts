export type TeamsAccount = { tenantId: string; clientId: string; username: string; password: string };

const READ_SCOPE = "https://graph.microsoft.com/Chat.Read offline_access";
// 发送使用单独的令牌：租户没有授权 ChatMessage.Send 时只影响发送，不影响读取转发。
export const SEND_SCOPE = "https://graph.microsoft.com/ChatMessage.Send offline_access";
type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

// 账号密码（ROPC）登录，之后用 refresh token 续期；token 只在内存。MFA / 条件访问 / 租户禁用 ROPC 时会失败。
export function createTeamsTokenProvider(account: TeamsAccount, scope = READ_SCOPE) {
  let access = "";
  let refresh = "";
  let expiresAt = 0;

  async function request(form: Record<string, string>) {
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(account.tenantId)}/oauth2/v2.0/token`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: account.clientId, scope, ...form }),
    });
    const data = await response.json() as TokenResponse;
    // 错误信息只用服务端的 error 码，不回显请求内容，避免带出密码。
    if (!response.ok || !data.access_token) throw new Error(`Teams 登录失败：${data.error ?? response.status}`);
    access = data.access_token;
    refresh = data.refresh_token ?? "";
    expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 120_000;
  }

  return async function getToken() {
    if (access && Date.now() < expiresAt) return access;
    if (refresh) {
      try { await request({ grant_type: "refresh_token", refresh_token: refresh }); return access; } catch { refresh = ""; }
    }
    await request({ grant_type: "password", username: account.username, password: account.password });
    return access;
  };
}
