export type DaylightStatus = "todo" | "doing" | "review" | "done";
export type DaylightColor = "peach" | "lavender" | "mint" | "sky" | "rose";
export type DaylightPriority = "low" | "medium" | "high";
export interface DaylightProject { id: string; name: string; description: string; color: DaylightColor }
export interface DaylightChecklistItem { id: string; title: string; done: boolean }
export interface DaylightTask {
  id: string; projectId: string; title: string; description: string;
  status: DaylightStatus; priority: DaylightPriority; color: DaylightColor;
  dueDate: string | null; tags: string[]; checklist: DaylightChecklistItem[];
  createdAt: number; position: number;
}
export interface DaylightSnapshot { projects: DaylightProject[]; tasks: DaylightTask[] }
export type DaylightTaskPatch = Partial<Omit<DaylightTask, "id" | "createdAt">>;
/** Async port; replay callbacks use the supplied transaction-bound port. */
export interface DaylightPort {
  snapshot(): Promise<DaylightSnapshot>;
  getTask(id: string): Promise<DaylightTask>;
  saveTask(task: DaylightTask): Promise<void>;
  saveProject(project: DaylightProject): Promise<void>;
  moveTask(id: string, status: DaylightStatus, position?: number): Promise<void>;
  deleteTask(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  patchTask(id: string, patch: DaylightTaskPatch): Promise<DaylightTask>;
  ensureDefaultProject(): Promise<DaylightProject>;
  importLegacy(conversationId: number, todos: readonly { text: string; done: boolean }[]): Promise<{ projects: number; tasks: number }>;
  replayAction<T>(key: string, action: (port: DaylightPort) => Promise<T>): Promise<T>;
}
