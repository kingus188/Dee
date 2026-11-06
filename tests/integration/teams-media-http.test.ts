import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTeamsStore } from "../../apps/server/dist/teams-store.js";
import { launch, freePort, stop } from "./helpers.js";

test("Teams 数据库截图走既有鉴权，离线可读，缺失返回 404 且不泄漏文件路径", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dee-media-http-"));
  const store = openTeamsStore(dir);
  const bytes = Buffer.from("89504e470d0a1a0a00000000", "hex");
  store.archive.hosted("chat", "message", ["image"]);
  const id = store.archive.mediaRows("chat", "message")[0].id;
  store.archive.saveBytes(id, "image/png", bytes); store.close();
  const password = "local-test-only";
  const app = await launch(dir, await freePort(), { PI_OFFLINE: "1", DEMO_PASSWORD: password });
  try {
    const path = `/api/teams/media/${id}`;
    assert.equal((await fetch(app.origin + path)).status, 401);
    const headers = { authorization: "Basic " + Buffer.from("demo:" + password).toString("base64") };
    const response = await fetch(app.origin + path, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
    assert.match(response.headers.get("cache-control")!, /private/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const missing = await fetch(app.origin + "/api/teams/media/" + "0".repeat(64), { headers });
    assert.equal(missing.status, 404); assert.doesNotMatch(await missing.text(), /agent\.sqlite|\/tmp\//);
  } finally { await stop(app.child); await rm(dir, { recursive: true, force: true }); }
});
