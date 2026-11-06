import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EpisodeRow } from "@assistant/features";
import { createSourceLifecycle } from "./source-lifecycle.js";
import { episodeHasSensitiveData } from "./episode-privacy.js";

const DAY = 86_400_000;
const FORGET_DAYS = 90; // 未被回想的摘要保留这么久
const FORGET_OPEN_DAYS = 180; // 带待跟进事项的摘要保留更久
const iso = (ms: number) => new Date(ms).toISOString();

export type NewEpisode = Omit<EpisodeRow, "level"> & { source: string; level?: 0 | 1; sourceRevision?: number; messageIds?: string[] };
export type StoredEpisode = EpisodeRow & { id: string; source: string; sourceRevision: number; messageIds: string[] };

// 周一 00:00 所在日期，用于把同一周的摘要归到一起。
export function weekStart(isoTime: string) {
  const date = new Date(isoTime);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

// 情景摘要、遗忘与各来源的整理进度，与 Agent 同库（agent.sqlite）。
export function openEpisodeStore(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "agent.sqlite"));
  let sources: ReturnType<typeof createSourceLifecycle>;
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, label TEXT NOT NULL, channel TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0,
        period_start TEXT NOT NULL, period_end TEXT NOT NULL, summary TEXT NOT NULL, open_items TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS episodes_source ON episodes (source, level, period_start);
      CREATE TABLE IF NOT EXISTS episode_cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL)`);
    sources = createSourceLifecycle(db);
    const columns = db.prepare("PRAGMA table_info(episodes)").all() as { name: string }[];
    if (!columns.some(column => column.name === "source_revision")) db.exec("ALTER TABLE episodes ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0");
    if (!columns.some(column => column.name === "message_ids")) db.exec("ALTER TABLE episodes ADD COLUMN message_ids TEXT NOT NULL DEFAULT '[]'");
    db.exec(`CREATE TEMP VIEW active_episodes AS SELECT e.* FROM episodes e
      WHERE NOT EXISTS (SELECT 1 FROM source_lifecycle s WHERE s.source=e.source
        AND (s.revoked_at IS NOT NULL OR s.revision!=e.source_revision))`);
  } catch (error) { db.close(); throw error; }

  const insert = db.prepare("INSERT INTO episodes (id, source, label, channel, level, period_start, period_end, summary, open_items, created_at, last_used_at, source_revision, message_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const row = (r: Record<string, unknown>): StoredEpisode => ({
    id: String(r.id), source: String(r.source), label: String(r.label), channel: String(r.channel), level: r.level === 1 ? 1 : 0,
    sourceRevision: Number(r.source_revision), messageIds: JSON.parse(String(r.message_ids)) as string[],
    periodStart: String(r.period_start), periodEnd: String(r.period_end), summary: String(r.summary), openItems: JSON.parse(String(r.open_items)) as string[],
  });
  const safe = (episode: StoredEpisode) => !episodeHasSensitiveData([episode.label, episode.summary, ...episode.openItems].join("\n"));
  const add = (episode: NewEpisode) => {
    if (!sources.allowed(episode.source, episode.sourceRevision ?? 0, episode.messageIds)) return false;
    const now = iso(Date.now());
    insert.run(randomUUID(), episode.source, episode.label, episode.channel, episode.level ?? 0, episode.periodStart, episode.periodEnd, episode.summary, JSON.stringify(episode.openItems), now, now, episode.sourceRevision ?? 0, JSON.stringify(episode.messageIds ?? []));
    return true;
  };

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const setCursor = (source: string, cursor: string) => { db.prepare("INSERT INTO episode_cursors (source, cursor) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor").run(source, cursor); };
  return {
    add,
    sourceRevision: sources.revision,
    sourceAllowed: sources.allowed,
    revokeSource: sources.revoke,
    reconcileConversations(currentIds: number[]) {
      const live = new Set(currentIds.map(id => `conv:${id}`));
      return transaction(() => {
        let changed = 0;
        for (const item of db.prepare("SELECT DISTINCT source FROM episodes WHERE source LIKE 'conv:%' UNION SELECT source FROM episode_cursors WHERE source LIKE 'conv:%'").all()) {
          if (!live.has(String(item.source)) && sources.revoke(String(item.source))) changed++;
        }
        return changed;
      });
    },
    // A crash cannot save an episode without its collection cursor. A source
    // change while the model runs discards its result without advancing progress.
    commitBatch(episode: NewEpisode | null, source: string, cursor: string, revision: number, messageIds: string[] = [], expectedCursor?: string | null) {
      return transaction(() => {
        if (!sources.allowed(source, revision, messageIds)) return false;
        if (episode && episode.source !== source) return false;
        const current = db.prepare("SELECT cursor FROM episode_cursors WHERE source=?").get(source)?.cursor;
        if (current === cursor || (expectedCursor !== undefined && (current ?? null) !== expectedCursor)) return false;
        // Compatibility for callers without a collection snapshot: accept only
        // provably increasing native cursors, never regress an opaque cursor.
        if (expectedCursor === undefined && current !== undefined) {
          const old = String(current);
          const later = source.startsWith("conv:") && /^\d+$/.test(old) && /^\d+$/.test(cursor)
            ? BigInt(cursor) > BigInt(old)
            : source.startsWith("teams:") && Number.isFinite(Date.parse(old)) && Date.parse(cursor) > Date.parse(old);
          if (!later) return false;
        }
        if (episode && !add({ ...episode, sourceRevision: revision, messageIds })) return false;
        setCursor(source, cursor);
        return true;
      });
    },
    cursor: (source: string) => (db.prepare("SELECT cursor FROM episode_cursors WHERE source = ?").get(source) as { cursor: string } | undefined)?.cursor,
    setCursor,
    // 命中的关键词越多越靠前；被回想到的摘要刷新最近使用时间，因此不会被遗忘。
    search(tokens: string[], limit: number): EpisodeRow[] {
      const like = tokens.map((token) => `%${token.replace(/[\\%_]/g, "\\$&")}%`);
      const hit = like.map(() => "(CASE WHEN lower(summary || ' ' || open_items || ' ' || label) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join(" + ");
      const rows = db.prepare(`SELECT *, ${hit} AS score FROM active_episodes WHERE score > 0 ORDER BY score DESC, period_end DESC`).iterate(...like);
      const foundRows: StoredEpisode[] = [];
      for (const value of rows) { const found = row(value); if (safe(found)) foundRows.push(found); if (foundRows.length >= limit) break; }
      const touch = db.prepare("UPDATE episodes SET last_used_at = ? WHERE id = ?");
      for (const found of foundRows) touch.run(iso(Date.now()), found.id);
      return foundRows;
    },
    openItems(sinceDays: number, limit: number) {
      const rows = db.prepare("SELECT * FROM active_episodes WHERE open_items != '[]' AND period_end >= ? ORDER BY period_end DESC").all(iso(Date.now() - sinceDays * DAY)).map(row).filter(safe);
      return rows.flatMap((found) => found.openItems.map((text) => ({ label: found.label, text, at: found.periodEnd }))).slice(0, limit);
    },
    // 早于 before 的单次摘要里，同一来源同一周有两条以上的分组，等待合并为周摘要。
    rollupGroups(before: string): StoredEpisode[][] {
      const rows = db.prepare("SELECT * FROM active_episodes WHERE level = 0 AND period_end < ? ORDER BY period_start").all(before).map(row);
      const groups = new Map<string, StoredEpisode[]>();
      for (const found of rows) groups.set(`${found.source}|${weekStart(found.periodStart)}`, [...(groups.get(`${found.source}|${weekStart(found.periodStart)}`) ?? []), found]);
      return [...groups.values()].filter((group) => group.length > 1);
    },
    replaceWithRollup(ids: string[], merged: NewEpisode) {
      return transaction(() => {
        if (!ids.length) return false;
        const original = ids.map(id => db.prepare("SELECT * FROM active_episodes WHERE id=?").get(id)).filter(item => !!item).map(row);
        if (original.length !== ids.length || original.some(item => item.source !== merged.source)) return false;
        const revision = original[0].sourceRevision;
        const messageIds = [...new Set(original.flatMap(item => item.messageIds))];
        if (!add({ ...merged, level: 1, sourceRevision: revision, messageIds })) return false;
        const remove = db.prepare("DELETE FROM episodes WHERE id = ?");
        for (const id of ids) remove.run(id);
        return true;
      });
    },
    forget(now = Date.now()) {
      return Number(db.prepare("DELETE FROM episodes WHERE last_used_at < ? OR (open_items = '[]' AND last_used_at < ?)").run(iso(now - FORGET_OPEN_DAYS * DAY), iso(now - FORGET_DAYS * DAY)).changes);
    },
    // 测试和排查用：直接设置最近使用时间。
    setLastUsed(id: string, at: string) { db.prepare("UPDATE episodes SET last_used_at = ? WHERE id = ?").run(at, id); },
    all: () => db.prepare("SELECT * FROM active_episodes ORDER BY period_start").all().map(row),
    close: () => db.close(),
  };
}
export type EpisodeStore = ReturnType<typeof openEpisodeStore>;
