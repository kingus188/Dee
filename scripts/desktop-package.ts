import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packager } from "@electron/packager";
import { root } from "./workspaces.js";
import { verifyDesktopPackage } from "./desktop-smoke.js";
import { buildMacLauncher } from "./desktop-launcher.js";

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const desktop = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
const stage = await mkdtemp(join(root, ".build/desktop-stage-"));
try {
  // Copy an explicit build allowlist so local data, credentials and source files never enter the app.
  await writeFile(join(stage, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: "module", main: "apps/desktop/dist/main.js" }, null, 2));
  await writeFile(join(stage, "LICENSE"), await readFile(join(root, "LICENSE"), "utf8") + "\nNative macOS launcher portions Copyright (c) 2022 Slack Technologies, Inc.; licensed under the MIT license above.\n");
  await cp(join(root, "apps/desktop/assets"), join(stage, "apps/desktop/assets"), { recursive: true });
  for (const name of ["connection.html", "connection.js"]) await cp(join(root, "apps/desktop", name), join(stage, "apps/desktop", name));
  await mkdir(join(stage, "apps/desktop/dist"), { recursive: true });
  await cp(join(root, "apps/desktop/dist"), join(stage, "apps/desktop/dist"), {
    recursive: true, filter: path => !/\.(?:map|ts|tsbuildinfo)$/.test(path),
  });
  const outputs = await packager({
    dir: stage, out: join(root, "dist/desktop"), name: "Pi Durable Assistant",
    executableName: "Pi Durable Assistant", appBundleId: "com.pi-durable.assistant",
    extendInfo: { NSLocalNetworkUsageDescription: "用于连接您配置的局域网小 D 服务，显示消息并检查邮件提醒。" },
    icon: join(root, "apps/desktop/assets/icon"),
    appVersion: manifest.version, electronVersion: desktop.devDependencies.electron,
    asar: true, prune: false, overwrite: true,
  });
  for (const output of outputs) {
    if (process.platform === "darwin") buildMacLauncher(join(output, "Pi Durable Assistant.app"));
    verifyDesktopPackage(output);
    console.log(output);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
