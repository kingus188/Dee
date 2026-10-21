import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";
import type { DailyReport, DailyReportSummary } from "@assistant/contracts";
import { HttpError } from "./errors.js";

export interface DailyReports {
  list(): Promise<DailyReportSummary[]>;
  get(date: string): Promise<DailyReport | null>;
  save(date: string, input: Record<string, unknown>): Promise<DailyReport>;
  importSource(sourcePath: string): Promise<{ reports: number }>;
}

function validateDate(date: string) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, "日报日期必须是有效的 YYYY-MM-DD");
  }
}

// 业务数据库由应用管理；未配置模型也可使用。
export async function createDailyReports(pool: Pool): Promise<DailyReports> {
  // Keep timestamps as text: callers and imported reports retain their exact ISO strings.
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_reports (
    date TEXT PRIMARY KEY, markdown TEXT NOT NULL,
    revision BIGINT NOT NULL, "updatedAt" TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS daily_report_imports (source TEXT PRIMARY KEY, imported_at BIGINT NOT NULL)`);
  return {
    async list() {
      const result = await pool.query<DailyReportSummary>('SELECT date, revision::double precision AS revision, "updatedAt" FROM daily_reports ORDER BY date DESC');
      return result.rows;
    },
    async get(date) {
      validateDate(date);
      const result = await pool.query<DailyReport>('SELECT date, markdown, revision::double precision AS revision, "updatedAt" FROM daily_reports WHERE date = $1', [date]);
      return result.rows[0] ?? null;
    },
    async save(date, input) {
      validateDate(date);
      const { markdown, revision } = input;
      if (typeof markdown !== "string" || markdown.length > 16000) throw new HttpError(400, "日报内容必须是 Markdown 文本，最多 16000 字符");
      if (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) throw new HttpError(400, "日报版本不合法，请重新读取");
      const updatedAt = new Date().toISOString();
      // 版本比较与写入在同一条 SQL 内完成，避免多个页面相互覆盖。
      const result = revision === null
        ? await pool.query<DailyReport>('INSERT INTO daily_reports (date, markdown, revision, "updatedAt") VALUES ($1, $2, 1, $3) ON CONFLICT(date) DO NOTHING RETURNING date, markdown, revision::double precision AS revision, "updatedAt"', [date, markdown, updatedAt])
        : await pool.query<DailyReport>('UPDATE daily_reports SET markdown = $1, revision = revision + 1, "updatedAt" = $2 WHERE date = $3 AND revision = $4 RETURNING date, markdown, revision::double precision AS revision, "updatedAt"', [markdown, updatedAt, date, revision]);
      if (!result.rows[0]) throw new HttpError(409, "这篇日报已在其他页面更新。请先复制当前内容，再重新读取后合并。");
      return result.rows[0];
    },
    async importSource(sourcePath) {
      const source = realpathSync(sourcePath);
      if ((await pool.query("SELECT 1 FROM daily_report_imports WHERE source = $1", [source])).rowCount) return { reports: 0 };
      const db = new DatabaseSync(source, { readOnly: true });
      let reports: DailyReport[];
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_reports'").get()) return { reports: 0 };
        reports = db.prepare("SELECT date, markdown, revision, updatedAt FROM daily_reports ORDER BY date").all() as unknown as DailyReport[];
      } finally { db.close(); }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize imports of the same source without sharing Daylight's marker namespace.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('daily_report_imports'), hashtext($1))", [source]);
        if ((await client.query("SELECT 1 FROM daily_report_imports WHERE source = $1", [source])).rowCount) {
          await client.query("COMMIT");
          return { reports: 0 };
        }
        for (const report of reports) {
          const result = await client.query(`INSERT INTO daily_reports (date, markdown, revision, "updatedAt") VALUES ($1, $2, $3, $4)
            ON CONFLICT(date) DO UPDATE SET date = daily_reports.date
            WHERE daily_reports.markdown = EXCLUDED.markdown AND daily_reports.revision = EXCLUDED.revision AND daily_reports."updatedAt" = EXCLUDED."updatedAt"
            RETURNING date`, [report.date, report.markdown, report.revision, report.updatedAt]);
          if (!result.rowCount) throw new Error(`日报导入冲突：${report.date}`);
        }
        await client.query("INSERT INTO daily_report_imports (source, imported_at) VALUES ($1, $2)", [source, Date.now()]);
        await client.query("COMMIT");
        return { reports: reports.length };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  };
}
