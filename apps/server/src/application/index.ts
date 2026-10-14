import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { createAssistant, Delegate, createTaskCenter, createNotifier, createPersonal, createMaterials, createTeamsInbox } from "@assistant/features";
import { mkdir } from "node:fs/promises";
import { WechatChannel } from "@assistant/channel-wechat";
import type { AppConfig } from "../config.js";
import type { AppContext } from "./context.js";
import { openModelSettings } from "../model-settings.js";
import { openWechatSettings } from "../wechat-settings.js";
import { openTeamsStore } from "../teams-store.js";

export async function createApplication(config: AppConfig): Promise<AppContext> {
  if (config.production && !config.password) throw new Error("生产环境必须设置 DEMO_PASSWORD");
  const modelSettings = await openModelSettings(config.dataDir, config.model);
  let wechatSettings: ReturnType<typeof openWechatSettings> | undefined;
  let teamsStore: ReturnType<typeof openTeamsStore> | undefined;
  try {
    wechatSettings = openWechatSettings(config.dataDir, config.wechat);
    teamsStore = openTeamsStore(config.dataDir);
    config = { ...config, model: modelSettings.model, wechat: wechatSettings.active };
    if (config.wechat.enabled && (!config.wechat.webhookKey || !config.wechat.sendToken)) throw new Error("微信启用时必须设置 WECHAT_WEBHOOK_KEY 和 WECHAT_SEND_TOKEN");
    const redact = modelSettings.redact;
    const exitIfFatal = (error: unknown) => {
      if (error instanceof Error && /poisoned|SessionFailed|session_failed/i.test(error.name + " " + error.message)) {
        console.error("存储不可用，进程退出等待重启：", redact(error.message));
        process.exit(1);
      }
    };
    await mkdir(config.materialsRoot, { recursive: true });
    const notify = createNotifier(config.notifications);
    const tasks = createTaskCenter(notify);
    const { models, agentModel, label: modelLabel, configured: modelConfigured } = await createModelCatalog(config.model, config.model.api === "faux" ? (await import("./faux.js")).fauxScript : undefined);
    if (config.wechat.enabled && !modelConfigured) throw new Error("启用微信通道前请先保存模型配置");
    const runtime = await openRuntime({ dataDir: config.dataDir, models, agentModel, resume: modelConfigured,
      extensions: [createAssistant(notify), Delegate, tasks.extension, createPersonal(config.knowledge), createMaterials(config.materialsRoot), createTeamsInbox(teamsStore)],
      onReport: error => console.error("Harness 报告：", redact(error instanceof Error ? error.message : error)),
    }, ctx);
    const wechat = config.wechat.enabled ? new WechatChannel({ ...runtime, indexDoc: Index, context: ctx, ...config.wechat }) : null;
    try {
      if (wechat) await wechat.start();
      const taskGraph = await runtime.harness.taskGraph(ctx);
      return { ...runtime, config, ctx, taskGraph, tasks, wechat, modelSettings, wechatSettings, teamsStore, modelLabel, modelConfigured, startedAt: new Date().toISOString(), redact, exitIfFatal };
    } catch (error) {
      wechat?.stop();
      await runtime.harness.close(ctx);
      throw error;
    }
  } catch (error) {
    wechatSettings?.close();
    teamsStore?.close();
    modelSettings.close();
    throw error;
  }
}
