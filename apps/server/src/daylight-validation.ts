import { Buffer } from "node:buffer";
import type { DaylightProject, DaylightTask } from "@assistant/contracts";

export function validateDaylightId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error("无效的记录标识。");
}
function bounded(value: unknown, max: number, required: boolean) {
  if (typeof value !== "string" || [...value].length > max || (required && !value.trim())) throw new Error(`文本不能为空且不能超过 ${max} 字。`);
}
function color(value: unknown) {
  if (!["peach", "lavender", "mint", "sky", "rose"].includes(value as string)) throw new Error("请选择有效的颜色。");
}
export function validateDaylightStatus(value: unknown) {
  if (!["todo", "doing", "review", "done"].includes(value as string)) throw new Error("请选择有效的任务状态。");
}
export function validateDaylightPosition(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("无效的排序位置。");
}
export function validateDaylightProject(project: DaylightProject) {
  validateDaylightId(project.id); bounded(project.name, 60, true); bounded(project.description, 240, false); color(project.color);
}
export function validateDaylightTask(task: DaylightTask) {
  validateDaylightId(task.id); validateDaylightId(task.projectId); bounded(task.title, 160, true);
  if (typeof task.description !== "string" || Buffer.byteLength(task.description) > 8 * 1024 * 1024) throw new Error("备注含图片不能超过 8 MiB。");
  validateDaylightStatus(task.status); color(task.color);
  if (!["low", "medium", "high"].includes(task.priority)) throw new Error("请选择有效的优先级。");
  if (task.dueDate !== null) {
    if (typeof task.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) throw new Error("日期格式应为 YYYY-MM-DD。");
    const date = new Date(`${task.dueDate}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== task.dueDate) throw new Error("请选择有效的截止日期。");
  }
  if (!Array.isArray(task.tags) || task.tags.length > 8 || !Array.isArray(task.checklist) || task.checklist.length > 50) throw new Error("最多 8 个标签、50 个子任务。");
  for (const tag of task.tags) bounded(tag, 24, true);
  const ids = new Set<string>();
  for (const item of task.checklist) {
    if (!item || typeof item !== "object") throw new Error("无效的子任务。");
    bounded(item.id, 80, true); bounded(item.title, 160, true);
    if (typeof item.done !== "boolean" || ids.has(item.id)) throw new Error("子任务标识不能重复，完成状态必须为布尔值。");
    ids.add(item.id);
  }
  if (!Number.isSafeInteger(task.createdAt)) throw new Error("无效的创建时间。");
  validateDaylightPosition(task.position);
}
