import assert from "node:assert/strict";
import test from "node:test";
import { createNotifier } from "../dist/tasks/notifications.js";

test("notification mode filters new events and enqueue failure is not mistaken for delivery", async () => {
  const events: { id: string; body: string }[] = [];
  const enqueue = async (event: { id: string; body: string }) => { events.push(event); };
  for (const config of [ { url: "", mode: "all", kind: "generic" }, { url: "http://localhost", mode: "off", kind: "generic" }, { url: "http://localhost", mode: "errors", kind: "generic" } ]) {
    await createNotifier(config, enqueue)({ id: "skip", type: "reminder", text: "do not send" });
  }
  assert.equal(events.length, 0);
  await createNotifier({ url: "http://localhost", mode: "errors", kind: "generic" }, enqueue)({ id: "failed", type: "background", text: "failed task", failed: true });
  const payload = JSON.parse(events[0].body);
  assert.equal(payload.failed, true); assert.equal(payload.id, "failed");
  await assert.rejects(createNotifier({ url: "http://localhost", mode: "all", kind: "generic" }, async () => { throw new Error("disk unavailable"); })({ id: "retry", type: "schedule", text: "task" }), /disk unavailable/);
});


test("structured urgency and approval bypass errors-only filtering without changing provider payloads", async () => {
  const events: { id: string; body: string; priority?: string }[] = [];
  const notify = createNotifier({ url: "http://localhost", mode: "errors", kind: "feishu" }, async event => { events.push(event); });
  await notify({ id: "urgent", type: "reminder", text: "due now", priority: "urgent" });
  await notify({ id: "approval", type: "approval", text: "approve action" });
  await notify({ id: "failed", type: "background", text: "failed action", failed: true });
  await notify({ id: "normal", type: "background", text: "completed" });
  assert.deepEqual(events.map(event => event.priority), ["urgent", "approval", "urgent"]);
  assert.deepEqual(JSON.parse(events[0].body), { msg_type: "text", content: { text: "due now" } });
  await createNotifier({ url: "http://localhost", mode: "off", kind: "generic" }, async () => { assert.fail("off remains off"); })({ id: "off", type: "approval", text: "approval" });
});
