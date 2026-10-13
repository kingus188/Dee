import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Index } from "@assistant/runtime";
import { createApplication } from "../dist/application/index.js";
import { readConfig } from "../dist/config.js";
import { openDirectChat } from "../dist/application/direct-chat.js";

test("延续已有普通聊天，跳过微信、分叉和已归档记录", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-direct-legacy-"));
  const app = await createApplication(readConfig({ LLM_API: "faux", DATA_DIR: data, NOTIFY_MODE: "off" }));
  try {
    const ids = await app.root.commit(async tx => {
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
      const index = await tx.doc(Index);
      index.items.push(
        { id: ids[0], title: "原来的聊天", createdAt: "2026-10-10" },
        { id: ids[1], title: "微信", channel: "wechat", createdAt: "2026-10-11" },
        { id: ids[2], title: "分叉", forkOf: ids[0], createdAt: "2026-10-12" },
        { id: ids[3], title: "归档", archivedAt: "2026-10-12", createdAt: "2026-10-12" },
      );
      return ids;
    }, app.ctx);
    assert.equal(await openDirectChat(app), ids[0]);
    const index = await app.harness.snapshot(Index, app.ctx);
    assert.equal(index?.items.length, 4);
    assert.equal(index?.items[0].channel, "web");
    assert.equal(index?.items[1].channel, "wechat");
    assert.equal(index?.items[2].forkOf, ids[0]);
    assert.equal(index?.items[3].archivedAt, "2026-10-12");
  } finally {
    app.taskGraph.dispose();
    await app.harness.close(app.ctx);
    await rm(data, { recursive: true, force: true });
  }
});
