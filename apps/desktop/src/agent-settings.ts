import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DesktopModelInput } from "@assistant/contracts";
import type { CredentialStorage } from "./connection-config.js";

export type AgentSettings = { nodeId: string; workspace: string | null; model: Required<DesktopModelInput> };
export function validateDesktopModel(input: unknown, previousKey = ""): Required<DesktopModelInput> {
  if (!input || typeof input !== "object") throw new Error("模型配置无效");
  const value = input as Record<string, unknown>;
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(String(value.api))) throw new Error("模型协议无效");
  if (typeof value.baseUrl !== "string" || typeof value.model !== "string" || !value.model.trim() || value.model.length > 200) throw new Error("请填写模型地址和模型名称");
  const url = new URL(value.baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("模型地址须使用 HTTPS，本机接口可使用 HTTP");
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length > 8192)) throw new Error("模型密钥无效");
  for (const name of ["contextWindow", "maxTokens"]) if (!Number.isSafeInteger(value[name]) || Number(value[name]) < 1 || Number(value[name]) > 2_000_000) throw new Error("模型上下文或输出长度无效");
  if (Number(value.maxTokens) > Number(value.contextWindow)) throw new Error("输出长度不能超过上下文长度");
  return { api: String(value.api), baseUrl: url.href.replace(/\/$/, ""), model: value.model.trim(), apiKey: value.apiKey === undefined || value.apiKey === "" ? previousKey : String(value.apiKey), contextWindow: Number(value.contextWindow), maxTokens: Number(value.maxTokens) };
}
export function openAgentSettings(directory: string, storage: CredentialStorage) {
  const path = join(directory, "desktop-agent.json");
  let settings: AgentSettings = { nodeId: `desktop-${randomUUID()}`, workspace: null, model: { api: "openai-completions", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 } };
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { nodeId: unknown; workspace: unknown; model: Record<string, unknown>; encryptedKey?: string };
    if (typeof stored.nodeId !== "string" || !/^desktop-[0-9a-f-]{36}$/i.test(stored.nodeId) || (stored.workspace !== null && (typeof stored.workspace !== "string" || !isAbsolute(stored.workspace)))) throw new Error("本机 Agent 配置损坏，原文件已保留");
    let apiKey = "";
    if (stored.encryptedKey) {
      if (!storage.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === "basic_text") throw new Error("系统安全存储不可用，无法读取本机模型密钥");
      apiKey = storage.decryptString(Buffer.from(stored.encryptedKey, "base64"));
    }
    settings = { nodeId: stored.nodeId, workspace: stored.workspace as string | null, model: stored.model.baseUrl ? validateDesktopModel({ ...stored.model, apiKey }) : settings.model };
  }
  function persist(next: AgentSettings): { persistedKey: boolean } {
    const { apiKey, ...model } = next.model;
    const persistedKey = Boolean(apiKey && storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text");
    const encryptedKey = persistedKey ? storage.encryptString(apiKey).toString("base64") : undefined;
    writeFileSync(`${path}.tmp`, JSON.stringify({ nodeId: next.nodeId, workspace: next.workspace, model, encryptedKey }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    settings = next;
    return { persistedKey };
  }
  if (!existsSync(path)) persist(settings);
  return { get: () => settings, saveModel: (input: unknown) => persist({ ...settings, model: validateDesktopModel(input, settings.model.apiKey) }),
    saveWorkspace: (workspace: string) => { if (!isAbsolute(workspace)) throw new Error("工作目录须为绝对路径"); persist({ ...settings, workspace }); } };
}
