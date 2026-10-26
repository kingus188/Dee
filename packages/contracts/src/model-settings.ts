export type ModelProvider = "openai-completions" | "openai-responses" | "anthropic-messages";
export type ModelSettingsInput = { modelId: string };
export type ModelSettings = {
  models: Array<{ id: string; name: string }>;
  selectedModel: string;
  activeModel: string;
  restartRequired: boolean;
};
