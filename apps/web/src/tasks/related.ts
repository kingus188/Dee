import type { DaylightSnapshot, Management, ViewEntry } from "@assistant/contracts";
import type { ConversationCard } from "../chat/cards.js";

const taskTools = new Set(["create_task", "update_task", "mark_task", "mark_checklist_item", "get_task"]);
export const taskStatus = { todo: "待开始", doing: "进行中", review: "待验收", done: "已完成" };
export const taskPriority = { low: "低", medium: "中", high: "高" };
export const taskColor = { peach: "蜜桃", lavender: "淡紫", mint: "薄荷", sky: "蓝色", rose: "玫瑰" };

/** Only an explicit, successful task result or an existing execution link establishes context.
 * Global list/search results and text/title matches are deliberately not associations. */
export function relatedTaskIds(entries: ViewEntry[], management?: Management): string[] {
  const ids = new Set<string>();
  const calls = new Map<string, string>();
  for (const entry of entries) {
    for (const call of entry.toolCalls ?? []) calls.set(call.id, call.name);
    if (entry.kind !== "tool" || entry.isError || entry.error) continue;
    const name = entry.name ?? (entry.toolCallId ? calls.get(entry.toolCallId) : undefined);
    if (!name || !taskTools.has(name)) continue;
    try {
      const result: unknown = JSON.parse(entry.text);
      if (result && typeof result === "object" && "id" in result && "title" in result && "projectId" in result &&
          typeof result.id === "string" && result.id && typeof result.title === "string" && typeof result.projectId === "string") {
        // Put the task discussed most recently first without manufacturing update timestamps.
        ids.delete(result.id); ids.add(result.id);
      }
    } catch { /* Legacy todo results have no stable ID; never infer one from their text. */ }
  }
  const recent = [...ids].reverse();
  for (const item of [...management?.schedules ?? [], ...management?.background ?? [], ...management?.executions ?? []]) {
    if (item.daylightTaskId && !ids.has(item.daylightTaskId)) { ids.add(item.daylightTaskId); recent.push(item.daylightTaskId); }
  }
  return recent;
}

export function relatedTaskCards(ids: string[], snapshot: DaylightSnapshot): ConversationCard[] {
  return ids.map(id => {
    const task = snapshot.tasks.find(item => item.id === id);
    if (!task) return { key: "daylight:" + id, group: "tasks" as const, title: "关联待办不可用", text: "这条待办已删除或当前不可访问。", status: "不可用", tone: "error" as const,
      actions: [{ label: "查看全部待办", kind: "link" as const, href: "#tasks" }] };
    const project = snapshot.projects.find(item => item.id === task.projectId);
    return { key: "daylight:" + id, group: "tasks" as const, title: task.title, text: task.description,
      status: taskStatus[task.status], tone: task.status === "done" ? "done" as const : task.status === "review" ? "pending" as const : undefined,
      meta: [project?.name, task.dueDate ? "截止 " + task.dueDate : undefined].filter(Boolean).join(" · "),
      daylight: { task, project: project?.name }, actions: [{ label: "在待办中编辑", kind: "link" as const, href: `#tasks/${encodeURIComponent(task.id)}` }] };
  });
}
