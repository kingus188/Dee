import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DailyReport, DailyReportSummary } from "@assistant/contracts";
import { HttpError } from "./errors.js";

function validateDate(date: string) {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, "日报日期必须是有效的 YYYY-MM-DD");
  }
}

// 每次操作关闭连接，不依赖 Agent 生命周期，未配置模型也可使用。
export function createDailyReports(dataDir: string) {
  function withDatabase<T>(run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(join(dataDir, "agent.sqlite"));
    try {
      db.exec(`PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS daily_reports (
          date TEXT PRIMARY KEY, markdown TEXT NOT NULL,
          revision INTEGER NOT NULL, updatedAt TEXT NOT NULL)`);
      return run(db);
    } finally { db.close(); }
  }
  return {
    list(): DailyReportSummary[] {
      return withDatabase(db => db.prepare("SELECT date, revision, updatedAt FROM daily_reports ORDER BY date DESC").all() as DailyReportSummary[]);
    },
    get(date: string): DailyReport | null {
      validateDate(date);
      return withDatabase(db => db.prepare("SELECT * FROM daily_reports WHERE date = ?").get(date) as DailyReport | undefined ?? null);
    },
    save(date: string, input: Record<string, unknown>): DailyReport {
      validateDate(date);
      const { markdown, revision } = input;
      if (typeof markdown !== "string" || markdown.length > 16000) throw new HttpError(400, "日报内容必须是 Markdown 文本，最多 16000 字符");
      if (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)) throw new HttpError(400, "日报版本不合法，请重新读取");
      return withDatabase(db => {
        const updatedAt = new Date().toISOString();
        // 版本比较与写入在同一条 SQL 内完成，避免多个页面相互覆盖。
        const result = revision === null
          ? db.prepare("INSERT INTO daily_reports (date, markdown, revision, updatedAt) VALUES (?, ?, 1, ?) ON CONFLICT(date) DO NOTHING RETURNING *").get(date, markdown, updatedAt)
          : db.prepare("UPDATE daily_reports SET markdown = ?, revision = revision + 1, updatedAt = ? WHERE date = ? AND revision = ? RETURNING *").get(markdown, updatedAt, date, revision);
        if (!result) throw new HttpError(409, "这篇日报已在其他页面更新。请先复制当前内容，再重新读取后合并。");
        return result as DailyReport;
      });
    },
  };
}
