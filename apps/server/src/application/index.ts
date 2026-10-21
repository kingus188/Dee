import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModelCatalog, openRuntime, Index } from "@assistant/runtime";
import { createAssistant, Delegate, createTaskCenter, createNotifier, createPersonal, createMaterials, createInvestigator, parseRepos, createEpisodes, createTeamsInbox, createTeamsReply, createTeamsAway, createMailInbox } from "@assistant/features";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WechatChannel } from "@assistant/channel-wechat";
import type { AppConfig } from "../config.js";
import type { AppContext } from "./context.js";
import { openModelSettings } from "../model-settings.js";
import { openWechatSettings } from "../wechat-settings.js";
import { createMailService } from "../mail-service.js";
import { openTeamsStore } from "../teams-store.js";
import { openEpisodeStore } from "../episode-store.js";
import { createSummarizer } from "../episode-model.js";
import { reviewTeamsNotification } from "../teams-notifications.js";
import { createTeamsReplyPort, type TeamsSender } from "../teams-reply-port.js";
import { openDaylightStore } from "../daylight-store.js";
import { createDaylight, migrateLegacyTodos } from "@assistant/features";
import { openNotificationOutbox } from "../notification-outbox.js";

export async function createApplication(config: AppConfig): Promise<AppContext> {
  if (config.production && !config.password) throw new Error("生产环境必须设置 DEMO_PASSWORD");
  const modelSettings = await openModelSettings(config.dataDir, config.model);
  let wechatSettings: ReturnType<typeof openWechatSettings> | undefined;
  let teamsStore: ReturnType<typeof openTeamsStore> | undefined;
  let mail: ReturnType<typeof createMailService> | undefined;
  let episodeStore: ReturnType<typeof openEpisodeStore> | undefined;
  let daylight: ReturnType<typeof openDaylightStore> | undefined;
  let notifications: ReturnType<typeof openNotificationOutbox> | undefined;
  try {
    wechatSettings = openWechatSettings(config.dataDir, config.wechat);
    teamsStore = openTeamsStore(config.dataDir);
    episodeStore = openEpisodeStore(config.dataDir);
    daylight = openDaylightStore(config.dataDir);
    mail = createMailService(config.dataDir, config.offline, fetch, config.mailAccountFile);
    config = { ...config, model: modelSettings.model, wechat: wechatSettings.active };
    if (config.offline) config = { ...config, wechat: { ...config.wechat, enabled: false }, notifications: { ...config.notifications, mode: "off" } };
    if (config.wechat.enabled && (!config.wechat.webhookKey || !config.wechat.sendToken)) throw new Error("微信启用时必须设置 WECHAT_WEBHOOK_KEY 和 WECHAT_SEND_TOKEN");
    // 默认放在数据目录下；数据目录可能在读配置之后才被宿主改写，所以这里再推导。
    const materialsRoot = config.materialsRoot || join(config.dataDir, "materials");
    const teamsSender: TeamsSender = {};
    const redact = modelSettings.redact;
    const exitIfFatal = (error: unknown) => {
      if (error instanceof Error && /poisoned|SessionFailed|session_failed/i.test(error.name + " " + error.message)) {
        console.error("存储不可用，进程退出等待重启：", redact(error.message));
        process.exit(1);
      }
    };
    await mkdir(materialsRoot, { recursive: true });
    notifications = openNotificationOutbox(config.dataDir, config.notifications);
    const notify = createNotifier(config.notifications, notifications.enqueue);
    const tasks = createTaskCenter(notify);
    const { models, agentModel, label: modelLabel, configured: modelConfigured } = await createModelCatalog(config.model, config.model.api === "faux" ? (await import("./faux.js")).fauxScript : undefined);
    if (config.wechat.enabled && !modelConfigured) throw new Error("启用微信通道前请先保存模型配置");
    const runtime = await openRuntime({ dataDir: config.dataDir, models, agentModel, resume: modelConfigured,
      extensions: [createDaylight(daylight), createMailInbox(mail), createAssistant(notify, daylight), Delegate, tasks.extension, createPersonal(config.knowledge), createMaterials(materialsRoot), createInvestigator({ repos: parseRepos(config.investigate.repos), dir: join(config.dataDir, "investigations"), agent: config.investigate.agent, codexBin: config.investigate.codexBin, claudeBin: config.investigate.claudeBin, notify }), createEpisodes(episodeStore), createTeamsInbox({ list: query => teamsStore!.list(query),
        refresh: () => teamsSender.refresh?.() ?? Promise.resolve({ ok: false, lastSuccessAt: teamsSender.syncStatus?.().lastSuccessAt ?? null }),
        syncStatus: () => teamsSender.syncStatus?.() ?? { lastSuccessAt: null } }), createTeamsReply(createTeamsReplyPort(teamsStore, teamsSender, config.offline)),
        createTeamsAway({ get: () => teamsStore!.away(), set: input => teamsStore!.setAway(input), clear: () => teamsStore!.clearAway() })],
      onReport: error => console.error("Harness 报告：", redact(error instanceof Error ? error.message : error)),
    }, ctx);
    const wechat = config.wechat.enabled ? new WechatChannel({ ...runtime, indexDoc: Index, context: ctx, ...config.wechat, reviewNotification: source => reviewTeamsNotification(teamsStore!, teamsSender, source) }) : null;
    try {
      await migrateLegacyTodos(runtime.harness, daylight, ctx);
      if (wechat) { await wechat.linkLegacyTeams(teamsStore.notificationIds()); await wechat.start(); }
      const taskGraph = await runtime.harness.taskGraph(ctx);
      return { ...runtime, config, ctx, taskGraph, tasks, notifications, daylight, wechat, modelSettings, wechatSettings, teamsStore, teamsSender, mail, episodeStore, summarize: createSummarizer(models, agentModel), modelLabel, modelConfigured, startedAt: new Date().toISOString(), redact, exitIfFatal };
    } catch (error) {
      wechat?.stop();
      await runtime.harness.close(ctx);
      throw error;
    }
  } catch (error) {
    await notifications?.close();
    await mail?.close();
    wechatSettings?.close();
    teamsStore?.close();
    episodeStore?.close();
    daylight?.close();
    modelSettings.close();
    throw error;
  }
}
