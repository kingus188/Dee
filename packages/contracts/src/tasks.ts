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
// revision 必须匹配当前计划；编辑先暂停、停止旧 job 再替换，失败时保留暂停状态。
export type ScheduleEditRequest = { text: string; minutesFromNow: number; everyMinutes?: number; revision: number };
// 提醒正文 1～1000 字，延迟 0.25～1440 分钟；requestId 最多 100 字。
export type ReminderRequest = { text: string; minutesFromNow: number; requestId?: string };
// at 必须匹配原提醒；编辑先取消并停止旧任务，再创建新 id；失败时旧项保持已取消。
export type ReminderEditRequest = { text: string; minutesFromNow: number; at: number };
