import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { DesktopAgentKind, DesktopAgentSelection, ExternalAgentConfig } from "@assistant/contracts";

export type AgentSettings = { nodeId: string; workspace: string | null; agent: DesktopAgentKind; agents: Record<Exclude<DesktopAgentKind, "pi">, ExternalAgentConfig> };
export function validateAgentSelection(input: unknown): DesktopAgentSelection {
  if (!input || typeof input !== "object") throw new Error("Agent 配置无效");
  const { kind, config } = input as DesktopAgentSelection;
  if (!["pi", "codex", "claude", "acp", "omp"].includes(kind)) throw new Error("Agent 类型无效");
  if (kind === "pi" || config === undefined) return { kind };
  if (!config || typeof config.executable !== "string" || !config.executable.trim() || config.executable.length > 4096 || /[\r\n\0]/.test(config.executable) || !Array.isArray(config.args) || config.args.length > 32 || config.args.some(arg => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0"))) throw new Error("请填写可执行文件和逐行参数");
  if (kind !== "acp" && config.args.length) throw new Error("原生 Agent 不接受额外启动参数");
  if (config.mode !== undefined && (typeof config.mode !== "string" || config.mode.length > 200)) throw new Error("ACP 模式无效");
  if (config.permission !== undefined && (!["codex", "claude"].includes(kind) || !["default", "readOnly", "autoEdit"].includes(config.permission) || (kind === "claude" && config.permission === "readOnly"))) throw new Error("权限设置无效");
  if (config.effort !== undefined && (typeof config.effort !== "string" || !config.effort.trim() || config.effort.length > 100 || /[\r\n\0]/.test(config.effort) || !["codex", "claude"].includes(kind))) throw new Error("思考强度无效");
  if (config.model !== undefined && (typeof config.model !== "string" || !config.model.trim() || config.model.length > 200 || /[\r\n\0]/.test(config.model) || !["codex", "claude"].includes(kind))) throw new Error("模型无效");
  for (const key of ["permissionMode", "sandbox", "approvalPolicy"] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "string" || !/^[a-zA-Z-]{1,100}$/.test(value) || (key === "permissionMode" ? kind !== "claude" : kind !== "codex"))) throw new Error("原生权限参数无效");
  }
  return { kind, config: { executable: config.executable.trim(), args: [...config.args], ...(config.model ? { model: config.model } : {}), ...(config.permission ? { permission: config.permission } : {}), ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}), ...(config.sandbox ? { sandbox: config.sandbox } : {}), ...(config.approvalPolicy ? { approvalPolicy: config.approvalPolicy } : {}), ...(config.effort ? { effort: config.effort } : {}), ...(kind === "acp" && config.mode ? { mode: config.mode } : {}) } };
}
export function openAgentSettings(directory: string) {
  const path = join(directory, "desktop-agent.json");
  const defaultWorkspace = join(directory, "local-agent", "workspace");
  let settings: AgentSettings = { nodeId: `desktop-${randomUUID()}`, workspace: defaultWorkspace, agent: "pi", agents: { codex: { executable: "codex", args: [] }, claude: { executable: "claude", args: [] }, omp: { executable: "omp", args: [] }, acp: { executable: "", args: [] } } };
  let legacy: Record<string, unknown> = {};
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as { nodeId: unknown; workspace: unknown; model?: unknown; encryptedKey?: unknown; agent?: DesktopAgentKind; agents?: AgentSettings["agents"] };
    if (typeof stored.nodeId !== "string" || !/^desktop-[0-9a-f-]{36}$/i.test(stored.nodeId) || (stored.workspace !== null && (typeof stored.workspace !== "string" || !isAbsolute(stored.workspace)))) throw new Error("本机 Agent 配置损坏，原文件已保留");
    // Preserve legacy model data for rollback without decrypting or using it.
    legacy = { ...(stored.model !== undefined ? { model: stored.model } : {}), ...(stored.encryptedKey !== undefined ? { encryptedKey: stored.encryptedKey } : {}) };
    const agent = validateAgentSelection({ kind: stored.agent ?? "pi" }).kind;
    for (const kind of ["codex", "claude", "acp", "omp"] as const) if (stored.agents?.[kind]?.executable) settings.agents[kind] = validateAgentSelection({ kind, config: stored.agents[kind] }).config!;
    settings = { ...settings, nodeId: stored.nodeId, workspace: (stored.workspace as string | null) ?? defaultWorkspace, agent };
  }
  if (settings.workspace === defaultWorkspace) mkdirSync(defaultWorkspace, { recursive: true, mode: 0o700 });
  function persist(next: AgentSettings) {
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...legacy, ...next }), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    settings = next;
  }
  if (!existsSync(path)) persist(settings);
  return { get: () => settings,
    selectAgent: (input: unknown) => { const selected = validateAgentSelection(input); persist({ ...settings, agent: selected.kind, agents: selected.kind === "pi" || !selected.config ? settings.agents : { ...settings.agents, [selected.kind]: selected.config } }); },
    saveWorkspace: (workspace: string) => { if (!isAbsolute(workspace)) throw new Error("工作目录须为绝对路径"); persist({ ...settings, workspace }); } };
}
