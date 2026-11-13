import type { Pool } from "pg";
import { type EditableNotes } from "@assistant/features";
import { HttpError } from "./errors.js";

export type PersonalNotes = EditableNotes & { revision: number };
export type LegacyNotes = { source: string; memos: string[] };
export interface NotesStore {
  get(): Promise<PersonalNotes>;
  edit(index: unknown, text: unknown, base: unknown): Promise<PersonalNotes>;
  importLegacy(sources: LegacyNotes[]): Promise<void>;
}

function revisionOf(base: unknown): number {
  if (!base || typeof base !== "object" || !("revision" in base) || !Number.isSafeInteger(base.revision) || Number(base.revision) < 0) {
    throw new HttpError(400, "笔记版本不合法，请重新读取");
  }
  return Number(base.revision);
}

/** Instance-wide personal notes live with business data, not a conversation or container. */
export async function createNotesStore(pool: Pool): Promise<NotesStore> {
  await pool.query(`CREATE TABLE IF NOT EXISTS personal_notes (
    id INTEGER PRIMARY KEY CHECK (id = 1), memos JSONB NOT NULL DEFAULT '[]', revision BIGINT NOT NULL DEFAULT 0);
    INSERT INTO personal_notes(id) VALUES (1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS personal_note_imports (source TEXT PRIMARY KEY)`);
  const row = 'memos, revision::double precision AS revision';
  const get = async (): Promise<PersonalNotes> => {
    const result = await pool.query<{ memos: string[]; revision: number }>(`SELECT ${row} FROM personal_notes WHERE id=1`);
    if (!result.rows[0]) throw new Error("个人笔记存储缺失");
    return { todos: [], ...result.rows[0] };
  };
  return {
    get,
    async edit(index, text, base) {
      const revision = revisionOf(base);
      if ((index !== null && (!Number.isSafeInteger(index) || Number(index) < 0)) || typeof text !== "string" || text.length > 16000 || !text.trim()) {
        throw new HttpError(400, "笔记索引或正文不合法，正文最多16000字符");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = (await client.query<{ memos: string[]; revision: number }>(`SELECT ${row} FROM personal_notes WHERE id=1 FOR UPDATE`)).rows[0];
        if (!current || current.revision !== revision) throw new HttpError(409, "笔记已被其他页面修改，请重新读取后合并");
        if (index === null) {
          if (current.memos.length >= 1000 || current.memos.reduce((sum, memo) => sum + memo.length, 0) + text.length > 128000) {
            throw new HttpError(400, "笔记总量已超过1000篇或128000字符，请先整理现有内容");
          }
          current.memos.push(text);
        } else {
          if (Number(index) >= current.memos.length) throw new HttpError(400, "笔记不存在，请重新读取");
          // Imported libraries can exceed today's creation quota. Existing notes stay editable.
          current.memos[Number(index)] = text;
        }
        const result = await client.query<{ memos: string[]; revision: number }>(`UPDATE personal_notes SET memos=$1::jsonb, revision=revision+1 WHERE id=1 RETURNING ${row}`, [JSON.stringify(current.memos)]);
        await client.query("COMMIT");
        return { todos: [], ...result.rows[0] };
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    },
    async importLegacy(sources) {
      if (!sources.length) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Serialize migration with saves and other starting instances. Append and markers are atomic.
        await client.query("SELECT id FROM personal_notes WHERE id=1 FOR UPDATE");
        for (const source of sources) {
          const imported = await client.query("SELECT 1 FROM personal_note_imports WHERE source=$1", [source.source]);
          if (imported.rowCount) continue;
          // Historical memo tools did not enforce editor limits; preserve their full text.
          if (!Array.isArray(source.memos) || source.memos.some(memo => typeof memo !== "string")) throw new Error("历史笔记格式不合法");
          const { memos } = source;
          if (memos.length) await client.query("UPDATE personal_notes SET memos=memos || $1::jsonb, revision=revision+1 WHERE id=1", [JSON.stringify(memos)]);
          await client.query("INSERT INTO personal_note_imports(source) VALUES ($1)", [source.source]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  };
}
