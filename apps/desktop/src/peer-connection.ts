import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basicAuth, type CredentialStorage } from "./connection-config.js";
import { validateWebUrl } from "./policy.js";
import { openPeerSocket, PeerConnectionError, type PeerSocket } from "./peer-socket.js";
export { PeerConnectionError } from "./peer-socket.js";

export function openPeerCredentials(directory: string, storage: CredentialStorage) {
  const file = join(directory, "desktop-peers.json");
  const available = () => storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text";
  const stored = () => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, string> : {};
  return {
    get(origin: string): string | undefined {
      const value = stored()[validateWebUrl(origin)];
      if (!value) return undefined;
      if (!available()) throw new Error("设备协作凭据无法读取，请重新配对");
      const token = storage.decryptString(Buffer.from(value, "base64"));
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("设备协作凭据无效，请重新配对");
      return token;
    },
    save(origin: string, token: string) {
      if (!available() || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("无法安全保存设备协作凭据");
      const data = { ...stored(), [validateWebUrl(origin)]: storage.encryptString(token).toString("base64") };
      writeFileSync(file + ".tmp", JSON.stringify(data), { mode: 0o600 }); renameSync(file + ".tmp", file);
    },
  };
}
export function createAgentRequest(options: {
  origin(): string; serverId(): string; username(): string | undefined; password(): string | undefined;
  token(server: string): string | undefined; fetch(url: string, init: RequestInit): Promise<Response>;
  socket(url: string, headers: Record<string, string>, origin: string): PeerSocket;
}) {
  const connection = openPeerSocket({ socket: options.socket, target: () => {
    const server = options.serverId(), origin = options.origin();
    const token = options.token(server), authorization = token ? `Bearer ${token}` : basicAuth(options.username(), options.password());
    if (!authorization) throw new PeerConnectionError(401);
    const url = new URL("/api/peers/socket", origin); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { key: JSON.stringify([server, origin, authorization]), url: url.href, origin, headers: { authorization } };
  } });
  const request = async (path: string, body?: unknown, serverId?: string): Promise<unknown> => {
    const canonical = options.serverId(), origin = options.origin();
    if (serverId && serverId !== canonical) throw new Error("任务属于之前的服务器，请切回原服务器后继续");
    const target = new URL(path, origin), peer = target.pathname.startsWith("/api/peers/");
    if (target.origin !== origin || !(peer || (target.pathname === "/api/info" && body === undefined))) throw new Error("服务器接口地址无效");
    try { return await connection.request(path, body); }
    catch (error) {
      if (peer) throw error;
      // A read-only health probe distinguishes a reachable server from missing pairing.
      const authorization = basicAuth(options.username(), options.password());
      const response = await options.fetch(target.href, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000), headers: { origin, ...(authorization ? { authorization } : {}) } });
      if (!response.ok) throw new PeerConnectionError(response.status);
      return response.json();
    }
  };
  return Object.assign(request, { onChange: connection.onChange, close: connection.close });
}
