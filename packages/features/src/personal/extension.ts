import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { KnowledgeConfig } from "../knowledge/index.js";
import { readKnowledge, searchKnowledge } from "../knowledge/index.js";
import { detach, resultText } from "../results.js";
import { MemoryDoc, SkillsDoc, proposeMemoryInTx, memoryProvenanceInTx, proposeSkillInTx, selectMemoryForPrompt } from "./service.js";
function formatHit(hit: Awaited<ReturnType<typeof searchKnowledge>>["hits"][number]) {
	const range = hit.line === hit.endLine ? String(hit.line) : `${hit.line}-${hit.endLine}`;
	return [`- ${hit.path}:${range} [${hit.status}] ${hit.revision}`, hit.excerpt].join("\n");
}

export function createPersonal(knowledge: KnowledgeConfig) {
return defineExtension({
	name: "personal-memory",
	tools: [
		defineTool({
			name: "propose_memory",
			replay: "safe",
			description: "提交一条跨会话长期记忆候选。不会立即生效，必须等用户在对话卡片中批准。只提交稳定事实或偏好，不要提交整段聊天。",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (args, api, context) => {
				const item = await api.commit(async (tx) => proposeMemoryInTx(tx, {
                    provenance: await memoryProvenanceInTx(tx, api.conversationId),
					text: args.text,
					requestId: "tool:" + api.callId,
					conversationId: api.conversationId,
					source: "agent",
					approved: false,
				}), context);
				const state = item.status === "approved" ? "已在记忆中" : "已提交，等待用户批准，尚未生效";
				return resultText(`${state}：${item.text}`);
			},
		}),
		defineTool({
			name: "read_skill",
			replay: "safe",
			description: "按名称读取一条已批准技能的全文。未批准的技能不能当步骤使用。",
			parameters: Type.Object({ name: Type.String() }),
			execute: async (args, api, context) => {
				const name = String(args.name ?? "").trim();
				const items = await api.commit(async (tx) => detach((await tx.doc(SkillsDoc)).items), context);
				const item = items.find((entry) => entry.name === name && entry.status === "approved");
				if (!item) return resultText(`没有已批准的技能：${name}`);
				return resultText(`技能 ${item.name}\n${item.description}\n\n${item.body}`);
			},
		}),
		defineTool({
			name: "propose_skill",
			replay: "safe",
			description: "把一套可复用步骤提交为技能候选。批准前不要把它写成已经可用。",
			parameters: Type.Object({
				name: Type.String(),
				description: Type.String({ description: "什么情况下该读取这条技能" }),
				body: Type.String({ description: "步骤、约束和如何确认做完" }),
			}),
			execute: async (args, api, context) => {
				const item = await api.commit((tx) => proposeSkillInTx(tx, {
					...args,
					requestId: "tool:" + api.callId,
					conversationId: api.conversationId,
					source: "agent",
					approved: false,
				}), context);
				return resultText(`技能「${item.name}」${item.status === "approved" ? "已可用" : "已提交，等待批准"}`);
			},
		}),
		defineTool({
			name: "search_knowledge",
			replay: "safe",
			description: "在允许的 Obsidian 目录里检索笔记，返回路径、行号和修订标识。默认不把归档当现行。问以前的内容时把 includeHistorical 设为 true。",
			parameters: Type.Object({
				query: Type.String(),
				includeHistorical: Type.Optional(Type.Boolean()),
			}),
			execute: async (args) => {
				try {
					const found = await searchKnowledge(args.query, { includeHistorical: args.includeHistorical === true, env: knowledge });
					if (found.hits.length === 0) return resultText(`知识库里没有找到「${found.query}」。不要把没找到说成没有发生过。`);
					return resultText(["检索到这些来源，回答时请附上路径和行号：", ...found.hits.map(formatHit)].join("\n"));
				} catch (error) {
					return resultText(`无法检索知识库：${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
		defineTool({
			name: "read_knowledge",
			replay: "safe",
			description: "按相对路径阅读一篇允许范围内的笔记，从指定行开始。归档笔记的结论不能当作现行决定。",
			parameters: Type.Object({
				path: Type.String(),
				line: Type.Optional(Type.Number()),
			}),
			execute: async (args) => {
				try {
					const page = await readKnowledge(args.path, args.line ?? 1, knowledge);
					const warning = page.status === "archived" ? "这是归档或历史快照，不能当作现行决定。\n" : page.status === "draft" ? "这是草稿，不是已确认事实。\n" : "";
					return resultText(`${warning}${page.path}:${page.startLine}-${page.endLine} [${page.status}] ${page.revision}${page.truncated ? "（已截断）" : ""}\n${page.text}`);
				} catch (error) {
					return resultText(`无法阅读笔记：${error instanceof Error ? error.message : String(error)}`);
				}
			},
		}),
	],
	sections: [
		section("memory", async (input, renderContext) => {
			const doc = await input.read.snapshot(MemoryDoc, renderContext);
			const items = selectMemoryForPrompt(doc?.items);
			if (items.length === 0) return undefined;
			return ["已确认的长期记忆（未出现在这里的内容都还没批准；日期是记下的时间，可能已过时，与用户当前说法冲突时以当前为准）：", ...items.map((item) => `- ${item.text}（${new Date(item.createdAt).toISOString().slice(0, 10)}）`)].join("\n");
		}),
		section("skills", async (input, renderContext) => {
			const doc = await input.read.snapshot(SkillsDoc, renderContext);
			const items = (doc?.items ?? []).filter((item) => item.status === "approved");
			if (items.length === 0) return undefined;
			return ["已批准技能。先用 read_skill 读取全文，不要凭名称编造步骤：", ...items.map((item) => `- ${item.name}：${item.description}`)].join("\n");
		}),
	],
});

}
