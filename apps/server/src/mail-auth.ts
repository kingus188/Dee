import type { MailSettingsInput } from "@assistant/contracts";
import type { MailStore } from "./mail-store.js";
import type { MailAccount } from "./mail-account.js";
import { HttpError } from "./errors.js";

const SCOPE = "https://graph.microsoft.com/Mail.Read offline_access";
type DeviceLogin = { deviceCode: string; userCode: string; verificationUri: string; expiresAt: number; interval: number; nextPoll: number };
export function createMailAuth(store: MailStore, fetchImpl: typeof fetch = fetch) {
  let login: DeviceLogin | null = null;
  const endpoint = (settings: MailSettingsInput, path: string) => `https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/${path}`;
  async function post(path: string, form: Record<string, string>, signal: AbortSignal) {
    let response: Response;
    try { response = await fetchImpl(endpoint(store.state().settings, path), { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: store.state().settings.clientId, ...form }) }); }
    catch { throw new HttpError(502, "无法连接微软登录服务，请稍后重试"); }
    let data: Record<string, unknown>;
    try { data = await response.json() as Record<string, unknown>; } catch { throw new HttpError(502, "微软登录服务返回格式无效"); }
    return { response, data };
  }
  function accept(data: Record<string, unknown>) {
    if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || data.expires_in <= 0) throw new HttpError(502, "微软登录服务未返回有效令牌");
    const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : store.state().tokens?.refreshToken;
    if (!refreshToken) throw new HttpError(409, "未获离线访问权限，请重新登录并允许 offline_access");
    store.update({ tokens: { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000 - 60000 } });
  }
  function fail(data: Record<string, unknown>): never {
    const code = String(data.error);
    if (["authorization_declined", "access_denied"].includes(code)) throw new HttpError(403, "微软授权被拒绝，请检查 Mail.Read 权限和租户策略");
    if (code === "interaction_required" || (Array.isArray(data.error_codes) && data.error_codes.some(n => [50076, 50079, 50158, 53003].includes(Number(n))))) throw new HttpError(409, "公司要求 MFA 或条件访问验证，请使用微软交互登录");
    if (["expired_token", "invalid_grant"].includes(code)) throw new HttpError(409, "微软登录已失效，请重新登录；核对账号配置或使用交互登录");
    if (["invalid_client", "unauthorized_client", "invalid_scope"].includes(code)) throw new HttpError(400, "请检查 Tenant ID、Client ID、公共客户端及 Mail.Read 委托权限配置");
    throw new HttpError(502, "微软授权暂不可用，请检查租户策略后重试");
  }
  return {
    status: () => {
      if (login && login.expiresAt <= Date.now()) login = null;
      return login ? { userCode: login.userCode, verificationUri: login.verificationUri, expiresAt: login.expiresAt } : null;
    },
    cancel: () => { login = null; },
    async begin(signal: AbortSignal) {
      const { response, data } = await post("devicecode", { scope: SCOPE }, signal);
      if (signal.aborted) throw new HttpError(409, "邮件登录已取消");
      if (!response.ok) fail(data);
      if (typeof data.device_code !== "string" || typeof data.user_code !== "string" || typeof data.expires_in !== "number" || data.expires_in <= 0 || typeof data.verification_uri !== "string") throw new HttpError(502, "微软设备登录响应无效");
      const uri = new URL(data.verification_uri);
      if (uri.protocol !== "https:" || !["microsoft.com", "www.microsoft.com", "login.microsoft.com", "login.microsoftonline.com"].includes(uri.hostname) || uri.username || uri.password || uri.port) throw new HttpError(502, "微软授权地址不受支持");
      const interval = Math.max(5, typeof data.interval === "number" ? data.interval : 5) * 1000;
      login = { deviceCode: data.device_code, userCode: data.user_code, verificationUri: uri.href, expiresAt: Date.now() + data.expires_in * 1000, interval, nextPoll: Date.now() + interval };
    },
    async poll(signal: AbortSignal) {
      const current = login;
      if (!current) return false;
      if (current.expiresAt <= Date.now()) { login = null; throw new HttpError(409, "登录代码已过期，请重新登录"); }
      if (current.nextPoll > Date.now()) return false;
      current.nextPoll = Date.now() + current.interval;
      const { response, data } = await post("token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: current.deviceCode }, signal);
      if (signal.aborted || login !== current) return false;
      if (data.error === "authorization_pending") return false;
      if (data.error === "slow_down") { current.interval += 5000; current.nextPoll = Date.now() + current.interval; return false; }
      if (!response.ok) { login = null; fail(data); }
      accept(data); login = null; return true;
    },
    async password(account: MailAccount, signal: AbortSignal) {
      const { response, data } = await post("token", { grant_type: "password", username: account.username, password: account.password, scope: SCOPE }, signal);
      if (signal.aborted) throw new HttpError(409, "邮件登录已取消");
      if (!response.ok) fail(data);
      accept(data);
    },
    async token(signal: AbortSignal) {
      const tokens = store.state().tokens;
      if (!tokens) throw new HttpError(409, "请先在设置中登录 Outlook");
      if (tokens.expiresAt > Date.now()) return tokens.accessToken;
      const { response, data } = await post("token", { grant_type: "refresh_token", refresh_token: tokens.refreshToken, scope: SCOPE }, signal);
      if (signal.aborted) throw new HttpError(409, "邮件操作已取消");
      if (!response.ok) {
        if (["invalid_grant", "interaction_required"].includes(String(data.error))) store.update({ tokens: null, accountLoginBlocked: store.state().settings.authMode === "account" });
        fail(data);
      }
      accept(data); return store.state().tokens!.accessToken;
    },
  };
}
