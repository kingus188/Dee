import type { DaylightPort, DaylightProject, DaylightSnapshot } from "@assistant/contracts";
import type { DaylightStore } from "../dist/daylight-store.js";

/** Deterministic transactional fake for API tests; not a PostgreSQL substitute. */
export function triageTestPort(): DaylightStore {
  let state: DaylightSnapshot = { projects: [], tasks: [] }, queue = Promise.resolve();
  const receipts = new Map<string, unknown>();
  const project: DaylightProject = { id: "00000000-0000-5000-8000-000000000001", name: "收件箱", description: "", color: "lavender" };
  const port: DaylightStore = {
    location: "test double", importSource: async () => ({ tasks: 0, projects: 0 }),
    snapshot: async () => structuredClone(state),
    getTask: async id => { const task = state.tasks.find(t => t.id === id); if (!task) throw Error("任务已不存在"); return structuredClone(task); },
    saveTask: async task => { const at = state.tasks.findIndex(t => t.id === task.id); if (at < 0) state.tasks.push(structuredClone(task)); else state.tasks[at] = structuredClone(task); },
    saveProject: async value => { if (!state.projects.some(p => p.id === value.id)) state.projects.push(value); },
    ensureDefaultProject: async () => { await port.saveProject(project); return project; },
    patchTask: async (id, patch) => { const task = { ...await port.getTask(id), ...patch }; await port.saveTask(task); return task; },
    moveTask: async (id, status) => { await port.patchTask(id, { status }); },
    deleteTask: async id => { state.tasks = state.tasks.filter(t => t.id !== id); },
    deleteProject: async id => { state.projects = state.projects.filter(p => p.id !== id); },
    importLegacy: async () => ({ tasks: 0, projects: 0 }),
    replayAction<T>(key: string, action: (tx: DaylightPort) => Promise<T>): Promise<T> {
      const result = queue.then(async () => {
        if (receipts.has(key)) return structuredClone(receipts.get(key)) as T;
        const before = structuredClone(state);
        try { const value = await action(port); receipts.set(key, structuredClone(value)); return value; }
        catch (error) { state = before; throw error; }
      });
      queue = result.then(() => {}, () => {});
      return result;
    },
  };
  return port;
}
