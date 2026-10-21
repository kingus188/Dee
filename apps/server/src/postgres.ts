import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";

/** One shared pool for business data; Durable conversations keep their SQLite store. */
export async function openBusinessDatabase(connectionString: string, dataDir: string, testMode = false): Promise<Pool> {
  if (!connectionString) throw new Error("待办与日报需要配置 DATABASE_URL（PostgreSQL）。");
  // Tests reconnect to the same fixture schema after restart, without sharing business rows.
  const schema = testMode
    ? `test_${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 24)}`
    : "assistant";
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000, statement_timeout: 30000, options: `-c search_path=${schema},public` });
  pool.on("error", () => console.error("PostgreSQL 空闲连接中断；后续请求将重新建立连接。"));
  try {
    // schema is an internally generated identifier, never a user-supplied SQL fragment.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    return pool;
  } catch {
    await pool.end();
    throw new Error("无法连接业务 PostgreSQL 数据库；请检查 DATABASE_URL、网络及数据库权限。");
  }
}
