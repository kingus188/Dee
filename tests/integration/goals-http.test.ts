import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, launch, post, readView, stop } from "./helpers.js";
import type { Goal, Management } from "@assistant/contracts";

test("personal goal HTTP admission, version conflicts, global visibility and cancellation survive restart", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "dee-goal-http-"));
  let app;
  try {
    app = await launch(dir, await freePort());
    const { id } = await post(app.origin, "/api/conversations");
    const body = { text: "整理项目资料", criteria: "给出来源和结论", requestId: "http-goal-1" };
    const { item }: { item: Goal } = await post(app.origin, `/api/conversations/${id}/goals`, body);
    const duplicate = await post(app.origin, `/api/conversations/${id}/goals`, body);
    assert.equal(duplicate.item.id, item.id);
    const management: Management = await (await fetch(app.origin + `/api/conversations/${id}/management`)).json();
    assert.equal(management.goals?.[0].id, item.id);
    // The existing faux script never submits a goal checkpoint: this must block and become a visible passive report.
    const report = await readView(app.origin, id, view => view.entries.some(entry => entry.text.includes("本轮没有提交有效检查点")));
    assert.ok(report.entries.some(entry => entry.kind === "assistant" && entry.text.includes("个人委托：整理项目资料")));
    assert.equal(report.entries.filter(entry => entry.kind === "user").length, 0, "状态报告不能伪装成用户输入");
    const stale = await fetch(app.origin + `/api/goals/${item.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 0 }) });
    assert.equal(stale.status, 409);
    await post(app.origin, `/api/goals/${item.id}/cancel`, { revision: item.revision, requestId: "http-cancel" });
    await stop(app.child);
    app = await launch(dir, await freePort());
    const goals: { items: Goal[] } = await (await fetch(app.origin + "/api/goals")).json();
    assert.equal(goals.items.length, 1);
    assert.equal(goals.items[0].status, "cancelled");
    const invalid = await fetch(app.origin + `/api/conversations/${id}/goals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, criteria: "", requestId: "invalid" }) });
    assert.equal(invalid.status, 400);
    const ended = await fetch(app.origin + `/api/goals/${item.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: goals.items[0].revision, input: "继续" }) });
    assert.equal(ended.status, 409);
  } finally { if (app) await stop(app.child); await rm(dir, { recursive: true, force: true }); }
});
