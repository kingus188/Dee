import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DesktopAgentKind, DesktopAgentSelection, DesktopPiEffort, ExternalAgentConfig } from "@assistant/contracts";

export type AgentSettings = { nodeId: string; workspace: string | null; agent: DesktopAgentKind; permissionDefaultsVersion?: number; piAccess?: "ask" | "full"; piEffort?: DesktopPiEffort | null; piModel?: { provider: string; modelId: string } | null; agents: Record<Exclude<DesktopAgentKind, "pi">, ExternalAgentConfig> };
function fullAccess(kind: Exclude<DesktopAgentKind, "pi">, config: ExternalAgentConfig): ExternalAgentConfig {
  if (kind === "codex") return { ...config, permission: undefined, sandbox: "danger-full-access", approvalPolicy: "never" };
  if (kind === "claude") return { ...config, permission: undefined, permissionMode: "bypassPermissions" };
  return { ...config, mode: undefined, access: "full" };
}
function withDefaultAccess(kind: Exclude<DesktopAgentKind, "pi">, config: ExternalAgentConfig) {
  if (kind === "codex") return config.permission || config.sandbox || config.approvalPolicy ? config : fullAccess(kind, config);
  if (kind === "claude") return config.permission || config.permissionMode ? config : fullAccess(kind, config);
  return { ...config, access: config.access ?? "full" as const };
}
export function validateAgentSelection(input: unknown): DesktopAgentSelection {
  if (!input || typeof input !== "object") throw new Error("Agent 配置无效");
  const { kind, config } = input as DesktopAgentSelection;
  if (!["pi", "codex", "claude", "acp", "omp"].includes(kind)) throw new Error("Agent 类型无效");
  if (kind === "pi") {
    const { piModel, piEffort, piAccess } = input as DesktopAgentSelection;
    if (piAccess !== undefined && !["ask", "full"].includes(piAccess)) throw new Error("权限设置无效");
    if (piEffort != null && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(piEffort)) throw new Error("思考强度无效");
    if (piModel != null && (![piModel.provider, piModel.modelId].every(value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n\0]/.test(value)))) throw new Error("模型无效");
    return { kind, ...(piModel !== undefined ? { piModel } : {}), ...(piEffort !== undefined ? { piEffort } : {}), ...(piAccess !== undefined ? { piAccess } : {}) };
  }
  if (config === undefined) return { kind };
  if (config?.access !== undefined && !["ask", "full"].includes(config.access)) throw new Error("权限设置无效");
  if (!config || typeof config.executable !== "string" || !config.executable.trim() || config.executable.length > 4096 || /[\r\n\0]/.test(config.executable) || !Array.isArray(config.args) || config.args.length > 32 || config.args.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) throw new Error("请填写可执行文件和逐行参数");
  if (kind !== "acp" && config.args.length) throw new Error("原生 Agent 不接受额外启动参数");
  if (config.mode !== undefined && (typeof config.mode !== "string" || config.mode.length > 200)) throw new Error("ACP 模式无效");
  if (config.permission !== undefined && (!["codex", "claude"].includes(kind) || !["default", "readOnly", "autoEdit"].includes(config.permission) || (kind === "claude" && config.permission === "readOnly"))) throw new Error("权限设置无效");
  if (config.effort !== undefined && (typeof config.effort !== "string" || !config.effort.trim() || config.effort.length > 100 || /[\r\n\0]/.test(config.effort) || !["codex", "claude", "omp"].includes(kind))) throw new Error("思考强度无效");
  if (config.model !== undefined && (typeof config.model !== "string" || !config.model.trim() || config.model.length > 200 || /[\r\n\0]/.test(config.model) || !["codex", "claude", "omp"].includes(kind))) throw new Error("模型无效");
  for (const key of ["permissionMode", "sandbox", "approvalPolicy"] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "string" || !/^[a-zA-Z-]{1,100}$/.test(value) || (key === "permissionMode" ? kind !== "claude" : kind !== "codex"))) throw new Error("原生权限参数无效");
  }
  return { kind, config: { ...(config.access ? { access: config.access } : {}), executable: config.executable.trim(), args: [...config.args], ...(config.model ? { model: config.model } : {}), ...(config.permission ? { permission: config.permission } : {}), ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}), ...(config.sandbox ? { sandbox: config.sandbox } : {}), ...(config.approvalPolicy ? { approvalPolicy: config.approvalPolicy } : {}), ...(config.effort ? { effort: config.effort } : {}), ...(kind === "acp" && config.mode ? { mode: config.mode } : {}) } };
}
export function openAgentSettings(directory: string) {
  const path = join(directory, "desktop-agent.json");
  const defaultWorkspace = join(directory, "local-agent", "workspace");
  let settings: AgentSettings = { nodeId: `desktop-${randomUUID()}`, workspace: defaultWorkspace, agent: "pi", agents: { codex: { executable: "codex", args: [] }, claude: { executable: "claude", args: [] }, omp: { executable: "omp", args: [] }, acp: { executable: "", args: [] } } };
  let legacy: Record<string, unknown> = {};
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { nodeId: unknown; workspace: unknown; model?: unknown; encryptedKey?: unknown; agent?: DesktopAgentKind; permissionDefaultsVersion?: number; piAccess?: "ask" | "full"; agents?: AgentSettings["agents"] };
    if (typeof stored.nodeId !== "string" || !/^desktop-[0-9a-f-]{36}$/i.test(stored.nodeId) || (stored.workspace !== null && (typeof stored.workspace !== "string" || !isAbsolute(stored.workspace)))) throw new Error("本机 Agent 配置损坏，原文件已保留");
    // Preserve legacy model data for rollback without decrypting or using it.
    legacy = { ...(stored.model !== undefined ? { model: stored.model } : {}), ...(stored.encryptedKey !== undefined ? { encryptedKey: stored.encryptedKey } : {}) };
    const agent = validateAgentSelection({ kind: stored.agent ?? "pi" }).kind;
    for (const kind of ["codex", "claude", "acp", "omp"] as const) if (stored.agents?.[kind]?.executable) settings.agents[kind] = withDefaultAccess(kind, validateAgentSelection({ kind, config: stored.agents[kind] }).config!);
    const { piModel, piEffort, piAccess } = validateAgentSelection({ kind: "pi", piModel: (stored as AgentSettings).piModel, piEffort: (stored as AgentSettings).piEffort, piAccess: stored.piAccess });
    settings = { ...settings, nodeId: stored.nodeId, workspace: (stored.workspace as string | null) ?? defaultWorkspace, agent, piModel, piEffort, piAccess, permissionDefaultsVersion: stored.permissionDefaultsVersion };
  }
  const migratePermissions = settings.permissionDefaultsVersion !== 1;
  if (migratePermissions) {
    const backup = path + ".before-full-access-v1";
    if (existsSync(path) && !existsSync(backup)) writeFileSync(backup, readFileSync(path), { mode: 0o600, flag: "wx" });
    settings = { ...settings, permissionDefaultsVersion: 1, piAccess: "full", agents: { ...settings.agents } };
    for (const kind of ["codex", "claude", "omp", "acp"] as const) settings.agents[kind] = fullAccess(kind, settings.agents[kind]);
  } else settings.piAccess ??= "full";
  if (settings.workspace === defaultWorkspace) mkdirSync(defaultWorkspace, { recursive: true, mode: 0o700 });
  function persist(next: AgentSettings) {
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...legacy, ...next }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    settings = next;
  }
  if (!existsSync(path) || migratePermissions) persist(settings);
  return { get: () => settings,
    selectAgent: (input: unknown) => { const selected = validateAgentSelection(input); persist({ ...settings, agent: selected.kind, ...(selected.piAccess !== undefined ? { piAccess: selected.piAccess } : {}), ...(selected.piEffort !== undefined ? { piEffort: selected.piEffort } : {}), ...(selected.piModel !== undefined ? { piModel: selected.piModel } : {}), agents: selected.kind === "pi" || !selected.config ? settings.agents : { ...settings.agents, [selected.kind]: withDefaultAccess(selected.kind, selected.config) } }); },
    saveWorkspace: (workspace: string) => { if (!isAbsolute(workspace)) throw new Error("工作目录须为绝对路径"); persist({ ...settings, workspace }); } };
}
