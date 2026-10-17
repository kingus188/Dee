import type { MailStatus } from "@assistant/contracts";
import { HttpError } from "./errors.js";
import { openMailStore } from "./mail-store.js";
import { createMailAuth } from "./mail-auth.js";
import { mailAccountSource } from "./mail-account.js";
import { syncMail, MailRetryError } from "./mail-sync.js";

export function createMailService(dir: string, offline: boolean, fetchImpl: typeof fetch = fetch, accountFile = "") {
  const store = openMailStore(dir), auth = createMailAuth(store, fetchImpl), source = mailAccountSource(accountFile);
  let controller = new AbortController(), running: Promise<void> | undefined;
  let changing = false, closed = false, error = "", nextSync = 0, retryUntil = 0, passwordRetryAt = 0;
  let accountChecked = false, accountReady = false;
  let mutation: Promise<MailStatus> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  function status(): MailStatus {
    const state = store.state();
    return { ...state.settings, authMode: state.settings.authMode ?? "device", savedAccountAvailable: source.available(),
      connected: !!state.tokens, offline, lastSuccessAt: state.lastSuccessAt,
      initialComplete: state.initialComplete, error, syncing: !!running, login: auth.status() };
  }
  function perform(job: () => Promise<void>) {
    const current = job().catch(reason => {
      if (!controller.signal.aborted) error = reason instanceof HttpError ? reason.message : "Outlook 本地处理失败，请重试";
      throw reason instanceof HttpError ? reason : new HttpError(500, "Outlook 本地处理失败");
    }).finally(() => { if (running === current) running = undefined; });
    running = current;
    return current;
  }
  async function prepareAccount(explicit = false) {
    accountChecked = true; accountReady = false;
    const { account, key } = await source.read();
    if (controller.signal.aborted) throw new HttpError(409, "邮件登录已取消");
    const previous = store.state();
    const changed = previous.accountKey !== key || previous.settings.tenantId !== account.tenantId || previous.settings.clientId !== account.clientId;
    if (explicit || !store.configured() || changed) {
      store.reset({ enabled: explicit || !store.configured() || previous.settings.enabled, tenantId: account.tenantId, clientId: account.clientId, authMode: "account" }, null, key);
    }
    accountReady = true;
    if (store.state().tokens) return;
    if (!explicit && store.state().accountLoginBlocked) throw new HttpError(409, "已有账号登录已停止，请核对配置后手动重连，或使用微软交互登录");
    passwordRetryAt = Date.now() + 60000;
    try { await auth.password(account, controller.signal); }
    catch (reason) {
      // 密码失败不每分钟重试，重启也不重试，避免错误密码触发账号锁定。
      if (!controller.signal.aborted) store.update({ accountLoginBlocked: true });
      throw reason;
    }
  }
  async function refresh() {
    if (closed || changing || offline) return;
    if (running) return running;
    const state = store.state();
    const bootstrap = !store.configured() && source.available() && !accountChecked;
    if (!state.settings.enabled && !bootstrap) return;
    const checkAccount = !accountChecked && (bootstrap || state.settings.authMode === "account");
    if (!checkAccount && (!state.tokens || (state.settings.authMode === "account" && !accountReady))) return;
    if (Date.now() < retryUntil) throw new HttpError(429, "Outlook 正在等待重试，请稍后查询缓存");
    return perform(async () => {
      try {
        if (checkAccount) await prepareAccount();
        if (store.state().tokens) { await syncMail(store, auth.token, controller.signal, fetchImpl); error = ""; }
      } catch (reason) { if (reason instanceof MailRetryError) retryUntil = Date.now() + reason.retryMs; throw reason; }
      finally { nextSync = Date.now() + 60000; }
    });
  }
  function change(job: () => void | Promise<void>) {
    if (closed || changing) throw new HttpError(409, "邮件配置正在变更，请稍后重试");
    changing = true; controller.abort();
    mutation = (async () => {
      try {
        await running?.catch(() => {});
        if (closed) throw new HttpError(409, "邮件服务已关闭");
        controller = new AbortController(); auth.cancel();
        await job(); error = ""; nextSync = 0; retryUntil = 0;
        return status();
      } catch (reason) {
        if (!controller.signal.aborted) error = reason instanceof HttpError ? reason.message : "Outlook 本地处理失败，请重试";
        throw reason;
      } finally { changing = false; }
    })();
    return mutation;
  }
  async function tick() {
    if (closed || changing || running || offline) return;
    if (store.state().settings.enabled && auth.status()) {
      await perform(async () => { if (await auth.poll(controller.signal)) { error = ""; nextSync = 0; } });
    } else if (Date.now() >= Math.max(nextSync, retryUntil)) await refresh();
  }
  return {
    status, refresh, list: store.list, read: store.read, notices: store.notices,
    save(input: Record<string, unknown>) {
      if (typeof input.enabled !== "boolean" || typeof input.tenantId !== "string" || typeof input.clientId !== "string") throw new HttpError(400, "邮件配置格式无效");
      const settings = { enabled: input.enabled, tenantId: input.tenantId.trim(), clientId: input.clientId.trim() };
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuid.test(settings.tenantId) || !uuid.test(settings.clientId)) throw new HttpError(400, "Tenant ID 和 Client ID 必须是 Entra 应用中的 UUID");
      return change(() => {
        const previous = store.state().settings;
        if (previous.tenantId !== settings.tenantId || previous.clientId !== settings.clientId) store.reset({ ...settings, authMode: "device" }, null, null);
        else store.update({ settings: { ...previous, ...settings } });
        accountChecked = false; accountReady = false;
      });
    },
    login() {
      if (offline) throw new HttpError(409, "离线模式禁止连接 Outlook");
      const settings = store.state().settings;
      if (!settings.enabled || !settings.tenantId || !settings.clientId) throw new HttpError(409, "请先保存并启用 Outlook 配置");
      return change(async () => {
        store.reset({ ...settings, authMode: "device" }, null, null);
        await auth.begin(controller.signal);
      });
    },
    loginAccount() {
      if (offline) throw new HttpError(409, "离线模式禁止连接 Outlook");
      if (Date.now() < passwordRetryAt) throw new HttpError(429, "账号登录后请至少等待一分钟再重试");
      return change(() => prepareAccount(true));
    },
    disconnect: () => change(() => store.reset({ ...store.state().settings, enabled: false, authMode: "device" }, null, null)),
    start() {
      if (closed || timer || offline) return;
      timer = setInterval(() => { void tick().catch(() => {}); }, 1000);
      timer.unref();
      void tick().catch(() => {});
    },
    async close() {
      if (closed) return;
      closed = true; if (timer) clearInterval(timer); controller.abort(); auth.cancel();
      await running?.catch(() => {});
      await mutation?.catch(() => {});
      store.close();
    },
  };
}
export type MailService = ReturnType<typeof createMailService>;
