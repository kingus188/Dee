import type { ServerInfo } from "@assistant/contracts";
import { request } from "./request.js";
export const readServerInfo = () => request<ServerInfo>("/api/info");
