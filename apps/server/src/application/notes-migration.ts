import { Index, type Runtime } from "@assistant/runtime";
import { Notes } from "@assistant/features";
import type { Context } from "@earendil-works/chord";
import type { NotesStore, LegacyNotes } from "../notes-store.js";

/** Copy visible/archived legacy notes once. Leave their Durable source untouched. */
export async function migratePersonalNotes(runtime: Runtime, store: NotesStore, ctx: Context) {
  const sources: LegacyNotes[] = [];
  for (const item of (await runtime.harness.snapshot(Index, ctx))?.items ?? []) {
    const notes = await runtime.harness.snapshot(Notes, item.id, ctx);
    if (!notes?.memos.length) continue;
    // Unlike a SQLite path or a bare numeric ID, this survives restored directories
    // without colliding with conversations created in a fresh runtime database.
    sources.push({ source: JSON.stringify([item.id, item.createdAt]), memos: notes.memos });
  }
  await store.importLegacy(sources);
}
