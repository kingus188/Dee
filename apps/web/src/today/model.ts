import type { DaylightSnapshot, WorkspaceActivity } from "@assistant/contracts";
import { isOverdue, localDate } from "../daylight/domain/todo.js";

export type ActivityFilter = "pending" | "running" | "failed" | "ended" | "all";
export const activityFilters: { id: ActivityFilter; label: string }[] = [
  { id: "pending", label: "待处理" }, { id: "running", label: "执行中" },
  { id: "failed", label: "执行失败" }, { id: "ended", label: "已结束" }, { id: "all", label: "全部" },
];

export function matchesActivityFilter(activity: WorkspaceActivity, filter: ActivityFilter): boolean {
  return filter === "all" || (filter === "failed" ? activity.status === "failed" : activityPhase(activity) === filter);
}

export function selectTodayTasks(snapshot: DaylightSnapshot, today = localDate()) {
  const open = snapshot.tasks.filter(task => task.status !== "done");
  const due = open.filter(task => task.dueDate === today || isOverdue(task, today)).sort((a, b) =>
    (a.dueDate ?? "").localeCompare(b.dueDate ?? "") || a.position - b.position);
  return {
    due,
    overdue: due.filter(task => isOverdue(task, today)).length,
    today: due.filter(task => task.dueDate === today).length,
    doing: open.filter(task => task.status === "doing").length,
    review: open.filter(task => task.status === "review").length,
  };
}

export function activityPhase(activity: WorkspaceActivity): "pending" | "running" | "ended" | "unknown" {
  if (activity.status === "running") return "running";
  if (["scheduled", "active", "paused"].includes(activity.status)) return "pending";
  if (["fired", "done", "completed", "failed", "cancelled"].includes(activity.status)) return "ended";
  return "unknown";
}

export function activityKey(activity: WorkspaceActivity): string {
  return `${activity.conversationId}:${activity.kind}:${activity.id}`;
}

export function activityKind(activity: WorkspaceActivity): string {
  return { reminder: "提醒", schedule: "计划", background: "后台任务" }[activity.kind];
}

export function activityStatus(activity: WorkspaceActivity): string {
  if (activity.status === "cancelled" && activity.kind === "background") return "已停止";
  const labels: Record<string, string> = {
    scheduled: "等待提醒", fired: "已触发", active: "已安排", paused: "已暂停",
    running: "执行中", done: "已完成", completed: "已完成", failed: "执行失败", cancelled: "已取消",
  };
  return labels[activity.status] ?? activity.status;
}

export function dateTime(value: number | string | null): string {
  if (value === null) return "时间未提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间格式异常";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", year: "numeric", hour12: false });
}

export function activityTime(activity: WorkspaceActivity): { label: string; value: number | null } {
  if (activity.kind === "background") return { label: "开始于", value: activity.createdAt };
  if (activity.kind === "reminder") return { label: "提醒时间", value: activity.at };
  return { label: activity.at === null ? "创建于" : "计划时间", value: activity.at ?? activity.createdAt };
}

export function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return "夜深了，给今天留一点从容。";
  if (hour < 12) return "早上好，从眼前的一件事开始。";
  if (hour < 18) return "下午好，接着推进重要的事。";
  return "晚上好，看看今天的进展。";
}
