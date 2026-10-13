import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function verifyDesktopPackage(directory: string) {
  const name = "Pi Durable Assistant";
  const executable = process.platform === "darwin"
    ? join(directory, name + ".app/Contents/MacOS", name)
    : join(directory, name + (process.platform === "win32" ? ".exe" : ""));
  const resources = process.platform === "darwin" ? name + ".app/Contents/Resources" : "resources";
  const entry = join(directory, resources, "app.asar/apps/desktop/dist/main.js");
  // Resolve through the desktop entry, including the packaged workspace links.
  execFileSync(executable, ["--experimental-import-meta-resolve", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const entry = pathToFileURL(process.argv[1]);
    const { readConfig, startServer } = await import(import.meta.resolve("@assistant/server", entry.href));
    const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-smoke-"));
    let service;
    try {
      service = await startServer(readConfig({ LLM_API: "faux", DATA_DIR: dataDir, PORT: "0", NOTIFY_MODE: "off" }), "127.0.0.1", new URL("../../web/dist/", entry));
      for (const path of ["/", "/app.js", "/style.css", "/tasks.css", "/api/info"]) {
        assert.equal((await fetch(service.origin + path)).status, 200, path);
      }
      console.log("Desktop package entry, service and assets: PASS");
    } finally {
      await service?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  `, entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", timeout: 30_000 });
}
