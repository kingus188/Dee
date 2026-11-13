import type { Management } from "@assistant/contracts";
import type { ConversationCard, CardAction } from "../chat/cards.js";
import { fmt } from "../ui/elements.js";

export function managementCards(data: Management, conversationId: string): ConversationCard[] {
  const base = "/api/conversations/" + encodeURIComponent(conversationId);
  const cards: ConversationCard[] = [];
  for (const item of data.schedules) {
    const path = base + "/schedules/" + encodeURIComponent(item.id);
    const actions: CardAction[] = [];
    if (item.status === "active") actions.push({ label: "暂停", kind: "request", path: path + "/pause" });
    if (item.status === "paused") actions.push({ label: "继续", kind: "request", path: path + "/resume" });
    if (item.status === "active" || item.status === "paused") actions.push({ label: "取消计划", kind: "request", path: path + "/cancel" });
    const status = { active: "已安排", paused: "已暂停", cancelled: "已取消", completed: "已完成", failed: "执行失败" }[item.status];
    cards.push({
      key: "schedule:" + item.id, group: "tasks", title: "计划任务", text: item.text, status,
      tone: item.status === "failed" ? "error" : item.status === "completed" ? "done" : undefined,
      meta: [item.status === "active" && item.nextAt ? "下次执行：" + fmt(item.nextAt) : item.status === "paused" ? "暂停期间不会执行" : status,
        item.calendar ? `${item.calendar.kind === "daily" ? "每天" : item.calendar.kind === "weekly" ? "每周 " + item.calendar.weekdays.map(day => ["", "一", "二", "三", "四", "五", "六", "日"][day]).join("、") : "每月 " + item.calendar.monthDay + " 日"} ${item.calendar.time} · ${item.calendar.timeZone}` : item.everyMinutes ? `每隔 ${item.everyMinutes} 分钟重复` : "仅执行一次", `已触发 ${item.runs} 次`].join(" · "), actions,
    });
  }
  for (const item of data.reminders) {
    cards.push({
      key: "reminder:" + item.id, group: "tasks", title: "提醒", text: item.text,
      status: { scheduled: "等待提醒", cancelled: "已取消", fired: "已触发" }[item.status],
      meta: fmt(item.at), tone: item.status === "fired" ? "done" : undefined,
      actions: item.status === "scheduled" ? [{ label: "取消提醒", kind: "request", path: base + "/reminders/" + item.id + "/cancel" }] : [],
    });
  }
  for (const item of data.background) {
    const actions: CardAction[] = [];
    if (item.status === "running") actions.push({ label: "停止任务", kind: "request", path: base + "/background/" + encodeURIComponent(item.id) + "/stop" });
    cards.push({
      key: "background:" + item.id, group: "tasks", title: "后台任务", text: item.text,
      status: { running: "进行中", cancelled: "已停止", failed: "执行失败", done: "已完成" }[item.status],
      tone: item.status === "failed" ? "error" : item.status === "done" ? "done" : undefined,
      meta: "开始于 " + fmt(item.createdAt), details: item.result || undefined, actions,
    });
  }
  for (const goal of data.goals ?? []) {
    const status = { running: "自主执行中", waiting_time: "等待唤醒", waiting_user: "等待你补充", blocked: "执行受阻", review: "待验收", completed: "已完成", cancelled: "已取消" }[goal.status];
    const actions: CardAction[] = [];
    if (goal.status === "review") actions.push({ label: "确认完成", kind: "request", path: `/api/goals/${goal.id}/accept`, body: { revision: goal.revision } });
    if (goal.status !== "completed" && goal.status !== "cancelled") actions.push({ label: "取消委托", kind: "request", path: `/api/goals/${goal.id}/cancel`, body: { revision: goal.revision } });
    cards.push({
      key: "goal:" + goal.id, group: "tasks", title: "个人委托", text: goal.text + "\n\n验收标准：" + goal.criteria,
      status, tone: goal.status === "blocked" ? "error" : goal.status === "completed" ? "done" : "pending",
      meta: `${goal.round}/${goal.maxRounds} 轮 · ${goal.usedTokens} Tokens` + (goal.wakeAt ? " · 唤醒：" + fmt(goal.wakeAt) : "") + (goal.status === "waiting_user" ? " · 请在聊天中补充信息以继续" : ""),
      details: [goal.summary, ...goal.history.map(step => `第 ${step.round} 轮：${step.summary}\n${step.evidence.join("\n")}`)].join("\n\n"), actions,
    });
  }
  for (const run of data.runs ?? []) {
    let card = cards.find(item => item.key === `${run.source}:${run.taskId}`);
    if (!card && run.source === "delegate") {
      card = { key: `delegate:${run.taskId}`, group: "tasks", title: "子 Agent 任务", text: run.text, actions: [] };
      cards.push(card);
    }
    if (card) (card.runs ??= []).push(run);
  }
  return cards;
}
