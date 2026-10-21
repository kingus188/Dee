import type { AddressInfo } from "node:net";
import type { AppConfig } from "./config.js";
import { createApplication } from "./application/index.js";
import { createHttpServer } from "./http/server.js";
import { startEpisodeJob } from "./episode-job.js";
import { conversationBatches, teamsBatches } from "./episode-sources.js";
import { startServerIntegrations } from "./integrations.js";

export async function startServer(config: AppConfig, host = config.password ? "0.0.0.0" : "127.0.0.1", env: NodeJS.ProcessEnv = {}) {
  const app = await createApplication(config);
  const server = createHttpServer(app);
  // 情景摘要需要真实模型；未配置模型时不启动。
  const stopEpisodes = app.modelConfigured ? startEpisodeJob({
    store: app.episodeStore, summarize: app.summarize,
    collect: async cursorOf => [...await conversationBatches(app, cursorOf), ...teamsBatches(app.teamsStore, cursorOf)],
    log: message => console.error("情景摘要：" + app.redact(message)),
  }) : () => {};
  let closing: Promise<void> | undefined;
  let stopIntegrations: () => void | Promise<void> = () => {};
  function close() {
    return closing ??= (async () => {
      server.closeSockets();
      const stopped = new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      stopEpisodes();
      await stopIntegrations();
      await app.mail.close();
      app.wechat?.stop();
      app.taskGraph.dispose();
      try { await Promise.all([stopped, app.harness.close(app.ctx)]); }
      finally {
        await app.notifications.close();
        app.wechatSettings.close(); app.teamsStore.close(); app.episodeStore.close(); app.modelSettings.close();
        await app.businessDatabase.end();
      }
    })();
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    stopIntegrations = startServerIntegrations({
      config: app.config, store: app.teamsStore, teamsSender: app.teamsSender, env,
      wechat: { ...app.config.wechat,
        notify: app.wechat ? (wxid, text, messageId) => app.wechat!.notify("primary", wxid, text, { kind: "teams", messageIds: [messageId] }).then(() => {}) : undefined,
        undelivered: app.wechat ? () => app.wechat!.undelivered() : undefined },
      onStuck: pending => console.error(`Teams 微信提醒待处理：${pending} 条，请检查桥接服务和接收人配置`),
    });
  } catch (error) {
    await close();
    throw error;
  }
  app.mail.start();
  app.notifications.start();
  return { mail: app.mail, origin: `http://${host}:${(server.address() as AddressInfo).port}`, modelLabel: app.modelLabel, close, redact: app.redact };
}
