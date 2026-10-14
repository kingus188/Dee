import type { AddressInfo } from "node:net";
import type { AppConfig } from "./config.js";
import { createApplication } from "./application/index.js";
import { createHttpServer } from "./http/server.js";
import { startEpisodeJob } from "./episode-job.js";
import { conversationBatches, teamsBatches } from "./episode-sources.js";

export async function startServer(config: AppConfig, host = config.password ? "0.0.0.0" : "127.0.0.1", webRoot = new URL("../../web/dist/", import.meta.url)) {
  const app = await createApplication(config);
  const server = createHttpServer(app, webRoot);
  // 情景摘要需要真实模型；未配置模型时不启动。
  const stopEpisodes = app.modelConfigured ? startEpisodeJob({
    store: app.episodeStore, summarize: app.summarize,
    collect: async cursorOf => [...await conversationBatches(app, cursorOf), ...teamsBatches(app.teamsStore, cursorOf)],
    log: message => console.error("情景摘要：" + app.redact(message)),
  }) : () => {};
  let closing: Promise<void> | undefined;
  function close() {
    return closing ??= (async () => {
      server.closeSockets();
      const stopped = new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      stopEpisodes();
      app.wechat?.stop();
      app.taskGraph.dispose();
      try { await Promise.all([stopped, app.harness.close(app.ctx)]); }
      finally { app.wechatSettings.close(); app.teamsStore.close(); app.episodeStore.close(); app.modelSettings.close(); }
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
  } catch (error) {
    await close();
    throw error;
  }
  return { origin: `http://${host}:${(server.address() as AddressInfo).port}`, modelLabel: app.modelLabel, wechat: app.config.wechat, teamsStore: app.teamsStore, teamsSender: app.teamsSender, wechatUndelivered: app.wechat ? () => app.wechat!.undelivered() : undefined, close, redact: app.redact };
}
