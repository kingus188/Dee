import { execFile, spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

function nvmBins(home: string): string[] {
  const directory = join(home, ".nvm/versions/node");
  try {
    return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })).map(entry => join(directory, entry.name, "bin"));
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}
export function resolveAgentExecutable(executable: string, searchPath = "", home = homedir()): string {
  if (!executable.trim() || /[\r\n\0]/.test(executable)) throw new Error("请先配置 Agent 可执行文件");
  const paths = isAbsolute(executable) ? [executable] : executable.includes("/") || executable.includes("\\") ? [] :
    [...searchPath.split(delimiter).filter(isAbsolute), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", ...nvmBins(home)].flatMap(directory => process.platform === "win32" ? [join(directory, executable), join(directory, `${executable}.exe`)] : [join(directory, executable)]);
  for (const path of paths) {
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch (error) {
      if (!["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("找不到 Agent 可执行文件，请安装后填写绝对路径");
}
export function spawnAgent(executable: string, args: string[], cwd: string, searchPath?: string, env?: NodeJS.ProcessEnv) {
  const command = resolveAgentExecutable(executable, searchPath);
  // Finder omits npm/nvm bins; env-based shebangs need the selected CLI's sibling interpreter.
  const child = spawn(command, args, { cwd, env: env && { ...env, PATH: [env.PATH, searchPath, dirname(command)].filter(Boolean).join(delimiter) }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  // CLI stderr may contain credentials; protocol failures are reported without echoing it.
  child.stderr.resume();
  return child;
}
const stopping = new WeakMap<ReturnType<typeof spawnAgent>, Promise<void>>();
export function stopAgent(child: ReturnType<typeof spawnAgent>): Promise<void> {
  const previous = stopping.get(child); if (previous) return previous;
  const stopped = (async () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve, reject) => execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 3000, windowsHide: true }, error => error ? reject(new Error("无法确认 Agent 进程树已停止")) : resolve()));
      return;
    }
    function group(signal: NodeJS.Signals | 0): boolean {
      try { process.kill(-child.pid!, signal); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    }
    // Kill the owned process group even when a wrapper has already exited.
    group("SIGTERM");
    const deadline = Date.now() + 2500, forceAt = Date.now() + 1500;
    while (group(0)) {
      if (Date.now() >= forceAt) group("SIGKILL");
      if (Date.now() >= deadline) throw new Error("无法确认 Agent 及其工具进程已停止，请核对工作区");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })();
  stopping.set(child, stopped); return stopped;
}
