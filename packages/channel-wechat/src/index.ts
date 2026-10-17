import type { AttachedReplicatedState, Context } from "@earendil-works/chord";
import type { Conversation, ConversationId, ConversationView, Harness, ModelRef } from "@earendil-works/pi-durable";
import type { Index } from "@assistant/runtime";
// 微信 Channel：持久会话绑定、入站幂等、回复 outbox。与 iLink 协议实现隔离。
import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { WechatNotifications, notificationForAnswer, recoverLegacyTeams, type NotificationSource, type NotificationReview } from "./notifications.js";
export { WechatNotifications } from "./notifications.js";
export type { NotificationSource, NotificationReview } from "./notifications.js";

type Binding = { key: string; binding: string; wxid: string; conversationId: ConversationId };
type OutboxItem = {
  id: string;
  binding: string;
  wxid: string;
  text: string;
  status: "pending" | "sending" | "sent" | "blocked" | "cancelled";
  source?: NotificationSource;
  cancelledAt?: number;
  cancelReason?: string;
  attempts: number;
  nextAt: number;
  createdAt: number;
  sentAt?: number;
};
type ReplyContent = string | readonly { type: string; text?: string }[];
type ReplyEntry = { id: number; kind: string; model?: readonly { content?: ReplyContent; stopReason?: string }[] };
type Watcher = { view: AttachedReplicatedState<ConversationView>; off: (() => void) | null; active: boolean; pending: Promise<void> };
type ChannelOptions = {
  harness: Harness;
  root: Conversation;
  agentModel: ModelRef;
  indexDoc: typeof Index;
  context: Context;
  sendURL: string;
  sendToken: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  reviewNotification?: (source: NotificationSource) => Promise<NotificationReview>;
};

export const WechatState = defineDoc<{ bindings: Record<string, Binding>; cursors: Record<string, number>; outbox: OutboxItem[] }>({
  kind: "app.wechat.state", version: 1, scope: "session",
  initial: () => ({ bindings: {}, cursors: {}, outbox: [] }),
});

const now = () => Date.now();
const contentText = (content: ReplyContent | undefined) => typeof content === "string" ? content :
  (Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text || "").join("") : "");

export function inboundKey(binding: unknown, wxid: unknown) {
  if (typeof binding !== "string" || !/^[a-z0-9_-]{1,32}$/.test(binding)) throw new Error("binding 不合法");
  if (typeof wxid !== "string" || !wxid || wxid.length > 256) throw new Error("from_wxid 不合法");
  return createHash("sha256").update(JSON.stringify([binding, wxid])).digest("hex");
}

export function validateInbound(raw: unknown) {
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("消息体必须为对象");
  if (typeof body.message_id !== "string" || !/^[0-9]{1,32}$/.test(body.message_id))
    throw new Error("message_id 不合法");
  const key = inboundKey(body.binding, body.from_wxid);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const voice = typeof body.voice_text === "string" ? body.voice_text.trim() : "";
  if (text.length > 8000 || voice.length > 8000) throw new Error("消息超出长度限制");
  const kinds = Array.isArray(body.media)
    ? body.media.slice(0, 8).map((m) => String(m?.type || "附件")).join("、") : "";
  const message = [text, voice && voice !== text ? voice : "",
    kinds ? "[微信附件：" + kinds + "。当前版本尚不能查看附件内容，请明确告知用户需要文字描述。]" : ""]
    .filter(Boolean).join("\n").slice(0, 8000);
  // 用户「引用回复」时被引用的那条消息：内容来自第三方，必须和用户原话分开成独立的 content 片段，
  // 模型仍看得到它，但下游的发送授权只核对用户原话。格式和 @assistant/features 的 QUOTE 解析一致。
  const quote = typeof body.quote === "string" ? body.quote.trim().replace(/\r/g, "").slice(0, 1000) : "";
  const content = quote && message
    ? [{ type: "text" as const, text: "<引用>\n" + quote + "\n</引用>" }, { type: "text" as const, text: message }]
    : message;
  return { key, binding: body.binding as string, wxid: body.from_wxid as string, message, content, ignored: !message,
    requestId: "wechat:" + createHash("sha256").update(JSON.stringify([body.binding, body.from_wxid, body.message_id])).digest("hex") };
}

export function newAssistantReplies(entries: readonly ReplyEntry[] | undefined, cursor: number | undefined | null) {
  const list: readonly ReplyEntry[] = Array.isArray(entries) ? entries : [];
  if (!list.length) return { cursor, replies: [] };
  let offset = 0;
  if (cursor !== undefined && cursor !== null) {
    const found = list.findIndex((e) => String(e.id) === String(cursor));
    // History may be compacted. Missing cursor => skip old entries, never replay historical replies.
    if (found === -1) return { cursor: list.at(-1)!.id, replies: [] };
    offset = found + 1;
  }
  const replies = list.slice(offset).filter((e) => {
    if (e.kind !== "pi.assistant") return false;
    const message = e.model?.[0];
    if (!message || (message.stopReason === "error" || message.stopReason === "aborted")) return false;
    return !(Array.isArray(message.content) && message.content.some((part) => part.type === "toolCall")) && !!contentText(message.content).trim();
  }).map((e) => ({ id: e.id, text: contentText(e.model?.[0]?.content).trim().slice(0, 20000) }));
  return { cursor: list.at(-1)!.id, replies };
}

const detach = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class WechatChannel {
  private harness: Harness;
  private root: Conversation;
  private agentModel: ModelRef;
  private indexDoc: typeof Index;
  private context: Context;
  private sendURL: string;
  private sendToken: string;
  private fetchImpl: typeof fetch;
  private intervalMs: number;
  private reviewNotification?: ChannelOptions["reviewNotification"];
  private views: Map<ConversationId, Watcher>;
  private creating: Map<string, ReturnType<WechatChannel["receive"]>>;
  private timer: ReturnType<typeof setInterval> | null;
  private busy: boolean;
  private stopped = false;
  constructor({ harness, root, agentModel, indexDoc, context, sendURL, sendToken, fetchImpl = fetch, intervalMs = 2000, reviewNotification }: ChannelOptions) {
    this.harness = harness;
    this.root = root;
    this.agentModel = agentModel;
    this.indexDoc = indexDoc;
    this.context = context;
    this.sendURL = sendURL;
    this.sendToken = sendToken;
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.reviewNotification = reviewNotification;
    this.views = new Map();
    this.creating = new Map();
    this.timer = null;
    this.busy = false;
  }

  // 旧版注入有确定的 requestId：只恢复这些可证明的来源，不按「未回复」等文案猜测。
  async linkLegacyTeams(messageIds: readonly string[]) {
    return this.root.commit(async tx => {
      const state = await tx.doc(WechatState);
      return recoverLegacyTeams(tx, Object.values(state.bindings), state.outbox, messageIds,
        (binding, wxid, id) => validateInbound({ binding, from_wxid: wxid, message_id: id, text: "legacy" }).requestId);
    }, this.context);
  }

  async start() {
    this.stopped = false;
    const doc = await this.harness.snapshot(WechatState, this.context);
    for (const binding of Object.values(doc?.bindings ?? {})) await this.watch(binding);
    this.timer = setInterval(() => this.tick().catch((e) => console.error("微信队列异常：", e?.message)), this.intervalMs);
    this.timer.unref?.();
    await this.tick();
  }

  async incoming(raw: unknown) {
    const data = validateInbound(raw);
    // 微信内部可能发送空事件，不让它们阻塞持久消息游标。
    if (data.ignored) return { ok: true, ignored: true };
    return this.enqueueInput(data);
  }

  // 仅宿主内部调用；普通 HTTP 入站即使伪造 source 字段也不能成为自动提醒。
  async notify(binding: string, wxid: string, text: string, source: NotificationSource) {
    if (source.kind !== "teams" || !source.messageIds.length || source.messageIds.some(id => !id)) throw new Error("提醒缺少来源");
    const digest = createHash("sha256").update(JSON.stringify([...source.messageIds].sort())).digest("hex");
    const data = validateInbound({ binding, from_wxid: wxid, text, message_id: BigInt("0x" + digest.slice(0, 24)).toString() });
    if (data.ignored) throw new Error("提醒内容为空");
    data.requestId = "notification:" + data.requestId;
    return this.enqueueInput(data, source);
  }

  private async enqueueInput(data: ReturnType<typeof validateInbound>, source?: NotificationSource) {
    const previous = this.creating.get(data.key) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.receive(data, source));
    this.creating.set(data.key, job);
    try { return await job; } finally {
      if (this.creating.get(data.key) === job) this.creating.delete(data.key);
    }
  }

  async receive(data: ReturnType<typeof validateInbound>, source?: NotificationSource) {
    const doc = await this.harness.snapshot(WechatState, this.context);
    let binding = doc?.bindings?.[data.key];
    let conversation;
    if (!binding) {
      const key = data.key;
      conversation = await this.harness.createConversation({
        ownership: { kind: "ownerless" }, agent: { model: this.agentModel },
        init: async (tx, conversationId) => {
          (await tx.doc(this.indexDoc)).items.push({
            id: conversationId, title: "微信：" + data.binding,
            createdAt: new Date().toISOString(), channel: "wechat",
          });
          (await tx.doc(WechatState)).bindings[key] = {
            key, binding: data.binding, wxid: data.wxid, conversationId,
          };
        },
      }, this.context);
      binding = { key, binding: data.binding, wxid: data.wxid, conversationId: conversation.id };
    } else {
      conversation = await this.harness.conversation(binding.conversationId, this.context);
      if (!conversation) throw new Error("微信绑定的会话不存在");
    }
    if (source) await this.root.commit(async tx => {
      const tracked = await tx.doc(WechatNotifications);
      if (!tracked.items.some(item => item.conversationId === conversation.id && item.requestId === data.requestId)) {
        tracked.items.push({ conversationId: conversation.id, requestId: data.requestId, source });
      }
    }, this.context);
    await this.watch(binding, conversation);
    const submission = await conversation.submit({
      type: "input", content: data.content, requestId: data.requestId, whenBusy: "followUp",
    }, this.context);
    // 用户刚发来消息，回复令牌已刷新：立即重试因失败而退避等待的消息，不用等到下一个退避时间点。
    if (!source) await this.root.commit(async (tx) => {
      for (const item of (await tx.doc(WechatState)).outbox) if (item.status === "pending") item.nextAt = 0;
    }, this.context);
    return { ok: true, conversationId: conversation.id, submissionId: submission.id };
  }

  async watch(binding: Binding, conversation?: Conversation) {
    if (this.views.has(binding.conversationId)) return;
    const conv = conversation ?? await this.harness.conversation(binding.conversationId, this.context);
    if (!conv) return;
    const view = await conv.viewState(this.context);
    const listener: Watcher = { view, off: null, active: true, pending: Promise.resolve() };
    this.views.set(binding.conversationId, listener);
    const scan = () => {
      listener.pending = listener.pending.then(() => this.scan(binding, view.value))
        .catch((e) => console.error("微信回复入队失败：", e?.message));
    };
    listener.off = view.subscribe(scan);
    scan();
  }

  async scan(binding: Binding, value: ConversationView) {
    const entries = value?.entries ?? [];
    // Root document transaction atomically advances cursor and enqueues replies.
    await this.root.commit(async (tx) => {
      const state = await tx.doc(WechatState);
      const last = state.cursors[binding.key];
      const { cursor, replies } = newAssistantReplies(entries, last);
      if (cursor == null || String(cursor) === String(last)) return;
      for (const reply of replies) {
        const id = binding.key + ":" + reply.id;
        const source = await notificationForAnswer(tx, binding.conversationId, reply.id);
        if (!state.outbox.some((x) => x.id === id)) state.outbox.push({
          id, binding: binding.binding, wxid: binding.wxid,
          text: reply.text, status: "pending", attempts: 0,
          nextAt: 0, createdAt: now(), ...(source ? { source } : {}),
        });
      }
      state.cursors[binding.key] = cursor;
      // Keep only recent delivery history; never delete unsent jobs.
      const cutoff = now() - 7 * 86400_000;
      state.outbox = state.outbox.filter((x) => !["sent", "cancelled"].includes(x.status) || x.createdAt > cutoff);
      const tracked = await tx.doc(WechatNotifications);
      for (let i = tracked.items.length - 1; i >= 0; i--) {
        const item = tracked.items[i];
        if (item.conversationId !== binding.conversationId) continue;
        const submission = await tx.submissionByRequest(item.conversationId, item.requestId);
        if (submission?.status === "unanswered" || (submission?.type === "input" && submission.status === "done" && submission.answer <= cursor)) tracked.items.splice(i, 1);
      }
    }, this.context);
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      // Limit work per tick to prevent monopolizing the node event loop.
      for (let n = 0; n < 8 && !this.stopped; n++) {
        const item = await this.root.commit(async (tx) => {
          const doc = await tx.doc(WechatState);
          const item = doc.outbox.find((x) =>
            (x.status === "pending" && x.nextAt <= now()) ||
            (x.status === "sending" && x.nextAt <= now()) ||
            (x.status === "blocked" && !!x.source && x.nextAt <= now()));
          if (item) {
            const blocked = item.status === "blocked";
            item.status = "sending";
            item.nextAt = now() + 60_000; // crash lease
            item.attempts += 1;
            return { ...detach(item), blocked };
          }
        }, this.context);
        if (!item) break;
        let ok = false, permanent = false;
        try {
          if (item.source) {
            if (!this.reviewNotification) throw new Error("提醒校验器尚未就绪");
            const review = await this.reviewNotification(item.source);
            if (review.status === "cancel") {
              await this.root.commit(async tx => {
                const current = (await tx.doc(WechatState)).outbox.find(x => x.id === item.id);
                if (current?.status === "sending") {
                  current.status = "cancelled"; current.cancelledAt = now(); current.cancelReason = review.reason; current.nextAt = 0;
                }
              }, this.context);
              continue;
            }
            if (review.text !== undefined) item.text = review.text;
            if (this.stopped) return;
            if (item.blocked) {
              await this.root.commit(async tx => {
                const current = (await tx.doc(WechatState)).outbox.find(x => x.id === item.id);
                if (current?.status === "sending") { current.status = "blocked"; current.nextAt = now() + 300_000; }
              }, this.context);
              continue;
            }
          }
          if (this.stopped) return;
          const response = await this.fetchImpl(this.sendURL, {
            method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + this.sendToken },
            body: JSON.stringify({ binding: item.binding, to: item.wxid, text: item.text }),
            signal: AbortSignal.timeout(12000), redirect: "error",
          });
          ok = response.ok;
          // No context_token / unauthenticated / invalid destination => wait for manual resolution.
          permanent = [400, 401, 403, 404, 409, 413, 422].includes(response.status);
        } catch (e) {
          console.error("微信发送网络失败：", e instanceof Error ? e.name : "network error");
        }
        await this.root.commit(async (tx) => {
          const current = (await tx.doc(WechatState)).outbox.find((x) => x.id === item.id);
          if (!current || current.status !== "sending") return;
          current.status = ok ? "sent" : (permanent || item.blocked) ? "blocked" : "pending";
          current.nextAt = ok ? 0 : now() + Math.min(300_000, 2000 * 2 ** Math.min(current.attempts, 8));
          if (ok) { current.sentAt = now(); current.text = item.text; }
        }, this.context);
        if (!ok && permanent) console.error("微信消息被拒绝，已暂停自动重试；请检查 wx-bot 状态");
      }
    } finally { this.busy = false; }
  }

  // 没送到用户手里的回复，供宿主提醒：pending 会自动退避重试（通常是回复令牌过期），
  // blocked 被微信拒收后不会自动补发，必须有人处理。正在发送的不算。
  async undelivered() {
    const doc = await this.harness.snapshot(WechatState, this.context);
    return (doc?.outbox ?? [])
      .filter((x) => x.status === "blocked" || (x.status === "pending" && x.attempts > 0))
      .map((x) => ({ text: x.text, createdAt: x.createdAt, status: x.status as "pending" | "blocked" }));
  }

  async status() {
    const doc = await this.harness.snapshot(WechatState, this.context);
    return { enabled: true, bindings: Object.values(doc?.bindings ?? {}).map((b) => ({
      binding: b.binding, conversationId: b.conversationId,
    })), pending: doc?.outbox?.filter((x) => x.status === "pending" || x.status === "sending").length ?? 0,
    blocked: doc?.outbox?.filter((x) => x.status === "blocked").length ?? 0 };
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const v of this.views.values()) { v.active = false; v.off?.(); v.view.dispose(); }
    this.views.clear();
  }
}
