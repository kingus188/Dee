import { createHash, randomUUID } from "node:crypto";
import type { TeamsTriageOverview, TeamsTriageItem } from "@assistant/contracts";
import type { AppContext } from "./application/context.js";
import { HttpError } from "./errors.js";
import { syncDelay } from "./teams-sync-policy.js";

type Context = Pick<AppContext, "config" | "teamsStore" | "teamsSender" | "daylight">;
export async function teamsTriageApi(context: Context, method: string, url: URL, body: Record<string, unknown>) {
  if (!url.pathname.startsWith("/api/teams/triage")) return;
  const { teamsStore: store, teamsSender: sender, daylight } = context;
  const enabled = !context.config.offline && !!sender.refresh;
  const overview = (): TeamsTriageOverview => {
    const settings = store.triage.settings(), lastSuccessAt = sender.syncStatus?.().lastSuccessAt ?? null;
    return { enabled, lastSuccessAt, settings, ...store.triage.list(),
      stale: !enabled || !lastSuccessAt || Date.now() - Date.parse(lastSuccessAt) > syncDelay(settings, Date.now()) + 60_000 };
  };
  if (method === "GET" && url.pathname === "/api/teams/triage") return { status: 200, data: overview() };
  if (method !== "POST") return;
  if (url.pathname === "/api/teams/triage/settings") return { status: 200, data: store.triage.saveSettings(body.settings) };
  async function refresh() {
    if (!enabled) throw new HttpError(503, "Teams 同步未连接，不能核对当前来源");
    try {
      const result = await sender.refresh!();
      if (!result.ok) throw new Error("not current");
      return result;
    } catch { throw new HttpError(503, "Teams 来源核对失败，请稍后重试；没有根据旧缓存创建待办"); }
  }
  if (url.pathname === "/api/teams/triage/refresh") { await refresh(); return { status: 200, data: overview() }; }
  if (url.pathname !== "/api/teams/triage/act") return;
  const { id, revision, action } = body;
  if (typeof id !== "string" || !id || id.length > 2048 || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || !["create", "dismiss", "snooze"].includes(String(action))) throw new HttpError(400, "Teams 建议操作无效，请刷新后重试");
  // The stable source key survives retry, concurrent clicks, restart and source edits.
  const created = store.triage.created(id);
  if (created && action === "create") return { status: 200, data: { ok: true, taskId: created } };
  const current = (): TeamsTriageItem => {
    const item = store.triage.find(id);
    if (!item || item.revision !== revision || !store.sourceAllowed(`teams:${item.chatId}`, revision, [id])) throw new HttpError(409, "来源已回复、编辑、撤回或建议已处理，请刷新列表");
    return item;
  };
  let item = current();
  if (action !== "create") {
    store.triage.decide(id, revision, action === "dismiss" ? "dismissed" : "snoozed");
    return { status: 200, data: { ok: true } };
  }
  const result = await refresh();
  item = current();
  if (!result.refreshedChatIds?.includes(item.chatId)) throw new HttpError(503, "本轮未能核对该聊天的访问权和最新状态，暂不创建待办");
  // A successful paged chat read is not proof that this exact message still
  // exists. The reader saves observed edits/deletions through the source ledger.
  if (!sender.read) throw new HttpError(503, "Teams 原始消息读取未就绪，暂不创建待办");
  const messageId = item.id.slice(item.chatId.length + 1);
  try {
    const exact = await sender.read({ kind: "history", chatId: item.chatId, messageId });
    if (!exact.data || typeof exact.data !== "object" || !("id" in exact.data) || exact.data.id !== messageId) throw new Error("wrong source");
  }
  catch { throw new HttpError(503, "无法核对这条 Teams 原始消息，暂不创建待办"); }
  item = current();
  if (!item.suggestTodo) throw new HttpError(409, "这条消息还没有明确的行动请求，请先核对原文");
  const key = "teams-triage:" + createHash("sha256").update(id).digest("hex");
  const taskId = await daylight.replayAction(key, async tx => {
    const project = await tx.ensureDefaultProject();
    const fresh = current(), now = Date.now(), taskId = randomUUID();
    await tx.saveTask({ id: taskId, projectId: project.id, title: fresh.suggestedTitle,
      description: "由你确认创建的 Teams 跟进事项。原始消息正文未复制到任务中，回复或来源撤回不会自动完成或删除此任务。请核对原文后补充你自己的行动描述。" + (fresh.sourceUrl ? `\n\n[查看 Teams 原始消息](${fresh.sourceUrl})` : ""),
      status: "todo", priority: "medium", color: "lavender", dueDate: null, tags: ["Teams"], checklist: [], createdAt: now, position: -now });
    // Recheck after asynchronous writes while still inside the PG transaction;
    // an edit/revocation during creation rolls back the task and replay receipt.
    current();
    return taskId;
  });
  store.triage.decide(id, revision, "created", taskId);
  return { status: 200, data: { ok: true, taskId } };
}
