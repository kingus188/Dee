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
  return cards;
}
