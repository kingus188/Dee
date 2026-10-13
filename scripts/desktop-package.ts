import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packager } from "@electron/packager";
import { root, workspacePaths } from "./workspaces.js";
import { verifyDesktopPackage } from "./desktop-smoke.js";

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const desktop = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
const stage = await mkdtemp(join(root, ".build/desktop-stage-"));
try {
  // Copy an explicit build allowlist so local data, credentials and source files never enter the app.
  await writeFile(join(stage, "package.json"), JSON.stringify({ ...manifest, main: "apps/desktop/dist/main.js" }, null, 2));
  await cp(join(root, "pnpm-lock.yaml"), join(stage, "pnpm-lock.yaml"));
  await cp(join(root, "pnpm-workspace.yaml"), join(stage, "pnpm-workspace.yaml"));
  await cp(join(root, "LICENSE"), join(stage, "LICENSE"));
  await cp(join(root, "apps/desktop/assets"), join(stage, "apps/desktop/assets"), { recursive: true });
  for (const workspace of workspacePaths()) {
    await mkdir(join(stage, workspace), { recursive: true });
    await cp(join(root, workspace, "package.json"), join(stage, workspace, "package.json"));
    await cp(join(root, workspace, "dist"), join(stage, workspace, "dist"), {
      recursive: true, filter: path => !/\.(?:map|ts|tsbuildinfo)$/.test(path),
    });
  }
  // Use a self-contained flat production layout for the app archive.
  execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.nodeLinker=hoisted"], { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
  const outputs = await packager({
    dir: stage, out: join(root, "dist/desktop"), name: "Pi Durable Assistant",
    executableName: "Pi Durable Assistant", appBundleId: "com.pi-durable.assistant",
    icon: join(root, "apps/desktop/assets/icon"),
    appVersion: manifest.version, electronVersion: desktop.devDependencies.electron,
    asar: true, prune: false, overwrite: true,
  });
  for (const output of outputs) {
    verifyDesktopPackage(output);
    console.log(output);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
