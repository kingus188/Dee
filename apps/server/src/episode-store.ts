import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EpisodeRow } from "@assistant/features";

const DAY = 86_400_000;
const FORGET_DAYS = 90; // 未被回想的摘要保留这么久
const FORGET_OPEN_DAYS = 180; // 带待跟进事项的摘要保留更久
const iso = (ms: number) => new Date(ms).toISOString();

export type NewEpisode = Omit<EpisodeRow, "level"> & { source: string; level?: 0 | 1 };
export type StoredEpisode = EpisodeRow & { id: string; source: string };

// 周一 00:00 所在日期，用于把同一周的摘要归到一起。
export function weekStart(isoTime: string) {
  const date = new Date(isoTime);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

// 情景摘要、遗忘与各来源的整理进度，与 Agent 同库（agent.sqlite）。
export function openEpisodeStore(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "agent.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, label TEXT NOT NULL, channel TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0,
        period_start TEXT NOT NULL, period_end TEXT NOT NULL, summary TEXT NOT NULL, open_items TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS episodes_source ON episodes (source, level, period_start);
      CREATE TABLE IF NOT EXISTS episode_cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL)`);
  } catch (error) { db.close(); throw error; }

  const insert = db.prepare("INSERT INTO episodes (id, source, label, channel, level, period_start, period_end, summary, open_items, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const row = (r: Record<string, unknown>): StoredEpisode => ({
    id: String(r.id), source: String(r.source), label: String(r.label), channel: String(r.channel), level: r.level === 1 ? 1 : 0,
    periodStart: String(r.period_start), periodEnd: String(r.period_end), summary: String(r.summary), openItems: JSON.parse(String(r.open_items)) as string[],
  });
  const add = (episode: NewEpisode) => {
    const now = iso(Date.now());
    insert.run(randomUUID(), episode.source, episode.label, episode.channel, episode.level ?? 0, episode.periodStart, episode.periodEnd, episode.summary, JSON.stringify(episode.openItems), now, now);
  };

  return {
    add,
    cursor: (source: string) => (db.prepare("SELECT cursor FROM episode_cursors WHERE source = ?").get(source) as { cursor: string } | undefined)?.cursor,
    setCursor(source: string, cursor: string) { db.prepare("INSERT INTO episode_cursors (source, cursor) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor").run(source, cursor); },
    // 命中的关键词越多越靠前；被回想到的摘要刷新最近使用时间，因此不会被遗忘。
    search(tokens: string[], limit: number): EpisodeRow[] {
      const like = tokens.map((token) => `%${token.replace(/[\\%_]/g, "\\$&")}%`);
      const hit = like.map(() => "(CASE WHEN lower(summary || ' ' || open_items || ' ' || label) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join(" + ");
      const rows = db.prepare(`SELECT *, ${hit} AS score FROM episodes WHERE score > 0 ORDER BY score DESC, period_end DESC LIMIT ?`).all(...like, limit).map(row);
      const touch = db.prepare("UPDATE episodes SET last_used_at = ? WHERE id = ?");
      for (const found of rows) touch.run(iso(Date.now()), found.id);
      return rows;
    },
    openItems(sinceDays: number, limit: number) {
      const rows = db.prepare("SELECT * FROM episodes WHERE open_items != '[]' AND period_end >= ? ORDER BY period_end DESC").all(iso(Date.now() - sinceDays * DAY)).map(row);
      return rows.flatMap((found) => found.openItems.map((text) => ({ label: found.label, text, at: found.periodEnd }))).slice(0, limit);
    },
    // 早于 before 的单次摘要里，同一来源同一周有两条以上的分组，等待合并为周摘要。
    rollupGroups(before: string): StoredEpisode[][] {
      const rows = db.prepare("SELECT * FROM episodes WHERE level = 0 AND period_end < ? ORDER BY period_start").all(before).map(row);
      const groups = new Map<string, StoredEpisode[]>();
      for (const found of rows) groups.set(`${found.source}|${weekStart(found.periodStart)}`, [...(groups.get(`${found.source}|${weekStart(found.periodStart)}`) ?? []), found]);
      return [...groups.values()].filter((group) => group.length > 1);
    },
    replaceWithRollup(ids: string[], merged: NewEpisode) {
      db.exec("BEGIN");
      try {
        add({ ...merged, level: 1 });
        const remove = db.prepare("DELETE FROM episodes WHERE id = ?");
        for (const id of ids) remove.run(id);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    forget(now = Date.now()) {
      return Number(db.prepare("DELETE FROM episodes WHERE last_used_at < ? OR (open_items = '[]' AND last_used_at < ?)").run(iso(now - FORGET_OPEN_DAYS * DAY), iso(now - FORGET_DAYS * DAY)).changes);
    },
    // 测试和排查用：直接设置最近使用时间。
    setLastUsed(id: string, at: string) { db.prepare("UPDATE episodes SET last_used_at = ? WHERE id = ?").run(at, id); },
    all: () => db.prepare("SELECT * FROM episodes ORDER BY period_start").all().map(row),
    close: () => db.close(),
  };
}
export type EpisodeStore = ReturnType<typeof openEpisodeStore>;
