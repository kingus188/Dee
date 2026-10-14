import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import { splitUserContent } from "@assistant/features";
import type { AppContext } from "./application/context.js";
import type { TeamsStore } from "./teams-store.js";

const MAX_BATCH_CHARS = 12_000;
const LINE_MAX = 1500;
const FIRST_RUN_DAYS = 14;
const TEAMS_SCAN = 500;

// 一个来源（一个会话或一个 Teams 聊天）自上次整理以来的新内容。
export type Batch = { source: string; label: string; channel: string; text: string; chars: number; periodStart: string; periodEnd: string; cursor: string };
export type Collect = (cursorOf: (source: string) => string | undefined) => Promise<Batch[]>;

const textOf = (content: unknown, role: "user" | "assistant") => {
  if (role === "user") return splitUserContent(content as never).text;
  return Array.isArray(content) ? content.filter((part): part is { type: "text"; text: string } => part?.type === "text").map(part => part.text).join("") : "";
};

export async function conversationBatches({ harness, ctx }: Pick<AppContext, "harness" | "ctx">, cursorOf: (source: string) => string | undefined): Promise<Batch[]> {
  const batches: Batch[] = [];
  for (const item of (await harness.snapshot(Index, ctx))?.items ?? []) {
    if (item.archivedAt) continue;
    const conversation = await harness.conversation(item.id as ConversationId, ctx);
    if (!conversation) continue;
    const source = `conv:${item.id}`;
    const after = cursorOf(source);
    const page = await conversation.entries({ order: "ascending", ...(after ? { minEntryId: (Number(after) + 1) as EntryId } : {}) }, 200, undefined, ctx);
    const lines: string[] = [];
    let chars = 0, last: string | undefined, first: number | undefined, end: number | undefined;
    for (const entry of page.items) {
      const message = entry.model?.[0];
      const role = entry.kind === "pi.user" ? "user" : entry.kind === "pi.assistant" ? "assistant" : undefined;
      if (role && message) {
        const text = textOf(message.content, role).replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
        if (text) {
          if (chars && chars + text.length > MAX_BATCH_CHARS) break;
          lines.push(`${role === "user" ? "用户" : "助手"}：${text}`);
          chars += text.length;
          first ??= message.timestamp;
          end = message.timestamp;
        }
      }
      last = String(entry.id);
    }
    if (lines.length && last && first !== undefined && end !== undefined) {
      batches.push({ source, label: item.title, channel: item.channel ?? "web", text: lines.join("\n"), chars, periodStart: new Date(first).toISOString(), periodEnd: new Date(end).toISOString(), cursor: last });
    }
  }
  return batches;
}

export function teamsBatches(store: TeamsStore, cursorOf: (source: string) => string | undefined): Batch[] {
  const sources = new Map<string, ReturnType<TeamsStore["messagesSince"]>>();
  // 各聊天进度不同：以最早的进度取数，再按聊天过滤；没有进度的聊天只回看近两周。
  const floor = new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000).toISOString();
  for (const message of store.messagesSince(floor, TEAMS_SCAN)) {
    const source = `teams:${message.chatId}`;
    if (message.createdAt > (cursorOf(source) ?? floor)) sources.set(source, [...(sources.get(source) ?? []), message]);
  }
  return [...sources].map(([source, messages]) => {
    const lines: string[] = [];
    let chars = 0;
    for (const message of messages) {
      const text = message.text.slice(0, LINE_MAX);
      if (chars && chars + text.length > MAX_BATCH_CHARS) break;
      lines.push(`${message.direction === "out" ? "我" : message.senderName}：${text || "[非文本消息]"}`);
      chars += text.length;
    }
    const used = messages.slice(0, lines.length);
    const first = messages[0];
    const label = first.chatType === "oneOnOne" ? `Teams 私聊「${messages.find(m => m.direction === "in")?.senderName ?? first.senderName}」` : `Teams 群聊${first.chatTopic ? `「${first.chatTopic}」` : ""}`;
    return { source, label, channel: "teams", text: lines.join("\n"), chars, periodStart: first.createdAt, periodEnd: used.at(-1)!.createdAt, cursor: used.at(-1)!.createdAt };
  });
}
