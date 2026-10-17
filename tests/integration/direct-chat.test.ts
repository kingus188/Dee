import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, post, launch, stop, readView } from "./helpers.js";

test("固定聊天并发打开不重复创建，更换话题与重启都保留同一段记录和计划", { timeout: 40000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-direct-"));
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(dir, await freePort());
    const origin = app.origin;
    const opened = await Promise.all(Array.from({ length: 8 }, () => post(origin, "/api/conversations/direct")));
    const id = opened[0].id;
    assert.deepEqual([...new Set(opened.map(item => item.id))], [id]);
    assert.equal((await (await fetch(origin + "/api/conversations")).json()).length, 1);
    await post(origin, `/api/conversations/${id}/schedules`, { text: "稍后整理资料", minutesFromNow: 60 });
    await post(origin, `/api/conversations/${id}/messages`, { text: "先聊今天的安排", mode: "steer" });
    await readView(origin, id, view => view.entries.some(entry => entry.text === "先聊今天的安排"));
    await readView(origin, id, view => view.entries.some(entry => entry.kind === "assistant" && entry.text === "演示任务完成。"));
    await post(origin, `/api/conversations/${id}/messages`, { text: "换个话题，晚餐吃什么", mode: "steer" });
    const view = await readView(origin, id, value => value.entries.some(entry => entry.text === "换个话题，晚餐吃什么"));
    assert.ok(view.entries.some(entry => entry.text === "先聊今天的安排"));
    await post(origin, `/api/conversations/${id}/abort`);
    const plan = await (await fetch(origin + `/api/conversations/${id}/management`)).json();
    assert.equal(plan.schedules[0].status, "active");
    await post(origin, "/api/conversations");
    assert.equal((await post(origin, "/api/conversations/direct")).id, id, "旧接口新建的记录不会抢走固定聊天");
    const next = (await post(origin, "/api/conversations/direct/new")).id;
    assert.notEqual(next, id);
    assert.equal((await post(origin, "/api/conversations/direct")).id, next);
    const fresh = await readView(origin, next);
    assert.equal(fresh.entries.length, 0);
    await post(origin, `/api/conversations/${next}/messages`, { text: "这是独立的新对话", mode: "steer" });
    const newView = await readView(origin, next, value => value.entries.some(entry => entry.text === "这是独立的新对话"));
    assert.ok(!newView.entries.some(entry => entry.text === "先聊今天的安排"));
    const oldPlan = await (await fetch(origin + `/api/conversations/${id}/management`)).json();
    assert.equal(oldPlan.schedules[0].status, "active", "新建不取消旧会话的计划");
    await stop(app.child);
    app = await launch(dir, await freePort());
    assert.equal((await post(app.origin, "/api/conversations/direct")).id, next);
    const restored = await readView(app.origin, id);
    assert.ok(restored.entries.some(entry => entry.text === "换个话题，晚餐吃什么"));
    assert.ok((await readView(app.origin, next)).entries.some(entry => entry.text === "这是独立的新对话"));
  } finally {
    if (app) await stop(app.child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("固定聊天入口继承鉴权与同源限制", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-direct-auth-"));
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(dir, await freePort(), { DEMO_PASSWORD: "local-test-password" });
    const authorization = "Basic " + Buffer.from("demo:local-test-password").toString("base64");
    for (const path of ["/api/conversations/direct", "/api/conversations/direct/new"]) {
      const url: string = app.origin + path;
      assert.equal((await fetch(url, { method: "POST" })).status, 401);
      assert.equal((await fetch(url, { method: "POST", headers: { authorization, origin: "https://untrusted.example" } })).status, 403);
      assert.equal((await fetch(url, { method: "POST", headers: { authorization, origin: app.origin, "content-type": "application/json" }, body: "{}" })).status, 200);
    }
  } finally {
    if (app) await stop(app.child);
    await rm(dir, { recursive: true, force: true });
  }
});
