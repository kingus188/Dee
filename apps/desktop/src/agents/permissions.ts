import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname } from "node:path";
import type { AgentPermissionParameter, ExternalAgentConfig } from "@assistant/contracts";
import { resolveAgentExecutable } from "./process.js";

export function parsePermissionParameters(kind: string, help: string): AgentPermissionParameter[] {
  function section(flag: string) {
    const start = help.indexOf(flag);
    if (start < 0) throw new Error("Agent 未提供权限参数说明");
    return help.slice(start).split(/\n\s{0,6}-(?=[a-z-])/)[0]!;
  }
  if (kind === "claude") {
    const choices = section("--permission-mode").match(/choices:\s*([\s\S]*?)\)/)?.[1];
    if (!choices) throw new Error("无法读取 Claude 权限模式");
    // The installed SDK cannot pass CLI-only modes such as manual.
    const sdk = new Set(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);
    const values = [...choices.matchAll(/"([^"]+)"/g)].map(match => match[1]!).filter(value => sdk.has(value));
    if (!values.length) throw new Error("当前 SDK 不支持 CLI 提供的权限模式");
    return [{ parameter: "permissionMode", values }];
  }
  if (kind !== "codex") return [];
  const sandbox = section("--sandbox").match(/possible values:\s*([^\]]+)/i)?.[1]?.split(",").map(value => value.trim()) ?? [];
  const approval = [...section("--ask-for-approval").matchAll(/^\s*- ([a-z-]+):/gm)].map(match => match[1]!);
  if (!sandbox.length || !approval.length) throw new Error("无法读取 Codex 权限参数");
  return [{ parameter: "sandbox", values: sandbox }, { parameter: "approvalPolicy", values: approval }];
}

export async function readAgentPermissions(kind: string, config: ExternalAgentConfig, searchPath?: string, env?: NodeJS.ProcessEnv) {
  const command = resolveAgentExecutable(config.executable, searchPath);
  const { stdout } = await promisify(execFile)(command, ["--help"], { env: env && { ...env, PATH: [env.PATH, searchPath, dirname(command)].filter(Boolean).join(delimiter) }, timeout: 10000, maxBuffer: 1024 * 1024 });
  return parsePermissionParameters(kind, stdout);
}
