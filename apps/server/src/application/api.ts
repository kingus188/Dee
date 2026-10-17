import { Index, Meta } from "@assistant/runtime";
import { personalError } from "@assistant/features";
import type { AppContext } from "./context.js";
import { HttpError } from "../errors.js";
import { createConversations } from "./conversations.js";
import { openDirectChat } from "./direct-chat.js";
import { createMessages } from "./messages.js";
import { createManagement } from "./management.js";
import { createPersonalService } from "./personal.js";
import { createViews } from "./views.js";
import { createDailyReports } from "../daily-reports.js";

// HTTP 与 WebSocket 共用用例和错误语义。
export function createApi(context: AppContext) {
  const { harness, ctx, agentModel, config, modelLabel, startedAt, wechat } = context;
  const conversations = createConversations(context), views = createViews(context);
  const messages = createMessages(context, conversations), tasks = createManagement(context, views), personal = createPersonalService(context);
  const dailyReports = createDailyReports(config.dataDir);
  async function dispatch(method: string, url: URL, body: Record<string, unknown> = {}) {
    const path = url.pathname;
    if (method === "GET" && path === "/api/daily-reports") return { status: 200, data: dailyReports.list() };
    const report = path.match(/^\/api\/daily-reports\/([^/]+)$/);
    if (report) {
      if (method === "GET") return { status: 200, data: dailyReports.get(report[1]) };
      if (method === "POST") return { status: 200, data: dailyReports.save(report[1], body) };
    }
    if (path === "/api/settings/model") {
      if (method === "GET") return { status: 200, data: context.modelSettings.get() };
      if (method === "POST") return { status: 200, data: await context.modelSettings.save(body) };
    }
    if (path === "/api/settings/wechat") {
      if (method === "GET") return { status: 200, data: context.wechatSettings.get() };
      if (method === "POST") return { status: 200, data: context.wechatSettings.save(body) };
    }
    if (method === "POST" && path.startsWith("/api/conversations") && !context.modelConfigured) throw new HttpError(409, "请先在设置中保存模型配置，再重启应用");
    if (method === "GET" && path === "/api/info") {
      const meta = await harness.snapshot(Meta, ctx);
      return { status: 200, data: { model: modelLabel, api: config.model.api, configured: context.modelConfigured, pid: process.pid, startedAt, boots: meta?.boots ?? 0 } };
    }
    if (method === "GET" && path === "/api/wechat/status") return { status: 200, data: wechat ? await wechat.status() : { enabled: false } };
    if (path.startsWith("/api/personal") || path.startsWith("/api/knowledge/")) {
      try {
        if (method === "GET" && path === "/api/personal") return { status: 200, data: await personal.get() };
        if (method === "GET" && path === "/api/knowledge/search") return { status: 200, data: await personal.search(url.searchParams.get("q") || "", url.searchParams.get("history") === "1") };
        if (method === "GET" && path === "/api/knowledge/read") return { status: 200, data: await personal.read(url.searchParams.get("path") || "", Number(url.searchParams.get("line") || 1)) };
        const match = path.match(/^\/api\/personal\/(memory|skills)(?:\/([0-9a-f-]+)\/(approve|reject|edit))?$/);
        if (method === "POST" && match) {
          const [, kind, id, action] = match;
          return { status: id ? 200 : 201, data: { item: await personal.save(kind, body, id, action) } };
        }
      } catch (error) {
        if (personalError(error)) throw new HttpError(400, error.message);
        throw error;
      }
    }
    if (method === "POST" && path === "/api/conversations/direct") return { status: 200, data: { id: await openDirectChat(context) } };
    if (method === "POST" && path === "/api/conversations/direct/new") return { status: 200, data: { id: await openDirectChat(context, { fresh: true }) } };
    if (path === "/api/conversations") {
      if (method === "GET") return { status: 200, data: [...((await harness.snapshot(Index, ctx))?.items ?? [])].reverse() };
      if (method === "POST") {
        const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: agentModel }, init: conversations.registerIn({ title: "新对话" }) }, ctx);
        return { status: 201, data: { id: conversation.id } };
      }
    }
    const shelf = method === "POST" && path.match(/^\/api\/conversations\/(\d+)\/(archive|restore|remove)$/);
    if (shelf) return { status: 200, data: await conversations.shelveConversation(Number(shelf[1]), shelf[2]) };
    const chat = path.match(/^\/api\/conversations\/(\d+)\/(messages|fork|abort)$/);
    if (method === "POST" && chat) {
      const conversation = await conversations.getConversation(Number(chat[1]));
      if (chat[2] === "messages") return { status: 202, data: await messages.submit(conversation, body) };
      if (chat[2] === "fork") return { status: 201, data: await messages.fork(conversation, body) };
      await conversation.abort(ctx);
      return { status: 200, data: { ok: true } };
    }
    const manage = path.match(/^\/api\/conversations\/(\d+)\/(management|schedules|background|reminders)(?:\/([0-9a-f-]+))?(?:\/(pause|resume|cancel|stop))?$/);
    if (manage) {
      const conversation = await conversations.getConversation(Number(manage[1]));
      const [, , resource, id, action] = manage;
      if (method === "GET" && resource === "management" && !id) return { status: 200, data: await tasks.get(conversation) };
      if (method === "POST") {
        try {
          if (resource === "schedules" && !id) return { status: 201, data: { item: await tasks.schedule(conversation, body) } };
          if (resource === "schedules" && id && ["pause", "resume", "cancel"].includes(action)) return { status: 200, data: { item: await tasks.manageSchedule(conversation, id, action) } };
          if (resource === "reminders" && id && action === "cancel") return { status: 200, data: { item: await tasks.cancelReminder(conversation, id) } };
          if (resource === "background" && !id) return { status: 201, data: { item: await tasks.background(conversation, body) } };
          if (resource === "background" && id && action === "stop") return { status: 200, data: { item: await tasks.stopBackground(conversation, id) } };
        } catch (error) {
          if (error instanceof Error && /任务内容|首次执行|重复间隔|requestId|计划任务不存在|当前状态|后台任务说明/.test(error.message)) throw new HttpError(400, error.message);
          throw error;
        }
      }
    }
    throw new HttpError(404, "接口不存在");
  }
  return { dispatch, conversations, views, messages, tasks };
}
