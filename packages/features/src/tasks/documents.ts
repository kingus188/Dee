import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { CalendarRule, ExecutionRun } from "@assistant/contracts";
export type { ExecutionRun } from "@assistant/contracts";
export type Schedule = {
  id: string; text: string; nextAt: number | null; everyMinutes: number; runs: number;
  lastRunAt: number | null; status: "active" | "paused" | "cancelled" | "completed";
  revision: number; createdAt: number; jobId?: TaskId;
  calendar?: CalendarRule; daylightTaskId?: string;
};
export type BackgroundJob = {
  id: string; text: string; status: "running" | "cancelled" | "failed" | "done";
  conversationId: ConversationId | null; createdAt: number; result: string | null;
  taskId?: TaskId; finishedAt?: number; daylightTaskId?: string;
};
export type ScheduleInput = { scheduleId: string; text: string; at: number; revision: number };
export type ScheduleCheckpoint = { phase: "sleep" } | { phase: "fire" } | { phase: "deliver" } | { phase: "wait" };
export type BackgroundInput = { jobId: string; text: string };
export type BackgroundCheckpoint = { phase: "start" } | { phase: "wait"; childId: ConversationId } | { phase: "report"; summary: string; failed: boolean };

export const Schedules = defineDoc<{ items: Schedule[]; applied: Record<string, Schedule> }>({
  kind: "app.v3.schedules", version: 1, scope: "conversation", fork: "initial",
  // 旧版文档未设置 history；必须保留 undefined 才能重新打开已有 SQLite 数据。
  history: undefined as unknown as "latest",
  initial: () => ({ items: [], applied: {} }),
});
export const Parents = defineDoc<{ children: Record<string, ConversationId> }>({
  kind: "app.v3.parents", version: 1, scope: "session",
  initial: () => ({ children: {} }),
});
export const BackgroundJobs = defineDoc<{ items: BackgroundJob[]; applied: Record<string, BackgroundJob> }>({
  kind: "app.v3.background", version: 1, scope: "conversation", fork: "initial",
  history: undefined as unknown as "latest",
  initial: () => ({ items: [], applied: {} }),
});
export const Executions = defineDoc<{ items: ExecutionRun[] }>({
  kind: "app.executions", version: 1, scope: "conversation", fork: "initial", history: "latest",
  initial: () => ({ items: [] }),
});
