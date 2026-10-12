import { readConfig } from "./config.js";
import { createApplication } from "./application/index.js";
import { createHttpServer } from "./http/server.js";

const config = readConfig(process.env);
const app = await createApplication(config);
const server = createHttpServer(app, new URL("../../web/dist/", import.meta.url));
server.listen(config.port, config.password ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`pi-durable-assistant 已启动：端口 ${config.port}，模型 ${app.modelLabel}，PID ${process.pid}`);
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  app.wechat?.stop();
  app.taskGraph.dispose();
  try { await app.harness.close(app.ctx); } catch (error) { console.error(app.redact(error)); process.exitCode = 1; }
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
