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
/** Synchronous port: mutations and replay results commit in one SQLite transaction. */
export interface DaylightPort {
  snapshot(): DaylightSnapshot;
  getTask(id: string): DaylightTask;
  saveTask(task: DaylightTask): void;
  saveProject(project: DaylightProject): void;
  moveTask(id: string, status: DaylightStatus, position?: number): void;
  deleteTask(id: string): void;
  deleteProject(id: string): void;
  patchTask(id: string, patch: DaylightTaskPatch): DaylightTask;
  ensureDefaultProject(): DaylightProject;
  importLegacy(conversationId: number, todos: readonly { text: string; done: boolean }[]): { projects: number; tasks: number };
  replayAction<T>(key: string, action: () => T): T;
}
