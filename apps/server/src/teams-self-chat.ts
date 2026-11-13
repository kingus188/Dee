import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { createTeamsGraph, graphPageUrl } from "./teams-graph.js";
import { messageText } from "./teams-message-text.js";
import type { GraphMessage } from "./teams-sync.js";

export const SELF_CHAT_ID = "48:notes";
export const SELF_CHAT_REPLY_PREFIX = "[Dee AI 测试回复] ";
export type SelfChatGenerate = (text: string, signal: AbortSignal) => Promise<string>;
type SelfChatOptions = {
  dir: string; username: string; getToken: () => Promise<string>; sendToken: () => Promise<string>;
  generate: SelfChatGenerate; signal: AbortSignal; fetchImpl?: typeof fetch; now?: () => number;
};
type SelfChatWorker = {
  refresh: () => Promise<{ ok: boolean }>;
  status: () => Record<string, import("node:sqlite").SQLOutputValue>[];
  close: () => Promise<void>;
};
type Message = GraphMessage & { chatId?: string };
type Page = { value: Message[]; "@odata.nextLink"?: string };
const path = `/chats/${encodeURIComponent(SELF_CHAT_ID)}/messages`;

export function createSelfChatGenerator(models: Models, ref: ModelRef): SelfChatGenerate {
  return async (text, signal) => {
    const model = models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error("自聊回复模型不可用");
    const reply = await models.completeSimple(model, {
      systemPrompt: "你是 Dee。这是用户本人在 Teams 自聊中的 AI 自动回复测试。直接用简体中文简短回答消息，不声称执行任何外部操作。没有工具权限。",
      messages: [{ role: "user", content: text, timestamp: Date.now() }],
    }, { maxTokens: 600, signal });
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error("自聊模型生成失败");
    return reply.content.filter(p => p.type === "text").map(p => p.text).join("");
  };
}

/** Account-scoped notes only. Durable claims survive model failures, restarts and uncertain sends. */
export function openTeamsSelfChat({ dir, username, getToken, sendToken, generate, signal, fetchImpl = fetch, now = Date.now }: SelfChatOptions): SelfChatWorker {
  if (!username.trim()) throw new Error("自聊测试必须指定账号");
  const db = new DatabaseSync(join(dir, "teams-self-chat.sqlite"));
  chmodSync(join(dir, "teams-self-chat.sqlite"), 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT NOT NULL, since INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS replies (source_id TEXT PRIMARY KEY, state TEXT NOT NULL, reply_id TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS replies_receipt ON replies(reply_id) WHERE reply_id IS NOT NULL`);
  const graph = createTeamsGraph(fetchImpl, signal);
  let running: Promise<{ ok: boolean }> | undefined;
  const seen = (id: string) => !!db.prepare("SELECT 1 FROM replies WHERE source_id=? OR reply_id=?").get(id, id);
  async function tick() {
    const token = await getToken();
    signal.throwIfAborted();
    const me = await graph<{ id: string; userPrincipalName?: string }>(token, "https://graph.microsoft.com/v1.0/me");
    if (!me.id || me.userPrincipalName?.split("@")[0].toLowerCase() !== username.toLowerCase()) throw new Error("自聊测试账号不一致，未发送");
    const account = db.prepare("SELECT * FROM account WHERE id=1").get();
    if (account && account.user_id !== me.id) throw new Error("自聊状态属于另一账号，未发送");
    const since = account ? Number(account.since) : now();
    const messages: Message[] = [];
    let cursor: string | undefined;
    const pages = new Set<string>();
    do {
      const url = graphPageUrl(path, cursor);
      if (pages.has(url) || pages.size >= 100) throw new Error("自聊消息分页未完成，未发送");
      pages.add(url);
      const page: Page = await graph<Page>(token, cursor ? url : `${url}?$top=50&$orderby=createdDateTime%20desc`);
      if (!Array.isArray(page.value) || page.value.some(m => !m.id || m.chatId !== SELF_CHAT_ID || !Number.isFinite(Date.parse(m.createdDateTime)) || (m.from?.user && m.from.user.id !== me.id))) throw new Error("自聊消息与账号或目标不一致，未发送");
      messages.push(...page.value);
      cursor = account && page.value.length && page.value.every(m => Date.parse(m.createdDateTime) >= Math.max(since, now() - 86400_000)) ? page["@odata.nextLink"] : undefined;
    } while (cursor);
    // First successful read establishes the baseline; historical notes never trigger replies.
    if (!account) {
      db.prepare("INSERT OR IGNORE INTO account(id,user_id,since) VALUES(1,?,?)").run(me.id, since);
      return { ok: true };
    }
    if (db.prepare("SELECT 1 FROM replies WHERE state IN ('sending','unknown')").get()) throw new Error("自聊回复发送结果未知，已暂停；请核实回执，不会自动重发");
    for (const message of messages.sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime))) {
      signal.throwIfAborted();
      if (seen(message.id) || Date.parse(message.createdDateTime) < since || message.messageType !== "message" || message.deletedDateTime || message.from?.user?.id !== me.id) continue;
      const text = messageText(message);
      if (!text || text.startsWith(SELF_CHAT_REPLY_PREFIX)) continue;
      if (!db.prepare("INSERT OR IGNORE INTO replies(source_id,state) VALUES(?,'processing')").run(message.id).changes) continue;
      let posting = false;
      try {
        if (Date.parse(message.createdDateTime) > now() + 60_000 || now() - Date.parse(message.createdDateTime) > 86400_000 || (message.body?.content?.length ?? 0) > 8000 || message.attachments?.length || /<img\b/i.test(message.body?.content ?? "")) throw new Error("自聊测试仅接受一天内的短文本");
        const generationSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
        const answer = await generate(text, generationSignal);
        generationSignal.throwIfAborted();
        if (typeof answer !== "string" || !answer.trim() || answer.length > 1500) throw new Error("自聊模型回复为空或过长");
        const content = SELF_CHAT_REPLY_PREFIX + answer.trim().replace(/\s+/g, " ");
        const current = await graph<Message>(token, graphPageUrl(`${path}/${encodeURIComponent(message.id)}`));
        if (current.chatId !== SELF_CHAT_ID || current.from?.user?.id !== me.id || current.deletedDateTime || current.body?.content !== message.body?.content || messageText(current) !== text) throw new Error("自聊原文已变化，未发送");
        const auth = await sendToken();
        signal.throwIfAborted();
        // Commit before POST: an interrupted request must never become retryable.
        db.prepare("UPDATE replies SET state='sending' WHERE source_id=?").run(message.id);
        posting = true;
        const receipt = await graph<Message>(auth, graphPageUrl(path), { body: { contentType: "text", content } });
        if (!receipt.id) throw new Error("自聊发送缺少回执");
        db.prepare("UPDATE replies SET reply_id=? WHERE source_id=?").run(receipt.id, message.id);
        const delivered = await graph<Message>(token, graphPageUrl(`${path}/${encodeURIComponent(receipt.id)}`));
        if (delivered.chatId !== SELF_CHAT_ID || delivered.from?.user?.id !== me.id || messageText(delivered) !== content) throw new Error("自聊回复回读不一致");
        db.prepare("UPDATE replies SET state='sent' WHERE source_id=?").run(message.id);
      } catch (error) {
        db.prepare("UPDATE replies SET state=? WHERE source_id=?").run(posting ? "unknown" : "failed", message.id);
        throw error;
      }
    }
    return { ok: true };
  }
  return {
    refresh: () => running ??= tick().finally(() => { running = undefined; }),
    status: () => db.prepare("SELECT source_id,state,reply_id FROM replies ORDER BY rowid DESC LIMIT 10").all(),
    close: async () => { try { await running; } finally { db.close(); } },
  };
}

export function startTeamsSelfChat(options: SelfChatOptions, onError: (error: unknown) => void): () => Promise<void> {
  let stopped = false, failures = 0, timer: NodeJS.Timeout | undefined;
  let stop: Promise<void> | undefined;
  const cancellation = new AbortController();
  const worker = openTeamsSelfChat({ ...options, signal: AbortSignal.any([options.signal, cancellation.signal]) });
  async function tick() {
    let retryAfter = 0;
    try { await worker.refresh(); failures = 0; }
    catch (error) {
      failures = Math.min(failures + 1, 6);
      const retry = error && typeof error === "object" && "retryAfterMs" in error ? Number(error.retryAfterMs) : 0;
      if (Number.isFinite(retry)) retryAfter = Math.max(0, retry);
      if (!stopped) onError(error);
    }
    if (!stopped) timer = setTimeout(() => void tick(), Math.max(retryAfter, Math.min(300_000, 5000 * 2 ** failures)));
  }
  void tick();
  return () => stop ??= (async () => {
    stopped = true; clearTimeout(timer); cancellation.abort();
    await worker.close();
  })();
}
