import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { DaylightPort, DaylightProject, DaylightStatus, DaylightTask, DaylightTaskPatch } from "@assistant/contracts";
import { validateDaylightId, validateDaylightPosition, validateDaylightProject, validateDaylightStatus, validateDaylightTask } from "./daylight-validation.js";

type Row = Record<string, unknown>;
export type DaylightImportResult = { projects: number; tasks: number };
export interface DaylightStore extends DaylightPort {
  readonly location: string;
  importSource(sourcePath: string): Promise<DaylightImportResult>;
}
const defaultProject: DaylightProject = { id: "00000000-0000-5000-8000-000000000001", name: "收件箱", description: "", color: "lavender" };
function stableId(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const projectFromRow = (r: Row): DaylightProject => ({ id: String(r.id), name: String(r.name), description: String(r.description), color: r.color as DaylightProject["color"] });
const taskFromRow = (r: Row): DaylightTask => ({ id: String(r.id), projectId: String(r.project_id), title: String(r.title), description: String(r.description), status: r.status as DaylightStatus, priority: r.priority as DaylightTask["priority"], color: r.color as DaylightTask["color"], dueDate: r.due_date as string | null, tags: JSON.parse(String(r.tags)), checklist: JSON.parse(String(r.checklist)), createdAt: Number(r.created_at), position: Number(r.position) });
const taskValues = (t: DaylightTask) => [t.id, t.projectId, t.title, t.description, t.status, t.priority, t.color, t.dueDate, JSON.stringify(t.tags), JSON.stringify(t.checklist), t.createdAt, t.position];
const insertTask = `INSERT INTO daylight_tasks(id,project_id,title,description,status,priority,color,due_date,tags,checklist,created_at,position,deleted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;

/** The pool is application-owned. SQLite is opened only as a read-only migration source. */
export async function openDaylightStore(pool: Pool): Promise<DaylightStore> {
  await pool.query(`CREATE TABLE IF NOT EXISTS daylight_projects(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,color TEXT NOT NULL,deleted_at BIGINT,ordinal BIGSERIAL UNIQUE);
    CREATE TABLE IF NOT EXISTS daylight_tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES daylight_projects(id),title TEXT NOT NULL,description TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('todo','doing','review','done')),priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
    color TEXT NOT NULL,due_date TEXT,tags TEXT NOT NULL CHECK(jsonb_typeof(tags::jsonb)='array'),checklist TEXT NOT NULL CHECK(jsonb_typeof(checklist::jsonb)='array'),created_at BIGINT NOT NULL,deleted_at BIGINT,position DOUBLE PRECISION NOT NULL);
    CREATE INDEX IF NOT EXISTS daylight_tasks_project ON daylight_tasks(project_id);
    CREATE TABLE IF NOT EXISTS daylight_imports(source TEXT PRIMARY KEY,imported_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS daylight_actions(key TEXT PRIMARY KEY,result TEXT NOT NULL CHECK(jsonb_typeof(result::jsonb)='object'));`);

  async function transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // One mutation lock also serializes read/modify/write patches and project deletion.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':daylight:mutations',0))");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  function bound(client: PoolClient): DaylightPort {
    async function runImport(key: string, action: () => Promise<DaylightImportResult>): Promise<DaylightImportResult> {
      if ((await client.query("SELECT 1 FROM daylight_imports WHERE source=$1", [key])).rowCount) return { projects: 0, tasks: 0 };
      const result = await action();
      await client.query("INSERT INTO daylight_imports(source,imported_at) VALUES ($1,$2)", [key, Date.now()]);
      return result;
    }
    const port: DaylightPort = {
      async snapshot() {
        const projects = await client.query("SELECT * FROM daylight_projects WHERE deleted_at IS NULL ORDER BY ordinal");
        const tasks = await client.query("SELECT * FROM daylight_tasks WHERE deleted_at IS NULL AND project_id IN (SELECT id FROM daylight_projects WHERE deleted_at IS NULL) ORDER BY position,created_at DESC,id");
        return { projects: projects.rows.map(projectFromRow), tasks: tasks.rows.map(taskFromRow) };
      },
      async getTask(id) {
        validateDaylightId(id);
        const { rows } = await client.query("SELECT * FROM daylight_tasks WHERE id=$1 AND deleted_at IS NULL AND project_id IN (SELECT id FROM daylight_projects WHERE deleted_at IS NULL)", [id]);
        if (!rows[0]) throw new Error("任务已不存在，请刷新后重试。");
        return taskFromRow(rows[0]);
      },
      async saveProject(project) {
        validateDaylightProject(project);
        const result = await client.query(`INSERT INTO daylight_projects(id,name,description,color) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,color=excluded.color WHERE daylight_projects.deleted_at IS NULL`, [project.id, project.name.trim(), project.description.trim(), project.color]);
        if (!result.rowCount) throw new Error("项目已删除，请刷新后重试。");
      },
      async saveTask(task) {
        validateDaylightTask(task);
        if (!(await client.query("SELECT 1 FROM daylight_projects WHERE id=$1 AND deleted_at IS NULL", [task.projectId])).rowCount) throw new Error("所选项目已不存在，请重新选择。");
        const result = await client.query(`${insertTask} ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,description=excluded.description,status=excluded.status,priority=excluded.priority,color=excluded.color,due_date=excluded.due_date,tags=excluded.tags,checklist=excluded.checklist WHERE daylight_tasks.deleted_at IS NULL`, [...taskValues({ ...task, title: task.title.trim(), description: task.description.trim() }), null]);
        if (!result.rowCount) throw new Error("任务已删除，请刷新后重试。");
      },
      async patchTask(id: string, patch: DaylightTaskPatch) {
        const allowed = ["projectId", "title", "description", "status", "priority", "color", "dueDate", "tags", "checklist", "position"];
        if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key => !allowed.includes(key))) throw new Error("无效的任务修改字段。");
        const next = { ...await port.getTask(id), ...patch };
        await port.saveTask(next);
        if (patch.position !== undefined) await client.query("UPDATE daylight_tasks SET position=$1 WHERE id=$2", [next.position, id]);
        return port.getTask(id);
      },
      async moveTask(id: string, status: DaylightStatus, position?: number) {
        validateDaylightStatus(status); if (position !== undefined) validateDaylightPosition(position);
        await port.patchTask(id, { status, ...(position === undefined ? {} : { position }) });
      },
      async deleteTask(id) {
        validateDaylightId(id);
        await client.query("UPDATE daylight_tasks SET deleted_at=$1 WHERE id=$2 AND deleted_at IS NULL", [Date.now(), id]);
      },
      async deleteProject(id) {
        validateDaylightId(id);
        const now = Date.now();
        await client.query("UPDATE daylight_tasks SET deleted_at=$1 WHERE project_id=$2 AND deleted_at IS NULL", [now, id]);
        await client.query("UPDATE daylight_projects SET deleted_at=$1 WHERE id=$2 AND deleted_at IS NULL", [now, id]);
      },
      async ensureDefaultProject() {
        const { rows } = await client.query("SELECT * FROM daylight_projects WHERE id=$1", [defaultProject.id]);
        if (rows[0]) {
          if (rows[0].deleted_at !== null) throw new Error("收件箱已删除，请选择现有项目。");
          return projectFromRow(rows[0]);
        }
        await port.saveProject(defaultProject); return { ...defaultProject };
      },
      async importLegacy(conversationId, todos) {
        if (!Number.isSafeInteger(conversationId) || conversationId < 0) throw new Error("无效的会话标识。");
        return runImport(`legacy:${conversationId}`, async () => {
          if (!Array.isArray(todos) || todos.some(todo => !todo || typeof todo.text !== "string" || typeof todo.done !== "boolean")) throw new Error("无效的历史待办。");
          if (!todos.length) return { projects: 0, tasks: 0 };
          const id = stableId(`legacy-project:${conversationId}`);
          const inserted = await client.query("INSERT INTO daylight_projects(id,name,description,color) VALUES ($1,$2,$3,'lavender') ON CONFLICT DO NOTHING", [id, `历史待办 · ${conversationId}`, "从原待办列表迁入"]);
          const parent = (await client.query("SELECT deleted_at FROM daylight_projects WHERE id=$1", [id])).rows[0];
          let tasks = 0;
          for (const [index, todo] of todos.entries()) {
            const task: DaylightTask = { id: stableId(`legacy-task:${conversationId}:${index}`), projectId: id, title: [...todo.text.trim()].slice(0, 160).join("") || "未命名待办", description: todo.text, status: todo.done ? "done" : "todo", priority: "medium", color: "lavender", dueDate: null, tags: [], checklist: [], createdAt: 0, position: index };
            validateDaylightTask(task);
            tasks += (await client.query(`${insertTask} ON CONFLICT DO NOTHING`, [...taskValues(task), parent.deleted_at])).rowCount ?? 0;
          }
          return { projects: inserted.rowCount ?? 0, tasks };
        });
      },
      async replayAction<T>(key: string, action: (port: DaylightPort) => Promise<T>): Promise<T> {
        if (!key.trim()) throw new Error("重放标识不能为空。");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':daylight:action:' || $1,0))", [key]);
        const { rows } = await client.query("SELECT result FROM daylight_actions WHERE key=$1", [key]);
        if (rows[0]) return JSON.parse(String(rows[0].result)).value as T;
        const value = await action(port);
        await client.query("INSERT INTO daylight_actions(key,result) VALUES ($1,$2)", [key, JSON.stringify({ value })]);
        return value;
      },
    };
    return port;
  }
  const port: DaylightPort = {
    snapshot: () => transaction(c => bound(c).snapshot()),
    getTask: id => transaction(c => bound(c).getTask(id)),
    saveTask: task => transaction(c => bound(c).saveTask(task)),
    saveProject: project => transaction(c => bound(c).saveProject(project)),
    patchTask: (id, patch) => transaction(c => bound(c).patchTask(id, patch)),
    moveTask: (id, status, position) => transaction(c => bound(c).moveTask(id, status, position)),
    deleteTask: id => transaction(c => bound(c).deleteTask(id)),
    deleteProject: id => transaction(c => bound(c).deleteProject(id)),
    ensureDefaultProject: () => transaction(c => bound(c).ensureDefaultProject()),
    importLegacy: (id, todos) => transaction(c => bound(c).importLegacy(id, todos)),
    replayAction: (key, action) => transaction(c => bound(c).replayAction(key, action)),
  };
  return {
    ...port, location: "PostgreSQL · Daylight",
    async importSource(sourcePath) {
      const canonical = realpathSync(sourcePath);
      if ((await pool.query("SELECT 1 FROM daylight_imports WHERE source=$1", [`sqlite:${canonical}`])).rowCount) return { projects: 0, tasks: 0 };
      const source = new DatabaseSync(canonical, { readOnly: true });
      let projects: Row[], tasks: Row[], imports: Row[], actions: Row[];
      try {
        source.exec("PRAGMA query_only=ON; BEGIN");
        const version = Number(source.prepare("PRAGMA user_version").get()!.user_version);
        if (![0, 1, 2, 3].includes(version)) throw new Error("仅支持 Daylight 数据库版本 0–3。");
        const modern = version === 0 || version >= 2;
        projects = source.prepare(`SELECT id,name,description,color,${modern ? "deleted_at" : "NULL AS deleted_at"} FROM projects ORDER BY rowid`).all();
        tasks = source.prepare(`SELECT *,${!modern ? "NULL AS deleted_at," : ""}${version === 0 || version >= 3 ? "position AS position" : "-created_at AS position"} FROM tasks ORDER BY rowid`).all();
        const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        imports = tables.has("daylight_imports") ? source.prepare("SELECT source,imported_at FROM daylight_imports").all() : [];
        actions = tables.has("daylight_actions") ? source.prepare("SELECT key,result FROM daylight_actions").all() : [];
        source.exec("COMMIT");
      } finally { source.close(); }
      return transaction(async client => {
        const marker = `sqlite:${canonical}`;
        if ((await client.query("SELECT 1 FROM daylight_imports WHERE source=$1", [marker])).rowCount) return { projects: 0, tasks: 0 };
        let projectCount = 0, taskCount = 0;
        const collision = () => new Error("源 Daylight 数据与现有记录冲突，导入已回滚。");
        for (const row of projects) {
          const project = projectFromRow(row); validateDaylightProject(project);
          const existing = (await client.query("SELECT * FROM daylight_projects WHERE id=$1", [project.id])).rows[0];
          if (existing) {
            if (!isDeepStrictEqual(projectFromRow(existing), project) || Number(existing.deleted_at) !== Number(row.deleted_at) || (existing.deleted_at === null) !== (row.deleted_at === null)) throw collision();
          } else {
            await client.query("INSERT INTO daylight_projects(id,name,description,color,deleted_at) VALUES ($1,$2,$3,$4,$5)", [project.id, project.name, project.description, project.color, row.deleted_at]); projectCount++;
          }
        }
        for (const row of tasks) {
          const task = taskFromRow(row); validateDaylightTask(task);
          const parent = (await client.query("SELECT deleted_at FROM daylight_projects WHERE id=$1", [task.projectId])).rows[0];
          if (!parent) throw new Error("源任务引用了不存在的项目。");
          const deletedAt = row.deleted_at ?? null;
          const existing = (await client.query("SELECT * FROM daylight_tasks WHERE id=$1", [task.id])).rows[0];
          if (existing) {
            if (!isDeepStrictEqual(taskFromRow(existing), task) || Number(existing.deleted_at) !== Number(deletedAt) || (existing.deleted_at === null) !== (deletedAt === null)) throw collision();
          } else { await client.query(insertTask, [...taskValues(task), deletedAt]); taskCount++; }
        }
        for (const row of imports) {
          const existing = (await client.query("SELECT imported_at FROM daylight_imports WHERE source=$1", [row.source])).rows[0];
          if (existing) { if (Number(existing.imported_at) !== Number(row.imported_at)) throw collision(); }
          else await client.query("INSERT INTO daylight_imports(source,imported_at) VALUES ($1,$2)", [row.source, row.imported_at]);
        }
        for (const row of actions) {
          const result = JSON.parse(String(row.result));
          const existing = (await client.query("SELECT result FROM daylight_actions WHERE key=$1", [row.key])).rows[0];
          if (existing) { if (!isDeepStrictEqual(JSON.parse(String(existing.result)), result)) throw collision(); }
          else await client.query("INSERT INTO daylight_actions(key,result) VALUES ($1,$2)", [row.key, JSON.stringify(result)]);
        }
        await client.query("INSERT INTO daylight_imports(source,imported_at) VALUES ($1,$2) ON CONFLICT DO NOTHING", [marker, Date.now()]);
        return { projects: projectCount, tasks: taskCount };
      });
    },
  };
}
