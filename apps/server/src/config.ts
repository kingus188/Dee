export function readConfig(env: NodeJS.ProcessEnv) {
  const api = env.LLM_API || "openai-completions";
  if (api === "faux" && env.NODE_ENV !== "test") throw new Error("模拟体验已停用，请配置真实模型；faux 仅供自动化测试使用");
  return {
    port: Number(env.PORT || 3000), dataDir: env.DATA_DIR || "./data", password: env.DEMO_PASSWORD || "",
    production: env.NODE_ENV === "production",
    // PI_OFFLINE=1：无论数据库里怎么配，都强制关闭微信通道、Teams 发送和 Webhook 通知。测试和数据副本必须开启，避免连到真实账号。
    offline: env.PI_OFFLINE === "1",
    mailAccountFile: env.MAIL_ACCOUNT_FILE || "",
    model: { api, baseUrl: env.LLM_BASE_URL || "", model: env.LLM_MODEL || "",
      apiKey: env.LLM_API_KEY || "", contextWindow: Number(env.LLM_CONTEXT_WINDOW || 128000), maxTokens: Number(env.LLM_MAX_TOKENS || 8192) },
    materialsRoot: env.MATERIALS_ROOT || "",
    investigate: { repos: env.INVESTIGATE_REPOS || "", agent: (env.INVESTIGATE_AGENT === "claude" ? "claude" : "codex") as "codex" | "claude", codexBin: env.INVESTIGATE_CODEX_BIN || "codex-acp", claudeBin: env.INVESTIGATE_CLAUDE_BIN || "claude" },
    knowledge: { OBSIDIAN_ROOT: env.OBSIDIAN_ROOT || "", OBSIDIAN_ALLOW: env.OBSIDIAN_ALLOW || "" },
    notifications: { url: env.NOTIFY_WEBHOOK_URL || "", mode: env.NOTIFY_MODE || "errors", kind: env.NOTIFY_WEBHOOK_KIND || "generic" },
    wechat: { enabled: env.WECHAT_ENABLED === "1", webhookKey: env.WECHAT_WEBHOOK_KEY || "", sendToken: env.WECHAT_SEND_TOKEN || "",
      sendURL: env.WECHAT_SEND_URL || "http://127.0.0.1:18790/v1/send" },
  };
}
export type AppConfig = ReturnType<typeof readConfig>;
