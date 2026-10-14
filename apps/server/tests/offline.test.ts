import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../dist/application/index.js";
import { readConfig } from "../dist/config.js";
import { createTeamsReplyPort } from "../dist/teams-reply-port.js";
import { openTeamsStore } from "../dist/teams-store.js";

const base = { NODE_ENV: "test", LLM_API: "faux", NOTIFY_MODE: "off" };
// 发送地址指向不可能有人监听的端口，确保控制组不会碰到真实运行的 wx-bot。
const savedSettings = { enabled: true, sendUrl: "http://127.0.0.1:1/v1/send" };

async function close(app: Awaited<ReturnType<typeof createApplication>>) {
  app.wechat?.stop();
  app.taskGraph.dispose();
  await app.harness.close(app.ctx);
  app.modelSettings.close(); app.wechatSettings.close(); app.teamsStore.close(); app.episodeStore.close();
}

test("PI_OFFLINE=1 时，数据库里已保存的「微信开启」也不生效，Webhook 通知被关闭", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-offline-"));
  try {
    // 先正常启动一次，把「微信开启」保存进数据库（复现：数据目录被复制后配置跟着走）。
    const first = await createApplication(readConfig({ ...base, DATA_DIR: data }));
    first.wechatSettings.save(savedSettings);
    await close(first);

    const control = await createApplication(readConfig({ ...base, DATA_DIR: data }));
    assert.ok(control.wechat, "对照：不开 PI_OFFLINE 时保存的配置会启用微信通道");
    await close(control);

    const offline = await createApplication(readConfig({ ...base, DATA_DIR: data, PI_OFFLINE: "1", NOTIFY_MODE: "all", NOTIFY_WEBHOOK_URL: "http://127.0.0.1:1/hook" }));
    try {
      assert.equal(offline.wechat, null, "微信通道必须不创建");
      assert.equal(offline.config.wechat.enabled, false);
      assert.equal(offline.config.notifications.mode, "off");
    } finally { await close(offline); }
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("PI_OFFLINE=1 时 Teams 发送口不可用，否则透传宿主挂上的发送函数", async () => {
  const data = await mkdtemp(join(tmpdir(), "pi-offline-teams-"));
  const store = openTeamsStore(data);
  try {
    const send = async () => {};
    assert.equal(createTeamsReplyPort(store, { send }, true).send, undefined);
    assert.equal(createTeamsReplyPort(store, { send }, false).send, send);
    assert.equal(createTeamsReplyPort(store, {}, false).send, undefined, "没挂发送函数时同样不可用");
  } finally {
    store.close();
    await rm(data, { recursive: true, force: true });
  }
});
