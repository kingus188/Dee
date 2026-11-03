import { defineDoc, defineEntry } from "@earendil-works/pi-durable";

export const GoalReport = defineEntry<{ goalId: string; revision: number; text: string }>("app.goal-report");
import type { Goal, GoalCheckpoint } from "@assistant/contracts";

export const Goals = defineDoc<{ items: Goal[]; applied: Record<string, string> }>({
  kind: "app.personal-goals", version: 1, scope: "session",
  initial: () => ({ items: [], applied: {} }),
});
export const GoalWorker = defineDoc<{
  goalId: string; revision: number; round: number; checkpoint: GoalCheckpoint | null;
}>({
  kind: "app.goal-worker", version: 1, scope: "conversation", fork: "initial", history: "latest",
  initial: () => ({ goalId: "", revision: 0, round: 0, checkpoint: null }),
});

export const GOAL_TOKEN_LIMIT = 50_000;
export const GOAL_READ_TOOLS: ReadonlySet<string> = new Set([
  "fetch_page", "current_time", "search_knowledge", "read_knowledge", "search_materials", "read_materials",
  "recall", "teams_messages", "outlook_messages", "outlook_read", "list_projects", "list_tasks", "get_task", "read_skill",
]);
