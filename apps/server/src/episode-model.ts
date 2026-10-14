import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

// 不经会话直接调一次模型，只用于后台整理摘要。
export function createSummarizer(models: Models, ref: ModelRef) {
  return async (prompt: string) => {
    const model = models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error("摘要模型不可用");
    const reply = await models.completeSimple(model, { systemPrompt: "你是严谨的记忆整理助手，只按要求输出。", messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, { maxTokens: 1000 });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || "摘要模型调用失败");
    return reply.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join("");
  };
}
