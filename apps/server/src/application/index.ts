import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { createAssistant, Delegate, createTaskCenter, createNotifier, createPersonal } from "@assistant/features";
import { WechatChannel } from "@assistant/channel-wechat";
import type { AppConfig } from "../config.js";
import type { AppContext } from "./context.js";

export async function createApplication(config: AppConfig): Promise<AppContext> {
  if (config.production && !config.password) throw new Error("生产环境必须设置 DEMO_PASSWORD");
  if (config.wechat.enabled && (!config.wechat.webhookKey || !config.wechat.sendToken)) throw new Error("微信启用时必须设置 WECHAT_WEBHOOK_KEY 和 WECHAT_SEND_TOKEN");
  const secret = config.model.apiKey;
  const redact = (value: unknown) => secret.length >= 8 ? String(value).replaceAll(secret, "***") : String(value);
  const exitIfFatal = (error: unknown) => {
    if (error instanceof Error && /poisoned|SessionFailed|session_failed/i.test(error.name + " " + error.message)) {
      console.error("存储不可用，进程退出等待重启：", redact(error.message));
      process.exit(1);
    }
  };
  const notify = createNotifier(config.notifications);
  const tasks = createTaskCenter(notify);
  const { models, agentModel, label: modelLabel } = await createModelCatalog(config.model, config.model.api === "faux" ? (await import("./faux.js")).fauxScript : undefined);
  const runtime = await openRuntime({ dataDir: config.dataDir, models, agentModel,
    extensions: [createAssistant(notify), Delegate, tasks.extension, createPersonal(config.knowledge)],
    onReport: error => console.error("Harness 报告：", redact(error instanceof Error ? error.message : error)),
  }, ctx);
  const wechat = config.wechat.enabled ? new WechatChannel({ ...runtime, indexDoc: Index, context: ctx, ...config.wechat }) : null;
  try {
    if (wechat) await wechat.start();
    const taskGraph = await runtime.harness.taskGraph(ctx);
    return { ...runtime, config, ctx, taskGraph, tasks, wechat, modelLabel, startedAt: new Date().toISOString(), redact, exitIfFatal };
  } catch (error) {
    wechat?.stop();
    await runtime.harness.close(ctx);
    throw error;
  }
}
