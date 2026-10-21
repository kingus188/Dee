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
