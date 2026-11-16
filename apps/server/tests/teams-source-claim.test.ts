import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createTeamsTriageStore } from "../dist/teams-triage-store.js";
import { createSourceLifecycle } from "../dist/source-lifecycle.js";

test("source invalidation and access generation roll back together when the access write fails", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const triage = createTeamsTriageStore(db), sources = createSourceLifecycle(db);
  triage.access("chat", true);
  db.exec("CREATE TRIGGER fail_access BEFORE UPDATE ON teams_chat_access BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
  assert.throws(() => triage.access("chat", false), /synthetic storage failure/);
  assert.equal(sources.revision("teams:chat"), 0);
  assert.equal(triage.accessGeneration("chat"), 0);
  assert.equal(db.prepare("SELECT available FROM teams_chat_access").get()?.available, 1);
  db.exec("DROP TRIGGER fail_access");
  triage.access("chat", false);
  assert.equal(sources.revision("teams:chat"), 1);
  assert.equal(triage.accessGeneration("chat"), 1);
  assert.equal(triage.access("chat", true, 0), false);
});

test("access invalidation remains inside an existing caller transaction", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const triage = createTeamsTriageStore(db), sources = createSourceLifecycle(db);
  db.exec("BEGIN IMMEDIATE"); triage.access("chat", false);
  assert.equal(sources.revision("teams:chat"), 1);
  db.exec("ROLLBACK");
  assert.equal(sources.revision("teams:chat"), 0);
  assert.equal(triage.accessGeneration("chat"), 0);
});
