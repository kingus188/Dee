export type Schedule = {
  id: string; text: string; nextAt: number | null; everyMinutes: number; runs: number;
  lastRunAt: number | null; status: "active" | "paused" | "cancelled" | "completed" | "failed";
  revision: number; createdAt: number; jobId?: number;
};
export type BackgroundJob = {
  id: string; text: string; status: "running" | "cancelled" | "failed" | "done";
  conversationId: number | null; createdAt: number; result: string | null; taskId?: number; finishedAt?: number;
};
export type Reminder = { id: number; text: string; at: number; status: "scheduled" | "cancelled" | "fired" };
export type Management = { schedules: Schedule[]; background: BackgroundJob[]; reminders: Reminder[] };
export type ScheduleRequest = { text: string; minutesFromNow: number; everyMinutes?: number; requestId?: string };
export type BackgroundRequest = { text: string; requestId?: string };
