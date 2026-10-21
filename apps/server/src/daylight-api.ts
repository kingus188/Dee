import type { DaylightProject, DaylightTask, DaylightStatus } from "@assistant/contracts";
import type { DaylightStore } from "./daylight-store.js";
import { HttpError } from "./errors.js";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "请求必须包含任务或项目对象");
  return value as Record<string, unknown>;
}
export function daylightApi(store: DaylightStore, method: string, url: URL, body: Record<string, unknown>) {
  const path = url.pathname;
  if (!path.startsWith("/api/daylight")) return;
  if (method === "GET" && path === "/api/daylight") return { status: 200, data: store.snapshot() };
  if (method === "GET" && path === "/api/daylight/storage") return { status: 200, data: { location: store.location } };
  if (method !== "POST") return;
  try {
    switch (path) {
      case "/api/daylight/tasks/save": store.saveTask(record(body.task) as unknown as DaylightTask); break;
      case "/api/daylight/projects/save": store.saveProject(record(body.project) as unknown as DaylightProject); break;
      case "/api/daylight/tasks/move": store.moveTask(body.id as string, body.status as DaylightStatus, body.position as number | undefined); break;
      case "/api/daylight/tasks/delete": store.deleteTask(body.id as string); break;
      case "/api/daylight/projects/delete": store.deleteProject(body.id as string); break;
      default: return;
    }
    return { status: 200, data: { ok: true } };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && /无效|请选择|文本不能为空|备注含图片|日期格式|最多|子任务|任务已|项目已|所选项目/.test(error.message)) throw new HttpError(/已删除|已不存在/.test(error.message) ? 409 : 400, error.message);
    throw error;
  }
}
