import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../..");

export function workspacePaths(): string[] {
  const projects = JSON.parse(execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
    cwd: root, encoding: "utf8", shell: process.platform === "win32",
  })) as { path: string }[];
  return projects.filter(project => resolve(project.path) !== root).map(project => relative(root, project.path).replaceAll("\\", "/"));
}
