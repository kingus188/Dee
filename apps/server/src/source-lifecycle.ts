import type { DatabaseSync } from "node:sqlite";

export type SourceReference = { source: string; revision?: number; messageIds?: string[] };

// The shared SQLite ledger contains identifiers only. A tombstone is monotonic:
// a later stale sync or a process restart must never make a withdrawn source live.
export function createSourceLifecycle(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_lifecycle (
    source TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS source_message_revocations (
    source TEXT NOT NULL, message_id TEXT NOT NULL, revoked_at TEXT NOT NULL, PRIMARY KEY(source,message_id));`);
  const revision = (source: string) => Number(db.prepare("SELECT revision FROM source_lifecycle WHERE source=?").get(source)?.revision ?? 0);
  const allowed = (source: string, expected?: number, messageIds: string[] = []) => {
    const state = db.prepare("SELECT revision,revoked_at FROM source_lifecycle WHERE source=?").get(source);
    if (state?.revoked_at || (expected !== undefined && expected !== Number(state?.revision ?? 0))) return false;
    return !messageIds.some(id => db.prepare("SELECT 1 FROM source_message_revocations WHERE source=? AND message_id=?").get(source, id));
  };
  // May run inside the caller's transaction, so archive mutation and revocation
  // are atomic. SAVEPOINT also makes this safe as a standalone operation.
  function revoke(source: string, messageId?: string) {
    db.exec("SAVEPOINT revoke_source");
    try {
      const at = new Date().toISOString();
      const changed = messageId === undefined
        ? !db.prepare("SELECT 1 FROM source_lifecycle WHERE source=? AND revoked_at IS NOT NULL").get(source)
        : !!db.prepare("INSERT OR IGNORE INTO source_message_revocations(source,message_id,revoked_at) VALUES (?,?,?)").run(source, messageId, at).changes;
      if (changed) db.prepare(`INSERT INTO source_lifecycle(source,revision,revoked_at) VALUES (?,1,?)
        ON CONFLICT(source) DO UPDATE SET revision=revision+1,revoked_at=COALESCE(source_lifecycle.revoked_at,excluded.revoked_at)`)
        .run(source, messageId === undefined ? at : null);
      db.exec("RELEASE revoke_source");
      return changed;
    } catch (error) { db.exec("ROLLBACK TO revoke_source; RELEASE revoke_source"); throw error; }
  }
  return { revision, allowed, revoke,
    // Edits invalidate old derived content, but unlike deletion do not hide the
    // newly observed source text or create a permanent message tombstone.
    invalidate(source: string) {
      db.prepare(`INSERT INTO source_lifecycle(source,revision) VALUES (?,1)
        ON CONFLICT(source) DO UPDATE SET revision=revision+1`).run(source);
    },
  };
}
