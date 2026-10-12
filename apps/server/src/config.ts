export function readConfig(env: NodeJS.ProcessEnv) {
  return {
    port: Number(env.PORT || 3000), dataDir: env.DATA_DIR || "./data", password: env.DEMO_PASSWORD || "",
    production: env.NODE_ENV === "production", enableCrashDemo: env.ENABLE_CRASH_DEMO === "1",
    model: { api: env.LLM_API || "openai-completions", baseUrl: env.LLM_BASE_URL || "", model: env.LLM_MODEL || "",
      apiKey: env.LLM_API_KEY || "", contextWindow: Number(env.LLM_CONTEXT_WINDOW || 128000), maxTokens: Number(env.LLM_MAX_TOKENS || 8192) },
    knowledge: { OBSIDIAN_ROOT: env.OBSIDIAN_ROOT || "", OBSIDIAN_ALLOW: env.OBSIDIAN_ALLOW || "" },
    notifications: { url: env.NOTIFY_WEBHOOK_URL || "", mode: env.NOTIFY_MODE || "errors", kind: env.NOTIFY_WEBHOOK_KIND || "generic" },
    wechat: { enabled: env.WECHAT_ENABLED === "1", webhookKey: env.WECHAT_WEBHOOK_KEY || "", sendToken: env.WECHAT_SEND_TOKEN || "",
      sendURL: env.WECHAT_SEND_URL || "http://127.0.0.1:18790/v1/send" },
  };
}
export type AppConfig = ReturnType<typeof readConfig>;
