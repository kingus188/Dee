import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import { AgentDoc, configure } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import { AttachmentError, buildUserContent, imageAt, parseAttachments } from "@assistant/features";
import { HttpError } from "../errors.js";
import type { AppContext } from "./context.js";
import type { createConversations } from "./conversations.js";
export function createMessages({ harness, ctx, agentModel }: AppContext, { registerIn, updateTitle }: ReturnType<typeof createConversations>) {
 async function submit(conversation: Conversation, body: Record<string, unknown>) {
			const text = String(body.text ?? "").trim();
			let files;
			try {
				files = parseAttachments(body.attachments);
			} catch (error) {
				if (error instanceof AttachmentError) throw new HttpError(400, error.message);
				throw error;
			}
			if (!text && !files.length) throw new HttpError(400, "消息不能为空");
			if (text.length > 8000) throw new HttpError(413, "消息太长");
			const content = buildUserContent(text, files);
			const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId.slice(0, 100) : undefined;
			const submission = await conversation.submit(
				{ type: "input", content, requestId, whenBusy: body.mode === "steer" ? "steer" : "followUp" },
				ctx,
			);
			await updateTitle(conversation.id, (text || `[附件] ${files[0].name}`).slice(0, 20));
			return { submissionId: submission.id };
 }
 async function fork(conversation: Conversation, body: Record<string, unknown>) {
			const entryId = Number(body.entryId) as EntryId;
			if (!Number.isInteger(entryId)) throw new HttpError(400, "缺少 entryId");
			const index = await harness.snapshot(Index, ctx);
			const parent = index?.items.find((i) => i.id === conversation.id);
			const fork = await conversation.fork(
				entryId,
				{
					ownership: { kind: "ownerless" },
					init: async (tx, id) => {
						await registerIn({ title: `分叉：${parent?.title ?? conversation.id}`, forkOf: conversation.id, forkAtEntry: entryId })(tx, id);
						// Old transcript checkpoints can still refer to the previously configured model.
						if (agentModel.provider === "demo" && (await tx.doc(AgentDoc, id)).model?.provider === "demo") await configure(tx, id, { model: agentModel });
					},
				},
				ctx,
			);
			return { id: fork.id };
 }
 async function image(conversation: Conversation, entryId: EntryId, index: number) {
   const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, ctx);
   const entry = page.items.find(e => e.id === entryId);
   const part = entry?.kind === "pi.user" ? imageAt(entry.model?.[0]?.content, index) : undefined;
   if (!part) throw new HttpError(404, "图片不存在");
   return part;
 }
 return { submit, fork, image };
}
