import type { AddressInfo } from "node:net";
import type { AppConfig } from "./config.js";
import { createApplication } from "./application/index.js";
import { createHttpServer } from "./http/server.js";

export async function startServer(config: AppConfig, host = config.password ? "0.0.0.0" : "127.0.0.1", webRoot = new URL("../../web/dist/", import.meta.url)) {
  const app = await createApplication(config);
  const server = createHttpServer(app, webRoot);
  let closing: Promise<void> | undefined;
  function close() {
    return closing ??= (async () => {
      server.closeSockets();
      const stopped = new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      app.wechat?.stop();
      app.taskGraph.dispose();
      await Promise.all([stopped, app.harness.close(app.ctx)]);
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
  return { origin: `http://${host}:${(server.address() as AddressInfo).port}`, modelLabel: app.modelLabel, close, redact: app.redact };
}
