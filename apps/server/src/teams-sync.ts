import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TeamsStore } from "./teams-store.js";
import { isImportant, type ImportantRules } from "./teams-rules.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";
export type GraphMessage = {
  id: string; createdDateTime: string; messageType?: string;
  from?: { user?: { id?: string; displayName?: string } };
  body?: { content?: string; contentType?: string };
  mentions?: { mentioned?: { user?: { id?: string } } }[];
};
type Chat = { id: string; chatType: string; topic?: string | null; lastMessagePreview?: { createdDateTime?: string } | null };
type Page<T> = { value: T[]; "@odata.nextLink"?: string };
export type SyncResult = { ok: boolean; lastSuccessAt: string | null; skipped?: string[] };
// 分页地址不合法或自引用循环是安全问题，不能当成单个聊天的故障跳过。
class UnsafePaging extends Error {}
const OVERLAP_MS = 5 * 60_000;
const RECOVERY_MS = 24 * 60 * 60_000;

export function messageText(message: GraphMessage) {
  const body = message.body?.content ?? "";
  return (message.body?.contentType === "html" ? body.replace(/<[^>]*>/g, " ") : body)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim().slice(0, 2000);
}

// 查询、提醒投递和定时轮询共用同一个采集器；并发刷新合并，不在刷新中产生通知。
export function createTeamsSync({ dir, store, getToken, rules, fetchImpl = fetch, signal }: {
  dir: string; store: TeamsStore; getToken: () => Promise<string>; rules?: ImportantRules; fetchImpl?: typeof fetch; signal?: AbortSignal;
}) {
  const markPath = join(dir, "teams-forward.json");
  const statusPath = join(dir, "teams-sync-status.json");
  const marks: Record<string, string> = existsSync(markPath) ? JSON.parse(readFileSync(markPath, "utf8")) : {};
  const startedAt = Date.now();
  const recovered = new Set<string>();
  // Graph 对会议聊天等返回 403：权限性拒绝，重试无用，记下来后不再请求，也不算本轮故障。
  const unreadable = new Set<string>();
  let lastSuccessAt: string | null = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, "utf8")).lastSuccessAt ?? null : null;
  let running: Promise<SyncResult> | undefined;
  const save = (path: string, value: unknown) => {
    writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  };
  async function graph<T>(auth: string, path: string): Promise<T> {
    signal?.throwIfAborted();
    const url = path.startsWith("/") ? new URL(GRAPH + path) : new URL(path);
    // nextLink 来自远端；禁止把 Authorization 转发到其他来源或协议。
    if (url.origin !== "https://graph.microsoft.com" || !url.pathname.startsWith("/v1.0/") || url.username || url.password) throw new UnsafePaging("Graph 分页地址不合法");
    const response = await fetchImpl(url.href, { headers: { Authorization: `Bearer ${auth}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) throw new Error(`Graph ${response.status} ${url.pathname}`);
    return await response.json() as T;
  }
  async function* pages<T>(auth: string, path: string) {
    const seen = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      if (seen.has(next) || seen.size >= 1000) throw new UnsafePaging("Graph 分页未完成，保留原水位");
      seen.add(next);
      const page: Page<T> = await graph(auth, next);
      if (!Array.isArray(page.value)) throw new Error("Graph 分页格式错误");
      yield page.value;
      next = page["@odata.nextLink"];
    }
  }
  // 这一轮要为该聊天读取的时间窗：首轮重扫既有聊天至少 24h，并覆盖仍未回复的来信，
  // 以补旧版第一页水位造成的缺口；之后每轮留 5 分钟重叠，接收同时间晚到的消息。
  function windowOf(chatId: string) {
    const mark = marks[chatId];
    const pending = store.earliestUnrepliedAt(chatId);
    const lower = mark ? Math.min(Date.parse(mark) - (recovered.has(chatId) ? OVERLAP_MS : RECOVERY_MS),
      !recovered.has(chatId) && pending ? Date.parse(pending) : Infinity) : startedAt;
    return { lower, newest: mark ? Date.parse(mark) : startedAt };
  }

  // 单个聊天的增量同步：所需页全部读取成功后才入库并推进它的水位。
  async function syncChat(auth: string, meId: string, chat: Chat, window: { lower: number; newest: number }) {
    const { lower } = window;
    let newest = window.newest;
    const messages = new Map<string, GraphMessage>();
    for await (const page of pages<GraphMessage>(auth, `/chats/${encodeURIComponent(chat.id)}/messages?$top=50&$orderby=createdDateTime desc`)) {
      if (page.some(m => !m.id || !Number.isFinite(Date.parse(m.createdDateTime)))) throw new Error("Graph 消息时间或 ID 无效");
      for (const message of page) if (Date.parse(message.createdDateTime) >= lower) messages.set(message.id, message);
      if (page.length && page.every(message => Date.parse(message.createdDateTime) < lower)) break;
    }
    signal?.throwIfAborted();
    // 中断可用消息 ID 安全重放。
    for (const message of [...messages.values()].sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime))) {
      const sender = message.from?.user;
      const time = Date.parse(message.createdDateTime);
      if (message.messageType === "message" && sender?.id) {
        const text = messageText(message), mine = sender.id === meId;
        store.record({ id: `${chat.id}:${message.id}`, chatId: chat.id, chatType: chat.chatType, chatTopic: chat.topic ?? undefined,
          senderId: sender.id, senderName: sender.displayName ?? "未知", direction: mine ? "out" : "in", text,
          createdAt: new Date(time).toISOString(), important: !mine && isImportant(rules, { chatType: chat.chatType, senderId: sender.id,
            senderName: sender.displayName, text, mentionsMe: !!message.mentions?.some(item => item.mentioned?.user?.id === meId) }) });
      }
      newest = Math.max(newest, time);
    }
    const next = { ...marks, [chat.id]: new Date(newest).toISOString() };
    save(markPath, next);
    Object.assign(marks, next);
    recovered.add(chat.id);
  }

  async function collect(): Promise<SyncResult> {
    const auth = await getToken();
    const me = await graph<{ id: string }>(auth, "/me?$select=id");
    if (!me.id) throw new Error("Graph 缺少当前用户标识");
    // 单个聊天（或聊天列表的某一页）失败只跳过它：其余聊天照常入库，但本轮不算成功，
    // 它的水位和 lastSuccessAt 都不推进，下一轮重试。
    const skipped: string[] = [];
    let fault = false;
    const skip = (what: string, error: unknown, chatId?: string) => {
      if (error instanceof UnsafePaging) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      skipped.push(`${what}：${reason}`);
      // 403 重试无用，不能让整轮永远算失败、把依赖 ok 的自动提醒一起停掉。
      if (chatId && reason.includes(" 403 ")) unreadable.add(chatId);
      else fault = true;
    };
    try {
      for await (const chats of pages<Chat>(auth, "/me/chats?$expand=lastMessagePreview&$top=50")) {
        for (const chat of chats) {
          if (unreadable.has(chat.id)) continue;
          const window = windowOf(chat.id);
          // lastMessagePreview 是该聊天最新消息的时间：早于本轮时间窗就不可能有要读的消息，
          // 省掉一次请求。仍未回复的来信已经把 lower 压到那条来信，所以不会被跳过。
          const preview = chat.lastMessagePreview?.createdDateTime;
          if (preview && Date.parse(preview) < window.lower) continue;
          try { await syncChat(auth, me.id, chat, window); } catch (error) { skip(`聊天 ${chat.id}`, error, chat.id); }
        }
      }
    } catch (error) { skip("聊天列表", error); }
    signal?.throwIfAborted();
    // 只有可重试的故障才让本轮不算成功；水位已按聊天各自推进。
    if (fault) return { ok: false, lastSuccessAt, skipped };
    const completedAt = new Date().toISOString();
    save(statusPath, { lastSuccessAt: completedAt });
    lastSuccessAt = completedAt;
    return { ok: true, lastSuccessAt, skipped };
  }
  return {
    refresh(): Promise<SyncResult> {
      return running ??= collect().finally(() => { running = undefined; });
    },
    status: () => ({ lastSuccessAt }),
  };
}
