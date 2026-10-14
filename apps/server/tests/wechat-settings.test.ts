import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openModelSettings } from "../dist/model-settings.js";
import { openWechatSettings } from "../dist/wechat-settings.js";

const model = { api: "faux", baseUrl: "", model: "", apiKey: "", contextWindow: 1, maxTokens: 1 };
const fallback = { enabled: false, webhookKey: "", sendToken: "", sendURL: "http://127.0.0.1:18790/v1/send" };

test("微信配置保存后重启生效，密钥自动生成并可重新生成，拒绝非本机发送地址", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-wechat-settings-"));
  const models = await openModelSettings(directory, model);
  try {
    const first = openWechatSettings(directory, fallback);
    assert.equal(first.get().restartRequired, false);
    const saved = first.save({ enabled: true, sendUrl: fallback.sendURL });
    assert.equal(saved.restartRequired, true);
    assert.match(saved.webhookKey, /^[0-9a-f]{64}$/);
    assert.notEqual(saved.webhookKey, saved.sendToken);
    assert.equal(first.save({ enabled: true, sendUrl: fallback.sendURL }).webhookKey, saved.webhookKey);
    assert.notEqual(first.save({ enabled: true, sendUrl: fallback.sendURL, regenerate: true }).webhookKey, saved.webhookKey);
    assert.throws(() => first.save({ enabled: true, sendUrl: "http://example.com/send" }), /本机/);
    first.close();
    const second = openWechatSettings(directory, fallback);
    assert.equal(second.active.enabled, true);
    assert.equal(second.get().restartRequired, false);
    second.close();
  } finally { models.close(); await rm(directory, { recursive: true, force: true }); }
});
