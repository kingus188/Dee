import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
export type ModelConfig = { api: string; baseUrl: string; model: string; apiKey: string; contextWindow: number; maxTokens: number };
const API_LOADERS = {
	"openai-completions": async () => (await import("@earendil-works/pi-ai/api/openai-completions.lazy")).openAICompletionsApi(),
	"openai-responses": async () => (await import("@earendil-works/pi-ai/api/openai-responses.lazy")).openAIResponsesApi(),
	"anthropic-messages": async () => (await import("@earendil-works/pi-ai/api/anthropic-messages.lazy")).anthropicMessagesApi(),
};

export async function createModelCatalog(config: ModelConfig, fauxResponse?: FauxResponseStep) {
	const models = createModels({ authContext: { env: async (name) => name === "LLM_API_KEY" ? config.apiKey : undefined, fileExists: async () => false } });
	if (config.api === "faux") {
		const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
		const faux = fauxProvider();
		if (!fauxResponse) throw new Error("faux 模型需要提供测试剧本");
		faux.setResponses(Array(1000).fill(fauxResponse));
		models.setProvider(faux.provider);
		return { models, agentModel: { provider: "faux", modelId: "faux-1" }, label: "faux（自动化测试）", configured: true };
	}
	const loadApi = Object.hasOwn(API_LOADERS, config.api) ? API_LOADERS[config.api as keyof typeof API_LOADERS] : undefined;
	if (!loadApi) throw new Error(`不支持的 LLM_API：${config.api}`);
	if (!config.baseUrl || !config.model || !config.apiKey) return { models, agentModel: { provider: "demo", modelId: "unconfigured" }, label: "未配置模型", configured: false };
	const model: Model<"openai-completions" | "openai-responses" | "anthropic-messages"> = {
		id: config.model,
		name: config.model,
		api: config.api as "openai-completions" | "openai-responses" | "anthropic-messages",
		provider: "demo",
		baseUrl: config.baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
		// 走未知中转，保守关闭可能不支持的字段
		...(config.api === "openai-completions" ? { compat: { supportsStore: false, supportsDeveloperRole: false } } : {}),
	};
	const provider = createProvider({
		id: "demo",
		name: "Demo",
		baseUrl: config.baseUrl,
		auth: { apiKey: envApiKeyAuth("Demo API key", ["LLM_API_KEY"]) },
		models: [model],
		api: await loadApi(),
	});
	models.setProvider(provider);
	return { models, agentModel: { provider: "demo", modelId: config.model }, label: config.model, configured: true };
}
