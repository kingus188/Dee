import type { DaylightTask } from "@assistant/contracts";

export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isOverdue(task: DaylightTask, today = localDate()): boolean {
  return task.status !== "done" && !!task.dueDate && task.dueDate < today;
}
