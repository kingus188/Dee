import { findPackageJSON } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Models } from "@earendil-works/pi-ai";
import type { DesktopAgentSnapshot } from "@assistant/contracts";
import { createModelCatalog } from "@assistant/runtime";
import { resolveAgentExecutable } from "./agents/process.js";

export type PiModels = {
  models: Models; agentModel: { provider: string; modelId: string }; configured: boolean;
  model: DesktopAgentSnapshot["model"]; error?: string;
};
type PiSdk = {
  SettingsManager: { create(cwd: string, directory?: string): {
    getDefaultProvider(): string | undefined; getDefaultModel(): string | undefined; drainErrors(): unknown[];
  } };
  ModelRuntime: { create(options: { authPath?: string; modelsPath?: string; allowModelNetwork: false }): Promise<Models & {
    getError(): string | undefined; hasConfiguredAuth(provider: string): boolean;
  }> };
};

export async function loadPiModels(options: { cwd: string; searchPath?: string; env?: NodeJS.ProcessEnv; piModel?: { provider: string; modelId: string } | null }): Promise<PiModels> {
  const empty = { api: "openai-completions", baseUrl: "", model: "", apiKey: "", contextWindow: 128000, maxTokens: 8192 };
  const fallback = async (error: string): Promise<PiModels> => {
    const { apiKey, ...model } = empty;
    return { ...await createModelCatalog(empty), model: { ...model, hasApiKey: false }, error };
  };
  try {
    // Load the installed Pi SDK so provider composition and OAuth stay owned by Pi.
    const cli = realpathSync(resolveAgentExecutable("pi", options.searchPath));
    const manifest = findPackageJSON(pathToFileURL(cli).href);
    if (!manifest) throw new Error("Pi SDK unavailable");
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; main?: string };
    if (pkg.name !== "@earendil-works/pi-coding-agent" || !pkg.main) throw new Error("Pi SDK unavailable");
    const entry = resolve(dirname(manifest), pkg.main);
    const sdk = await import(pathToFileURL(entry).href) as PiSdk;
    const configuredDirectory = options.env?.PI_CODING_AGENT_DIR;
    const directory = configuredDirectory?.replace(/^~(?=$|\/)/, homedir());
    const settings = sdk.SettingsManager.create(options.cwd, directory);
    if (settings.drainErrors().length) return fallback("无法读取 Pi 配置，请在 Pi 中检查设置后重试。");
    const models = await sdk.ModelRuntime.create({ allowModelNetwork: false, ...(directory ? {
      authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"),
    } : {}) });
    if (models.getError()) return fallback("无法读取 Pi 模型配置，请在 Pi 中检查设置后重试。");
    const provider = options.piModel?.provider ?? settings.getDefaultProvider(), id = options.piModel?.modelId ?? settings.getDefaultModel();
    const model = provider && id ? models.getModel(provider, id) : undefined;
    if (!model) return { ...await fallback("请先选择 Pi 模型，或在 Pi 中配置默认模型。"), models };
    const configured = models.hasConfiguredAuth(model.provider);
    return { models, agentModel: { provider: model.provider, modelId: model.id }, configured,
      model: { api: model.api, baseUrl: "", model: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, hasApiKey: configured },
      ...(!configured ? { error: "请先在 Pi 中配置模型认证，然后重新选择 Pi。" } : {}),
    };
  } catch {
    return fallback("无法加载本机 Pi 配置，请检查 Pi 安装及 SDK 版本，然后重新选择 Pi。");
  }
}
