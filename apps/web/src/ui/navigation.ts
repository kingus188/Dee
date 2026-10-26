import type { CardGroup } from "../chat/cards.js";

export type WorkspacePage = "home" | "chat" | "daylight" | "activity" | "data" | "reports" | "settings";
export type WorkspaceRoute = { page: WorkspacePage; group: CardGroup | null; conversationId?: number; taskId?: string };
const groups: Record<string, CardGroup> = { memory: "memory", skills: "skills", notes: "notes", schedules: "tasks" };

export function readWorkspaceRoute(hash: string): WorkspaceRoute {
  const [name, rawId, extra] = hash.replace(/^#\/?/, "").split("/");
  if (name === "tasks" && rawId && extra === undefined) {
    try {
      const taskId = decodeURIComponent(rawId);
      if (taskId.trim() && taskId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(taskId)) return { page: "daylight", group: null, taskId };
    } catch { /* Malformed task links fall back to the task workspace. */ }
  }
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : undefined;
  const conversationId = id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  if (Object.hasOwn(groups, name)) return { page: "data", group: groups[name], conversationId };
  const pages: Record<string, WorkspacePage> = { today: "home", chat: "chat", tasks: "daylight", activity: "activity", reports: "reports", settings: "settings" };
  const page = Object.hasOwn(pages, name) ? pages[name] : undefined;
  return page ? { page, group: null, ...(page === "chat" ? { conversationId } : {}) } : { page: "home", group: null };
}

export function workspaceHash(route: WorkspaceRoute): string {
  const name = route.page === "data" ? route.group === "tasks" ? "schedules" : route.group ?? "memory" : route.page === "home" ? "today" : route.page === "daylight" ? "tasks" : route.page;
  if (route.page === "daylight" && route.taskId) return `#tasks/${encodeURIComponent(route.taskId)}`;
  return `#${name}${route.conversationId && (route.page === "chat" || (route.page === "data" && ["tasks", "notes"].includes(route.group ?? ""))) ? `/${route.conversationId}` : ""}`;
}
