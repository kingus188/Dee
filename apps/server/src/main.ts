import { readConfig } from "./config.js";
import { startServer } from "./lifecycle.js";

const config = readConfig(process.env);
const server = await startServer(config, undefined, process.env);
console.log(`pi-durable-assistant 已启动：端口 ${config.port}，模型 ${server.modelLabel}，PID ${process.pid}`);
async function close() {
  try { await server.close(); } catch (error) { console.error(server.redact(error)); process.exitCode = 1; }
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
