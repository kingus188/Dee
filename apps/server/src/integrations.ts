import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { TeamsStore } from "./teams-store.js";
import type { TeamsSender } from "./teams-reply-port.js";
import { createGinaTokenProvider } from "./teams-gina.js";
import { createTeamsTokenProvider, SEND_SCOPE, type TeamsAccount } from "./teams-auth.js";
import { sendTeamsMessage } from "./teams-send.js";
import { createTeamsSync } from "./teams-sync.js";
import { startTeamsForward } from "./teams-forward.js";
import type { ImportantRules } from "./teams-rules.js";

type ForwardConfig = { account?: TeamsAccount; ginaHome?: string; important?: ImportantRules };

type WechatIntegration = {
  enabled: boolean;
  sendURL: string;
  sendToken: string;
  notify?: (wxid: string, text: string, messageId: string) => Promise<void>;
  undelivered?: () => Promise<{ text: string; status?: "pending" | "blocked" }[]>;
};

export type ServerIntegrationsOptions = {
  config: AppConfig;
  store: TeamsStore;
  teamsSender: TeamsSender;
  wechat?: WechatIntegration;
  env?: NodeJS.ProcessEnv;
  onStuck?: (pending: number, reason: string, preview: string) => void;
};

/** Start configured Teams Graph synchronization after the HTTP server is listening. */
export function startServerIntegrations({ config, store, teamsSender, wechat, env = {}, onStuck }: ServerIntegrationsOptions) {
  if (config.offline || !config.teamsConfigDir) return async () => {};
  const configPath = join(config.teamsConfigDir, "teams-forward-config.json");
  if (!existsSync(configPath)) return async () => {};

  let parsed: ForwardConfig;
  try {
    const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("必须是 JSON 对象");
    parsed = value as ForwardConfig;
  } catch {
    throw new Error("Teams 配置无效：无法读取 teams-forward-config.json 中的 JSON 对象");
  }
  const account = parsed.account;
  const validAccount = account && [account.tenantId, account.clientId, account.username, account.password]
    .every(value => typeof value === "string" && value.trim().length > 0);
  if (account !== undefined && !validAccount) throw new Error("Teams 配置无效：account 需要 tenantId、clientId、username、password");
  if (parsed.ginaHome !== undefined && (typeof parsed.ginaHome !== "string" || !parsed.ginaHome.trim())) throw new Error("Teams 配置无效：ginaHome 必须是非空路径");
  if (!validAccount && !parsed.ginaHome) throw new Error("Teams 配置无效：teams-forward-config.json 需要 account 或 ginaHome");
  const rules = parsed.important;
  if (rules !== undefined && (!rules || typeof rules !== "object" || Array.isArray(rules)
    || (rules.dm !== undefined && typeof rules.dm !== "boolean") || (rules.mention !== undefined && typeof rules.mention !== "boolean")
    || (rules.senders !== undefined && (!Array.isArray(rules.senders) || rules.senders.some(value => typeof value !== "string")))
    || (rules.keywords !== undefined && (!Array.isArray(rules.keywords) || rules.keywords.some(value => typeof value !== "string"))))) {
    throw new Error("Teams 配置无效：important 需要 dm/mention 布尔值和 senders/keywords 字符串数组");
  }

  const dir = config.teamsConfigDir;
  const authAccount = validAccount ? account : undefined;
  const getToken = authAccount ? createTeamsTokenProvider(authAccount) : createGinaTokenProvider(parsed.ginaHome!, env);
  const sendToken = authAccount ? createTeamsTokenProvider(authAccount, SEND_SCOPE) : getToken;
  const controller = new AbortController();
  const collector = createTeamsSync({ dir, store, getToken, rules: parsed.important, signal: controller.signal });
  let active = true;
  const pending = new Set<Promise<unknown>>();
  function track<T>(operation: Promise<T>) {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }
  const sync = {
    refresh: () => active ? track(collector.refresh()) : Promise.resolve({ ok: false, lastSuccessAt: collector.status().lastSuccessAt }),
    status: collector.status,
  };
  teamsSender.send = async (chatId, text) => {
    if (!active) throw new Error("Teams 集成已停止");
    await track(sendTeamsMessage(sendToken, chatId, text, store, controller.signal));
  };
  teamsSender.refresh = sync.refresh;
  teamsSender.syncStatus = sync.status;

  let stopForward: (() => Promise<void>) | undefined;
  try {
    if (wechat?.enabled) stopForward = startTeamsForward({
      dir, store, getToken, rules: parsed.important, sendURL: wechat.sendURL, sendToken: wechat.sendToken, sync, signal: controller.signal,
      inject: wechat.notify ? (wxid, text, messageId) => active ? wechat.notify!(wxid, text, messageId) : Promise.reject(new Error("Teams 集成已停止")) : undefined,
      undelivered: wechat.undelivered ? () => active ? wechat.undelivered!() : Promise.resolve([]) : undefined,
      onStuck: (...args) => { if (active) onStuck?.(...args); },
    });
  } catch (error) {
    active = false;
    controller.abort();
    delete teamsSender.send; delete teamsSender.refresh; delete teamsSender.syncStatus;
    throw error;
  }

  let timer: NodeJS.Timeout | undefined;
  const poll = async () => {
    try { await sync.refresh(); } catch (error) { if (active) console.error("Teams 同步失败：", error instanceof Error ? error.message : String(error)); }
    if (active) timer = setTimeout(() => { void poll(); }, 45_000);
  };
  if (!stopForward) void poll();

  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    active = false;
    controller.abort();
    clearTimeout(timer);
    delete teamsSender.send; delete teamsSender.refresh; delete teamsSender.syncStatus;
    const forwarding = stopForward?.();
    return closing = Promise.allSettled([...pending, forwarding]).then(() => {});
  };
}
