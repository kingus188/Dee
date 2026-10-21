import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaylightPort, DaylightProject, DaylightSnapshot, DaylightStatus, DaylightTask, DaylightTaskPatch } from "@assistant/contracts";
import { validateDaylightId, validateDaylightPosition, validateDaylightProject, validateDaylightStatus, validateDaylightTask } from "./daylight-validation.js";

type Row = Record<string, unknown>;
type ImportResult = { projects: number; tasks: number };
export interface DaylightStore extends DaylightPort {
  readonly location: string;
  importSource(sourcePath: string): ImportResult;
  close(): void;
}
const defaultProject: DaylightProject = { id: "00000000-0000-5000-8000-000000000001", name: "收件箱", description: "", color: "lavender" };
function stableId(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const projectFromRow = (r: Row): DaylightProject => ({ id: String(r.id), name: String(r.name), description: String(r.description), color: r.color as DaylightProject["color"] });
const taskFromRow = (r: Row): DaylightTask => ({ id: String(r.id), projectId: String(r.project_id), title: String(r.title), description: String(r.description), status: r.status as DaylightStatus, priority: r.priority as DaylightTask["priority"], color: r.color as DaylightTask["color"], dueDate: r.due_date as string | null, tags: JSON.parse(String(r.tags)), checklist: JSON.parse(String(r.checklist)), createdAt: Number(r.created_at), position: Number(r.position) });

/** Dedicated database: source user_version never shares migrations with agent.sqlite. */
export function openDaylightStore(dataDir: string): DaylightStore {
  mkdirSync(dataDir, { recursive: true });
  const location = join(dataDir, "daylight.sqlite");
  const db = new DatabaseSync(location);
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,color TEXT NOT NULL,deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),title TEXT NOT NULL,description TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('todo','doing','review','done')),priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
        color TEXT NOT NULL,due_date TEXT,tags TEXT NOT NULL CHECK(json_valid(tags)),checklist TEXT NOT NULL CHECK(json_valid(checklist)),created_at INTEGER NOT NULL,deleted_at INTEGER,position REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
      CREATE TABLE IF NOT EXISTS daylight_imports(source TEXT PRIMARY KEY,imported_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS daylight_actions(key TEXT PRIMARY KEY,result TEXT NOT NULL);`);
  } catch (error) { db.close(); throw error; }
  let transactionDepth = 0;
  function transaction<T>(action: () => T): T {
    if (transactionDepth) return action();
    db.exec("BEGIN IMMEDIATE");
    transactionDepth++;
    try {
      const result = action();
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") throw new Error("Daylight transactions require synchronous callbacks.");
      db.exec("COMMIT"); return result;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { transactionDepth--; }
  }
  const insertProject = db.prepare("INSERT OR IGNORE INTO projects(id,name,description,color,deleted_at) VALUES (?,?,?,?,?)");
  const insertTask = db.prepare("INSERT OR IGNORE INTO tasks(id,project_id,title,description,status,priority,color,due_date,tags,checklist,created_at,position,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const taskValues = (task: DaylightTask) => [task.id, task.projectId, task.title, task.description, task.status, task.priority, task.color, task.dueDate, JSON.stringify(task.tags), JSON.stringify(task.checklist), task.createdAt, task.position];
  function getTask(id: string): DaylightTask {
    validateDaylightId(id);
    const row = db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)").get(id);
    if (!row) throw new Error("任务已不存在，请刷新后重试。");
    return taskFromRow(row);
  }
  function saveProject(project: DaylightProject) {
    validateDaylightProject(project);
    const result = db.prepare(`INSERT INTO projects(id,name,description,color) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,color=excluded.color WHERE projects.deleted_at IS NULL`)
      .run(project.id, project.name.trim(), project.description.trim(), project.color);
    if (!result.changes) throw new Error("项目已删除，请刷新后重试。");
  }
  function saveTask(task: DaylightTask) {
    validateDaylightTask(task);
    transaction(() => {
      if (!db.prepare("SELECT 1 FROM projects WHERE id=? AND deleted_at IS NULL").get(task.projectId)) throw new Error("所选项目已不存在，请重新选择。");
      const result = db.prepare(`INSERT INTO tasks(id,project_id,title,description,status,priority,color,due_date,tags,checklist,created_at,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,description=excluded.description,status=excluded.status,priority=excluded.priority,color=excluded.color,due_date=excluded.due_date,tags=excluded.tags,checklist=excluded.checklist WHERE tasks.deleted_at IS NULL`)
        .run(...taskValues({ ...task, title: task.title.trim(), description: task.description.trim() }));
      if (!result.changes) throw new Error("任务已删除，请刷新后重试。");
    });
  }
  function patchTask(id: string, patch: DaylightTaskPatch): DaylightTask {
    const allowed = ["projectId", "title", "description", "status", "priority", "color", "dueDate", "tags", "checklist", "position"];
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error("无效的任务修改字段。");
    return transaction(() => {
      const current = getTask(id);
      const next = { ...current, ...patch };
      saveTask(next);
      if (patch.position !== undefined) db.prepare("UPDATE tasks SET position=? WHERE id=?").run(next.position, id);
      return getTask(id);
    });
  }
  function runImport(key: string, action: () => ImportResult): ImportResult {
    return transaction(() => {
      if (db.prepare("SELECT 1 FROM daylight_imports WHERE source=?").get(key)) return { projects: 0, tasks: 0 };
      const result = action();
      db.prepare("INSERT INTO daylight_imports(source,imported_at) VALUES (?,?)").run(key, Date.now());
      return result;
    });
  }
  const store = {
    location,
    snapshot(): DaylightSnapshot {
      return transaction(() => ({ projects: db.prepare("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY rowid").all().map(projectFromRow), tasks: db.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL) ORDER BY position,created_at DESC,id").all().map(taskFromRow) }));
    },
    getTask, saveTask, saveProject, patchTask,
    moveTask(id: string, status: DaylightStatus, position?: number) {
      validateDaylightStatus(status); if (position !== undefined) validateDaylightPosition(position);
      patchTask(id, { status, ...(position === undefined ? {} : { position }) });
    },
    deleteTask(id: string) {
      validateDaylightId(id); db.prepare("UPDATE tasks SET deleted_at=? WHERE id=? AND deleted_at IS NULL").run(Date.now(), id);
    },
    deleteProject(id: string) {
      validateDaylightId(id);
      transaction(() => {
        const now = Date.now();
        db.prepare("UPDATE tasks SET deleted_at=? WHERE project_id=? AND deleted_at IS NULL").run(now, id);
        db.prepare("UPDATE projects SET deleted_at=? WHERE id=? AND deleted_at IS NULL").run(now, id);
      });
    },
    ensureDefaultProject(): DaylightProject {
      return transaction(() => {
        const existing = db.prepare("SELECT * FROM projects WHERE id=?").get(defaultProject.id);
        if (existing) {
          if (existing.deleted_at !== null) throw new Error("收件箱已删除，请选择现有项目。");
          return projectFromRow(existing);
        }
        saveProject(defaultProject); return { ...defaultProject };
      });
    },
    importSource(sourcePath: string): ImportResult {
      const canonical = realpathSync(sourcePath);
      if (canonical === realpathSync(location)) throw new Error("不能从当前 Daylight 数据库导入。");
      const source = new DatabaseSync(canonical, { readOnly: true });
      try {
        source.exec("PRAGMA query_only=ON; BEGIN");
        const version = Number(source.prepare("PRAGMA user_version").get()!.user_version);
        if (![1, 2, 3].includes(version)) throw new Error("仅支持 Daylight 数据库版本 1–3。");
        const projects = source.prepare(`SELECT id,name,description,color,${version >= 2 ? "deleted_at" : "NULL AS deleted_at"} FROM projects ORDER BY rowid`).all();
        const tasks = source.prepare(`SELECT *,${version < 2 ? "NULL AS deleted_at," : ""}${version < 3 ? "-created_at AS position" : "position AS position"} FROM tasks ORDER BY rowid`).all();
        const result = runImport(`sqlite:${canonical}`, () => {
          let projectCount = 0; let taskCount = 0;
          for (const row of projects) {
            const project = projectFromRow(row); validateDaylightProject(project);
            projectCount += Number(insertProject.run(project.id, project.name, project.description, project.color, row.deleted_at as number | null).changes);
          }
          for (const row of tasks) {
            const task = taskFromRow(row); validateDaylightTask(task);
            const parent = db.prepare("SELECT deleted_at FROM projects WHERE id=?").get(task.projectId);
            if (!parent) throw new Error("源任务引用了不存在的项目。");
            const deletedAt = row.deleted_at ?? parent.deleted_at ?? null;
            taskCount += Number(insertTask.run(...taskValues(task), deletedAt as number | null).changes);
          }
          return { projects: projectCount, tasks: taskCount };
        });
        source.exec("COMMIT"); return result;
      } finally { source.close(); }
    },
    importLegacy(conversationId: number, todos: readonly { text: string; done: boolean }[]): ImportResult {
      if (!Number.isSafeInteger(conversationId) || conversationId < 0) throw new Error("无效的会话标识。");
      return runImport(`legacy:${conversationId}`, () => {
        if (!Array.isArray(todos) || todos.some(todo => !todo || typeof todo.text !== "string" || typeof todo.done !== "boolean")) throw new Error("无效的历史待办。");
        if (!todos.length) return { projects: 0, tasks: 0 };
        const id = stableId(`legacy-project:${conversationId}`);
        const projects = Number(insertProject.run(id, `历史待办 · ${conversationId}`, "从原待办列表迁入", "lavender", null).changes);
        const parent = db.prepare("SELECT deleted_at FROM projects WHERE id=?").get(id)!;
        let tasks = 0;
        for (const [index, todo] of todos.entries()) {
          const task: DaylightTask = { id: stableId(`legacy-task:${conversationId}:${index}`), projectId: id, title: [...todo.text.trim()].slice(0, 160).join("") || "未命名待办", description: todo.text, status: todo.done ? "done" : "todo", priority: "medium", color: "lavender", dueDate: null, tags: [], checklist: [], createdAt: 0, position: index };
          validateDaylightTask(task);
          tasks += Number(insertTask.run(...taskValues(task), parent.deleted_at as number | null).changes);
        }
        return { projects, tasks };
      });
    },
    replayAction<T>(key: string, action: () => T): T {
      if (!key.trim()) throw new Error("重放标识不能为空。");
      return transaction(() => {
        const existing = db.prepare("SELECT result FROM daylight_actions WHERE key=?").get(key);
        if (existing) return JSON.parse(String(existing.result)).value as T;
        const value = action();
        if (value && (typeof value === "object" || typeof value === "function") && "then" in value && typeof value.then === "function") throw new Error("Daylight replay requires a synchronous callback.");
        db.prepare("INSERT INTO daylight_actions(key,result) VALUES (?,?)").run(key, JSON.stringify({ value }));
        return value;
      });
    },
    close() { db.close(); },
  } satisfies DaylightStore;
  return store;
}
