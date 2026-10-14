export type ModelProvider = "openai-completions" | "openai-responses" | "anthropic-messages";
export type ModelSettingsInput = { provider: ModelProvider; baseUrl: string; model: string; apiKey?: string };
export type ModelSettings = {
  provider: string; baseUrl: string; model: string; hasKey: boolean;
  restartRequired: boolean; activeModel: string;
};
