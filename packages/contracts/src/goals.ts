export type GoalAction = "continue" | "wait" | "ask" | "complete" | "blocked";
export type GoalStatus = "running" | "waiting_time" | "waiting_user" | "blocked" | "review" | "completed" | "cancelled";
export type GoalCheckpoint = {
  action: GoalAction;
  summary: string;
  evidence: string[];
  nextAction?: string;
  wakeAt?: number;
};
export type Goal = {
  id: string;
  conversationId: number;
  text: string;
  criteria: string;
  status: GoalStatus;
  revision: number;
  round: number;
  usedTokens: number;
  workers: number[];
  maxRounds: number;
  deadlineAt: number;
  createdAt: number;
  updatedAt: number;
  summary: string;
  wakeAt: number | null;
  updates: string[];
  history: (GoalCheckpoint & { round: number; at: number })[];
  taskId?: number;
  workerConversationId?: number;
};
export type GoalRequest = {
  text: string;
  criteria: string;
  maxRounds?: number;
  maxMinutes?: number;
  requestId?: string;
};
export type GoalControlRequest = {
  revision: number;
  input?: string;
  requestId?: string;
};
