import test from "node:test";
import assert from "node:assert/strict";
import type { Tx } from "@earendil-works/pi-durable";
import { Index } from "@assistant/runtime";
import { Goals, Schedules, Reminders, BackgroundJobs } from "@assistant/features";
import { WechatState } from "@assistant/channel-wechat";
import type { AppContext } from "../dist/application/context.js";
import { createConversations } from "../dist/application/conversations.js";

for (const action of ["archive", "remove"]) test(`${action} keeps the conversation visible when stopping fails, then retries cancelled tasks`, async () => {
  const index = { items: [{ id: 7, title: "待处理", createdAt: "2026-01-01", archivedAt: null }] };
  const goal = { conversationId: 7, status: "running", revision: 1, taskId: 14, wakeAt: null, updatedAt: 0 };
  const documents = new Map<unknown, unknown>([
    [Index, index], [Schedules, { items: [{ status: "active", revision: 1, jobId: 11 }] }],
    [Reminders, { items: [{ status: "scheduled", id: 12 }] }],
    [BackgroundJobs, { items: [{ status: "running", taskId: 13 }] }],
    [Goals, { items: [goal], applied: {} }], [WechatState, { bindings: {} }],
  ]);
  const tx = { doc: async (token: unknown) => documents.get(token), task: async () => ({ state: { status: "running" } }) } as unknown as Tx;
  const commit = async <T>(fn: (tx: Tx) => Promise<T>) => fn(tx);
  let fail = true;
  const attempts: number[] = [];
  const context = { root: { id: 1, commit }, ctx: {}, redact: () => "test stop failure",
    harness: { conversation: async () => ({ id: 7, commit }), snapshot: async (token: unknown) => documents.get(token),
      abortTask: async (id: number) => { attempts.push(id); if (fail && id === 12) throw new Error("test stop failure"); } },
    episodeStore: { revokeSource: () => {} },
  } as unknown as AppContext;
  await assert.rejects(createConversations(context).shelveConversation(7, action), /停止执行尚未确认/);
  assert.equal(index.items.length, 1);
  assert.equal(index.items[0].archivedAt, null);
  assert.deepEqual(attempts, [11, 12, 13, 14]);
  assert.equal(goal.status, "cancelled");
  const revision = goal.revision;
  // Recreate the application to verify retry depends on durable records, not a closure.
  fail = false; attempts.length = 0;
  await createConversations(context).shelveConversation(7, action);
  assert.deepEqual(attempts, [11, 12, 13, 14]);
  assert.equal(goal.revision, revision);
  if (action === "remove") assert.equal(index.items.length, 0);
  else assert.ok(index.items[0].archivedAt);
});

test("cancelled records with terminal or missing runtime tasks do not block archival", async () => {
  const index = { items: [{ id: 7, title: "历史", createdAt: "2026-01-01", archivedAt: null }] };
  const documents = new Map<unknown, unknown>([
    [Index, index], [Schedules, { items: [{ status: "cancelled", jobId: 11 }] }],
    [Reminders, { items: [{ status: "cancelled", id: 12 }] }],
    [BackgroundJobs, { items: [] }], [Goals, { items: [], applied: {} }], [WechatState, { bindings: {} }],
  ]);
  const tx = { doc: async (token: unknown) => documents.get(token), task: async (id: number) => id === 11 ? { state: { status: "terminal" } } : undefined } as unknown as Tx;
  const commit = async <T>(fn: (tx: Tx) => Promise<T>) => fn(tx);
  const context = { root: { id: 1, commit }, ctx: {},
    harness: { conversation: async () => ({ id: 7, commit }), snapshot: async (token: unknown) => documents.get(token),
      abortTask: async () => { assert.fail("No live task should be aborted"); } },
  } as unknown as AppContext;
  await createConversations(context).shelveConversation(7, "archive");
  assert.ok(index.items[0].archivedAt);
});
