import type { CardGroup } from "../chat/cards.js";

export type WorkspacePage = "home" | "chat" | "teams" | "daylight" | "activity" | "data" | "reports" | "settings";
export type WorkspaceRoute = { page: WorkspacePage; group: CardGroup | null; conversationId?: number; chatId?: string; taskId?: string; skillSource?: "remote"; execution?: "local" | "server" };
const groups: Record<string, CardGroup> = { memory: "memory", skills: "skills", notes: "notes", schedules: "tasks" };

export function readWorkspaceRoute(hash: string): WorkspaceRoute {
  if (!hash || hash === "#" || hash === "#/") return { page: "chat", group: null };
  const [name, rawId, extra] = hash.replace(/^#\/?/, "").split("/");
  if (name === "skills" && rawId === "remote" && extra === undefined) return { page: "data", group: "skills", skillSource: "remote" };
  if (name === "tasks" && rawId && extra === undefined) {
    try {
      const taskId = decodeURIComponent(rawId);
      if (taskId.trim() && taskId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(taskId)) return { page: "daylight", group: null, taskId };
    } catch { /* Malformed task links fall back to the task workspace. */ }
  }
  if (name === "teams") {
    if (rawId && extra === undefined) {
      try {
        const chatId = decodeURIComponent(rawId);
        if (chatId.trim() && chatId.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(chatId)) return { page: "teams", group: null, chatId };
      } catch { /* Malformed Teams links fall back to the conversation list. */ }
    }
    return { page: "teams", group: null };
  }
  if (name === "chat" && rawId === "local" && extra === undefined) return { page: "chat", group: null, execution: "local" };
  const id = rawId && /^\d+$/.test(rawId) ? Number(rawId) : undefined;
  const conversationId = id !== undefined && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  if (name === "notes") return { page: "data", group: "notes" };
  if (Object.hasOwn(groups, name)) return { page: "data", group: groups[name], conversationId };
  const pages: Record<string, WorkspacePage> = { today: "home", chat: "chat", tasks: "daylight", activity: "activity", reports: "reports", settings: "settings" };
  const page = Object.hasOwn(pages, name) ? pages[name] : undefined;
  return page ? { page, group: null, ...(page === "chat" ? { conversationId } : {}) } : { page: "home", group: null };
}

export function workspaceHash(route: WorkspaceRoute): string {
  if (route.page === "chat" && route.execution === "local") return "#chat/local";
  if (route.page === "data" && route.group === "skills" && route.skillSource === "remote") return "#skills/remote";
  const name = route.page === "data" ? route.group === "tasks" ? "schedules" : route.group ?? "memory" : route.page === "home" ? "today" : route.page === "daylight" ? "tasks" : route.page;
  if (route.page === "teams" && route.chatId) return `#teams/${encodeURIComponent(route.chatId)}`;
  if (route.page === "daylight" && route.taskId) return `#tasks/${encodeURIComponent(route.taskId)}`;
  return `#${name}${route.conversationId && (route.page === "chat" || (route.page === "data" && route.group === "tasks")) ? `/${route.conversationId}` : ""}`;
}
