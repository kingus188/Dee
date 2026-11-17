import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeEpisodeTimeQuery, verifiedSummaryRecordedAt, sourceTimeRange, verifiedSourceTimeRange, type EpisodeTimeQuery, type EpisodeRow, type EpisodeRecord } from "@assistant/features";
import { createSourceLifecycle } from "./source-lifecycle.js";
import { episodeHasSensitiveData } from "./episode-privacy.js";

const DAY = 86_400_000;
const FORGET_DAYS = 90; // 未被回想的摘要保留这么久
const FORGET_OPEN_DAYS = 180; // 带待跟进事项的摘要保留更久
const iso = (ms: number) => new Date(ms).toISOString();

export type NewEpisode = Omit<EpisodeRow, "level"> & { source: string; level?: 0 | 1; sourceRevision?: number; messageIds?: string[]; sourceTimeVerified?: boolean };
export type StoredEpisode = EpisodeRecord;
export type EpisodeCursor = { score: number; periodEnd: string; id: string };
export type EpisodePage = { items: StoredEpisode[]; next?: EpisodeCursor; scanned: number };

// 周一 00:00 所在日期，用于把同一周的摘要归到一起。
export function weekStart(isoTime: string) {
  const date = new Date(isoTime);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

// 情景摘要、遗忘与各来源的整理进度，与 Agent 同库（agent.sqlite）。
export function openEpisodeStore(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "agent.sqlite"));
  db.function("episode_recorded_time", { deterministic: true }, value => verifiedSummaryRecordedAt(value) ?? null);
  let sources: ReturnType<typeof createSourceLifecycle>;
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, label TEXT NOT NULL, channel TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0,
        period_start TEXT NOT NULL, period_end TEXT NOT NULL, summary TEXT NOT NULL, open_items TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, last_used_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS episodes_source ON episodes (source, level, period_start);
      CREATE TABLE IF NOT EXISTS episode_cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS episodes_recent ON episodes(period_end DESC, id ASC)");
    sources = createSourceLifecycle(db);
    db.exec("BEGIN IMMEDIATE");
    const columns = db.prepare("PRAGMA table_info(episodes)").all() as { name: string }[];
    if (!columns.some(column => column.name === "source_revision")) db.exec("ALTER TABLE episodes ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0");
    if (!columns.some(column => column.name === "message_ids")) db.exec("ALTER TABLE episodes ADD COLUMN message_ids TEXT NOT NULL DEFAULT '[]'");
    if (!columns.some(column => column.name === "source_time_verified")) db.exec("ALTER TABLE episodes ADD COLUMN source_time_verified INTEGER NOT NULL DEFAULT 0");
    // Preserve legacy search-based retention timestamps without labeling them as explicit reads.
    if (!columns.some(column => column.name === "last_exposed_at")) db.exec("ALTER TABLE episodes ADD COLUMN last_exposed_at TEXT");
    if (!columns.some(column => column.name === "last_read_at")) db.exec("ALTER TABLE episodes ADD COLUMN last_read_at TEXT");
    if (!columns.some(column => column.name === "read_retired_through")) db.exec("ALTER TABLE episodes ADD COLUMN read_retired_through INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE TABLE IF NOT EXISTS episode_reads (
      episode_id TEXT NOT NULL, revision INTEGER NOT NULL, caller_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL, call_id TEXT NOT NULL, observed_at TEXT NOT NULL,
      PRIMARY KEY (episode_id, revision, caller_id, task_id, call_id));
      CREATE TRIGGER IF NOT EXISTS episode_reads_cleanup AFTER DELETE ON episodes
      BEGIN DELETE FROM episode_reads WHERE episode_id=OLD.id; END`);
    db.exec("COMMIT");
    db.exec(`CREATE TEMP VIEW active_episodes AS SELECT e.* FROM episodes e
      WHERE NOT EXISTS (SELECT 1 FROM source_lifecycle s WHERE s.source=e.source
        AND (s.revoked_at IS NOT NULL OR s.revision!=e.source_revision))`);
  } catch (error) { db.close(); throw error; }

  const insert = db.prepare("INSERT INTO episodes (id, source, label, channel, level, period_start, period_end, summary, open_items, created_at, last_used_at, source_revision, message_ids, source_time_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const row = (r: Record<string, unknown>): StoredEpisode => ({
    id: String(r.id), source: String(r.source), label: String(r.label), channel: String(r.channel), level: r.level === 1 ? 1 : 0,
    sourceRevision: Number(r.source_revision), messageIds: JSON.parse(String(r.message_ids)) as string[],
    sourceTimeVerified: r.source_time_verified === 1, summaryRecordedAt: verifiedSummaryRecordedAt(r.created_at),
    periodStart: String(r.period_start), periodEnd: String(r.period_end), summary: String(r.summary), openItems: JSON.parse(String(r.open_items)) as string[],
  });
  const safe = (episode: StoredEpisode) => sources.allowed(episode.source, episode.sourceRevision, episode.messageIds) && !episodeHasSensitiveData([episode.label, episode.summary, ...episode.openItems].join("\n"));
  const add = (episode: NewEpisode) => {
    if (episode.sourceTimeVerified && !verifiedSourceTimeRange(episode)) return false;
    if (!sources.allowed(episode.source, episode.sourceRevision ?? 0, episode.messageIds)) return false;
    const now = iso(Date.now());
    insert.run(randomUUID(), episode.source, episode.label, episode.channel, episode.level ?? 0, episode.periodStart, episode.periodEnd, episode.summary, JSON.stringify(episode.openItems), now, now, episode.sourceRevision ?? 0, JSON.stringify(episode.messageIds ?? []), episode.sourceTimeVerified ? 1 : 0);
    return true;
  };

  function transaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const setCursor = (source: string, cursor: string) => { db.prepare("INSERT INTO episode_cursors (source, cursor) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor").run(source, cursor); };
  // LIMIT bounds materialized candidates, not SQLite's scoring/sort work.
  // Keyset pagination preserves older matches and has an explicit unique tie-break.
  function candidates(tokens: string[] | undefined, sinceDays: number | undefined, limit: number, cursor?: EpisodeCursor, time?: EpisodeTimeQuery): EpisodePage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 80) throw new Error("候选页大小应为1～80");
    if (tokens && (!tokens.length || tokens.length > 8 || tokens.some(token => token.length > 200))) return { items: [], scanned: 0 };
    const like = tokens?.map(token => `%${token.replace(/[\\%_]/g, "\\$&")}%`) ?? [];
    const score = like.length ? like.map(() => "(CASE WHEN lower(summary || ' ' || open_items || ' ' || label) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)").join(" + ") : "0";
    const { sourceBefore, summaryRecordedBefore } = normalizeEpisodeTimeQuery(time);
    const temporal = sourceBefore ? "AND source_time_verified = 1 AND julianday(period_start) <= julianday(period_end) AND julianday(period_end) <= julianday(?)" : "";
    const recorded = summaryRecordedBefore ? "AND episode_recorded_time(created_at) <= ?" : "";
    const after = cursor ? "AND (score < ? OR (score = ? AND (period_end < ? OR (period_end = ? AND id > ?))))" : "";
    const found = db.prepare(`WITH ranked AS (SELECT *, ${score} AS score FROM episodes)
      SELECT * FROM ranked WHERE ${tokens ? "score > 0" : "open_items != '[]' AND period_end >= ?"} ${temporal} ${recorded} ${after}
      ORDER BY score DESC, period_end DESC, id ASC LIMIT ?`).all(...like, ...(tokens ? [] : [iso(Date.now() - sinceDays! * DAY)]),
        ...(sourceBefore ? [sourceBefore] : []), ...(summaryRecordedBefore ? [summaryRecordedBefore] : []), ...(cursor ? [cursor.score, cursor.score, cursor.periodEnd, cursor.periodEnd, cursor.id] : []), limit + 1);
    const page = found.slice(0, limit), last = page.at(-1);
    return { items: page.map(row).filter(safe), scanned: page.length,
      ...(found.length > limit && last ? { next: { score: Number(last.score), periodEnd: String(last.period_end), id: String(last.id) } } : {}) };
  }
  // Legacy callers expect local privacy filtering before their result limit.
  // Preserve that contract without restoring an unbounded scan of denied rows.
  function safeCandidates(tokens: string[] | undefined, sinceDays: number | undefined, limit: number) {
    if (limit <= 0) return [];
    if (!Number.isSafeInteger(limit)) throw new Error("候选数量必须是整数");
    const target = Math.min(limit, 80), found: StoredEpisode[] = [];
    let cursor: EpisodeCursor | undefined, count = 0;
    for (let batch = 0; batch < 8; batch++) {
      const page = candidates(tokens, sinceDays, 10, cursor);
      found.push(...page.items);
      count += page.items.reduce((sum, item) => sum + (tokens ? 1 : item.openItems.length), 0);
      cursor = page.next;
      if (!cursor || count >= target) break;
    }
    return found;
  }
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
    peek(id: string) {
      const value = db.prepare("SELECT * FROM active_episodes WHERE id=?").get(id);
      const found = value ? row(value) : undefined;
      return found && safe(found) ? found : undefined;
    },
    expose(id: string, expectedRevision: number) {
      return transaction(() => {
        const value = db.prepare("SELECT * FROM active_episodes WHERE id=?").get(id);
        if (!value) return;
        const found = row(value);
        if (!safe(found) || found.sourceRevision !== expectedRevision) return;
        db.prepare("UPDATE episodes SET last_exposed_at=? WHERE id=?").run(iso(Date.now()), id);
        return found;
      });
    },
    read(id: string, expectedRevision?: number, call?: { callerId: number; taskId: number; callId: string }) {
      return transaction(() => {
        const value = db.prepare("SELECT * FROM active_episodes WHERE id=?").get(id);
        if (!value) return;
        const found = row(value);
        if (!safe(found) || (expectedRevision !== undefined && expectedRevision !== found.sourceRevision)) return;
        found.readEvidence = { kind: "explicit_read", status: "unverified" };
        // Retired identities stay behind a durable watermark. A late first read
        // outside this bounded window may return content, but never renew retention.
        if (call && Number.isSafeInteger(call.callerId) && call.callerId > 0
          && Number.isSafeInteger(call.taskId) && call.taskId > 0
          && typeof call.callId === "string" && call.callId.length > 0 && Buffer.byteLength(call.callId, "utf8") <= 256) {
          if (call.taskId <= Number(value.read_retired_through)) {
            found.readEvidence.status = "outside_window";
            return found;
          }
          const now = iso(Date.now());
          const recorded = db.prepare(`INSERT OR IGNORE INTO episode_reads
            (episode_id,revision,caller_id,task_id,call_id,observed_at) VALUES (?,?,?,?,?,?)`)
            .run(id, found.sourceRevision, call.callerId, call.taskId, call.callId, now);
          const evidence = db.prepare("SELECT observed_at FROM episode_reads WHERE episode_id=? AND revision=? AND caller_id=? AND task_id=? AND call_id=?")
            .get(id, found.sourceRevision, call.callerId, call.taskId, call.callId)!;
          found.readEvidence = { kind: "explicit_read", status: recorded.changes ? "recorded" : "replayed", observedAt: String(evidence.observed_at) };
          if (recorded.changes) {
            const retired = db.prepare("SELECT task_id FROM episode_reads WHERE episode_id=? ORDER BY task_id DESC LIMIT 1 OFFSET 256").get(id);
            if (retired) {
              db.prepare("UPDATE episodes SET read_retired_through=MAX(read_retired_through,?) WHERE id=?").run(retired.task_id, id);
              db.prepare("DELETE FROM episode_reads WHERE episode_id=? AND task_id<=?").run(id, retired.task_id);
              if (call.taskId <= Number(retired.task_id)) {
                found.readEvidence = { kind: "explicit_read", status: "outside_window" };
                return found;
              }
            }
            db.prepare("UPDATE episodes SET last_read_at=MAX(COALESCE(last_read_at,?),?) WHERE id=?").run(now, now, id);
          }
        }
        return found;
      });
    },
    // Database matches are not exposure. Only authorized returned rows are exposed.
    searchPage: (tokens: string[], limit: number, cursor?: EpisodeCursor, time?: EpisodeTimeQuery) => candidates(tokens, undefined, limit, cursor, time),
    openItemsPage: (sinceDays: number, limit: number, cursor?: EpisodeCursor) => candidates(undefined, sinceDays, limit, cursor),
    search(tokens: string[], limit: number): EpisodeRecord[] {
      return safeCandidates(tokens, undefined, limit).slice(0, Math.min(limit, 80));
    },
    openItems(sinceDays: number, limit: number) {
      if (limit <= 0) return [];
      return safeCandidates(undefined, sinceDays, limit).flatMap(found => found.openItems.map(text => ({ label: found.label, text, at: found.periodEnd,
        episodeId: found.id, source: found.source, sourceRevision: found.sourceRevision, messageIds: found.messageIds }))).slice(0, Math.min(limit, 80));
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
        const range = sourceTimeRange(original.flatMap(item => [item.periodStart, item.periodEnd]));
        const verified = original.every(verifiedSourceTimeRange) && !!range;
        if (!add({ ...merged, ...(range ?? {}), sourceTimeVerified: verified, level: 1, sourceRevision: revision, messageIds })) return false;
        const remove = db.prepare("DELETE FROM episodes WHERE id = ?");
        for (const id of ids) remove.run(id);
        return true;
      });
    },
    forget(now = Date.now()) {
      return Number(db.prepare("DELETE FROM episodes WHERE MAX(last_used_at, COALESCE(last_read_at,last_used_at)) < ? OR (open_items = '[]' AND MAX(last_used_at, COALESCE(last_read_at,last_used_at)) < ?)").run(iso(now - FORGET_OPEN_DAYS * DAY), iso(now - FORGET_DAYS * DAY)).changes);
    },
    // 测试和排查用：直接设置最近使用时间。
    setLastUsed(id: string, at: string) { db.prepare("UPDATE episodes SET last_used_at = ?, last_read_at=NULL WHERE id = ?").run(at, id); },
    all: () => db.prepare("SELECT * FROM active_episodes ORDER BY period_start").all().map(row),
    close: () => db.close(),
  };
}
export type EpisodeStore = ReturnType<typeof openEpisodeStore>;
