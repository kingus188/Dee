import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentActivity, DesktopAgentSnapshot, ExternalAgentState } from "@assistant/contracts";
import { object } from "./types.js";

export type StoredAgentSession = {
  id: string; binding: string; nativeId?: string; status: ExternalAgentState["status"];
  messages: DesktopAgentSnapshot["messages"]; activities: AgentActivity[]; error?: string;
  requests?: Record<string, { status: "running" | "done" | "failed" | "cancelled" | "interrupted" }>;
};
export function openAgentSessionStore(directory: string) {
  const path = join(directory, "external-agent-sessions.json");
  let sessions: StoredAgentSession[] = [], error: string | undefined;
  if (existsSync(path)) {
    try {
      if (statSync(path).size > 20 * 1024 * 1024) throw new Error("历史记录过大");
      const saved = object(JSON.parse(readFileSync(path, "utf8")));
      if (saved.version !== 1 || !Array.isArray(saved.sessions)) throw new Error("格式无效");
      for (const value of saved.sessions) {
        const item = object(value);
        if (typeof item.id !== "string" || typeof item.binding !== "string" || (item.nativeId !== undefined && typeof item.nativeId !== "string") || !["idle", "running", "waiting", "done", "failed", "cancelled", "interrupted"].includes(String(item.status)) || !Array.isArray(item.messages) || !Array.isArray(item.activities) || (item.error !== undefined && typeof item.error !== "string")) throw new Error("会话格式无效");
        for (const message of item.messages) if (!message || typeof message.id !== "string" || !["user", "assistant"].includes(message.role) || typeof message.text !== "string") throw new Error("消息格式无效");
        for (const activity of item.activities) if (!activity || typeof activity.id !== "string" || typeof activity.title !== "string" || !["running", "done", "failed"].includes(activity.status) || (activity.detail !== undefined && typeof activity.detail !== "string")) throw new Error("活动格式无效");
        if (item.requests !== undefined && (!item.requests || typeof item.requests !== "object" || Array.isArray(item.requests) || Object.values(item.requests).some(request => !request || typeof request !== "object" || !["running", "done", "failed", "cancelled", "interrupted"].includes(String((request as { status?: unknown }).status))))) throw new Error("请求记录无效");
      }
      sessions = saved.sessions as StoredAgentSession[];
      for (const session of sessions) if (["running", "waiting"].includes(session.status)) { session.status = "interrupted"; session.error = "上次执行已中断，结果尚未确认。请核对后发送新消息继续；不会自动重放。"; }
      for (const session of sessions) for (const request of Object.values(session.requests ?? {})) if (request.status === "running") request.status = "interrupted";
    } catch { error = "外部 Agent 会话记录无法读取，原文件已保留；请修复后重启"; }
  }
  function persist() {
    if (error) throw new Error(error);
    const content = JSON.stringify({ version: 1, sessions });
    if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new Error("外部 Agent 历史记录超过 20 MiB，请先归档记录");
    writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  return {
    get error() { return error; },
    history() {
      if (error) throw new Error(error);
      return sessions.map(session => ({ sessionId: session.id, agent: object(JSON.parse(session.binding)).kind as "codex" | "claude" | "acp", messages: session.messages.map(message => ({ ...message })) }));
    },
    get(binding: string) { return sessions.findLast(session => session.binding === binding); },
    byId(id: string) { if (error) throw new Error(error); return sessions.find(session => session.id === id); },
    list() { if (error) throw new Error(error); return structuredClone(sessions).map(session => ({ ...session, agent: object(JSON.parse(session.binding)).kind as "codex" | "claude" | "acp" })); },
    create(binding: string) {
      if (error) throw new Error(error);
      const session: StoredAgentSession = { id: randomUUID(), binding, status: "idle", messages: [], activities: [] };
      sessions.push(session);
      try { persist(); } catch (cause) { sessions.pop(); throw cause; }
      return session;
    },
    persist,
  };
}
