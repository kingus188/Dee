import type { DesktopAgentKind, DesktopAgentSnapshot, DesktopHandoff } from "@assistant/contracts";

// Character budget is intentionally conservative; never truncate the new user instruction.
export const HANDOFF_HISTORY_LIMIT = 48000;
export function prepareHandoff(messages: DesktopAgentSnapshot["messages"], source: DesktopAgentKind, target: DesktopAgentKind) {
  const selected: typeof messages = [];
  let length = 2;
  for (const message of [...messages].reverse()) {
    const size = JSON.stringify({ role: message.role, text: message.text }).length + (selected.length ? 1 : 0);
    if (length + size > HANDOFF_HISTORY_LIMIT) break;
    selected.unshift(message); length += size;
  }
  const handoff: DesktopHandoff = {
    source, target, createdAt: new Date().toISOString(), totalMessages: messages.length,
    includedMessages: selected.length, omittedMessages: messages.length - selected.length,
    ...(selected[0]?.id ? { firstMessageId: selected[0].id } : {}),
    ...(selected.at(-1)?.id ? { lastMessageId: selected.at(-1)!.id } : {}),
    omitted: ["attachments", "tool-state", "hidden-reasoning"], status: "pending",
  };
  return { context: JSON.stringify(selected.map(({ role, text }) => ({ role, text }))), handoff };
}
export function handoffPrompt(context: string, instruction: string) {
  // Older continuity records may predate the history budget. Re-budget rather than slicing JSON.
  let parsed: unknown;
  try { parsed = JSON.parse(context); }
  catch { throw new Error("历史交接记录无法解析，原记录已保留；请新建会话或修复记录后继续"); }
  if (!Array.isArray(parsed) || parsed.some(message => !message || typeof message !== "object" || !["user", "assistant"].includes(message.role) || typeof message.text !== "string")) {
    throw new Error("历史交接记录格式无效，原记录已保留；请新建会话或修复记录后继续");
  }
  const messages = parsed as DesktopAgentSnapshot["messages"];
  const bounded = prepareHandoff(messages, "pi", "pi").context;
  return `以下是当前对话的历史记录，仅作为上下文，继续处理最后的用户消息。\n${bounded}\n\n当前用户消息：\n${instruction}`;
}
