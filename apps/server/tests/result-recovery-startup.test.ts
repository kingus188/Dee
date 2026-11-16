import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import { Executions, ScheduleResults } from "@assistant/features";
import { createApplication } from "../dist/application/index.js";
import { createApi } from "../dist/application/api.js";
import { readConfig } from "../dist/config.js";

test("application startup recovers indexed active legacy results once; refresh and stopped sources never admit compensation", { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dee-startup-result-"));
  const config = readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dataDir, PI_OFFLINE: "1", NOTIFY_MODE: "off" });
  let app = await createApplication(config);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    app.wechat?.stop(); app.taskGraph.dispose();
    await app.harness.close(app.ctx);
    await app.notifications.close(); await app.mail.close(); await app.businessDatabase.end();
    app.modelSettings.close(); app.wechatSettings.close(); app.teamsStore.close(); app.episodeStore.close();
  }
  try {
    const project = await app.daylight.ensureDefaultProject();
    const cases = new Map<string, { owner: ConversationId; taskId: string; runId: string }>();
    for (const kind of ["active", "archived", "archiving", "removed", "cancelled", "unknown", "exhausted"]) {
      const taskId = randomUUID(), runId = "background:legacy:" + kind;
      await app.daylight.saveTask({ id: taskId, projectId: project.id, title: kind, description: "", status: "doing", priority: "medium", color: "mint", dueDate: null, tags: [], checklist: [], createdAt: 1, position: cases.size });
      const owner = await app.root.commit(async tx => {
        const owner = await tx.createConversation({ ownership: { kind: "ownerless" } });
        (await tx.doc(Index)).items.push({ id: owner.id, title: kind, createdAt: new Date().toISOString(), ...(kind === "archiving" ? { archivingAt: new Date().toISOString() } : {}) });
        (await tx.doc(Executions, owner.id)).items.push({ id: runId, kind: "background", taskId: "legacy", conversationId: owner.id, text: kind, status: kind === "cancelled" ? "cancelled" : "done", queuedAt: 1, startedAt: 1, finishedAt: 2, result: "verified result", error: null, daylightTaskId: taskId, deliveryStatus: kind === "unknown" ? "unknown" : "failed", deliveryError: "historical database failure" });
        if (kind === "exhausted") {
          const journal = await tx.doc(ScheduleResults, owner.id);
          journal.jobs[runId] = 900001 as TaskId; journal.rebuilds[runId] = 2;
          journal.progress = { [runId]: { status: "failed", phase: "deliver", attempts: 3, rebuilds: 2 } };
        }
        return owner.id;
      }, app.ctx);
      cases.set(kind, { owner, taskId, runId });
    }
    let api = createApi(app);
    for (const action of ["archive", "remove"] as const) {
      const entry = cases.get(action === "archive" ? "archived" : "removed")!;
      assert.equal((await api.dispatch("POST", new URL(`/api/conversations/${entry.owner}/${action}`, "http://localhost"))).status, 200);
    }
    const active = cases.get("active")!;
    const paths = [`/api/conversations/${active.owner}/management`, "/api/workspace/activities", `/api/daylight/tasks/${active.taskId}/executions`];
    for (let i = 0; i < 3; i++) {
      const views = await Promise.all(paths.map(path => api.dispatch("GET", new URL(path, "http://localhost"))));
      assert.ok(views.every(view => view.status === 200));
    }
    assert.equal((await app.daylight.getTask(active.taskId)).status, "doing", "GET must not perform legacy compensation");
    assert.equal((await app.harness.snapshot(ScheduleResults, active.owner, app.ctx))?.jobs[active.runId], undefined);
    await close();
    app = await createApplication(config); closed = false; api = createApi(app);
    for (let i = 0; i < 300; i++) {
      if ((await app.harness.snapshot(ScheduleResults, active.owner, app.ctx))?.completed[active.runId]) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const journal = (await app.harness.snapshot(ScheduleResults, active.owner, app.ctx))!;
    assert.equal(journal.completed[active.runId], true, "beforeResume must admit the indexed active legacy result");
    assert.equal((await app.daylight.getTask(active.taskId)).status, "review");
    for (const [kind, entry] of cases) {
      if (kind === "active") continue;
      assert.equal((await app.daylight.getTask(entry.taskId)).status, "doing", kind);
      const state = await app.harness.snapshot(ScheduleResults, entry.owner, app.ctx);
      assert.equal(state?.completed[entry.runId], undefined, kind);
      assert.equal(state?.jobs[entry.runId], kind === "exhausted" ? 900001 : undefined, kind);
    }
    // User changes after accepted compensation remain authoritative across GET and another boot.
    await app.daylight.moveTask(active.taskId, "doing");
    await Promise.all(paths.map(path => api.dispatch("GET", new URL(path, "http://localhost"))));
    await close(); app = await createApplication(config); closed = false;
    assert.equal((await app.daylight.getTask(active.taskId)).status, "doing");
    assert.equal((await app.harness.snapshot(ScheduleResults, active.owner, app.ctx))?.jobs[active.runId], journal.jobs[active.runId]);
  } finally { await close(); await rm(dataDir, { recursive: true, force: true }); }
});
