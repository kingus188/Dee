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
    import { mkdtemp, rm, readFile } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { pathToFileURL } from "node:url";
    const entry = pathToFileURL(process.argv[1]);
    const icon = await readFile(new URL("../assets/icon.png", entry));
    assert.equal(icon.subarray(1, 4).toString(), "PNG", "Packaged desktop icon");
    const { readConfig, startServer } = await import(import.meta.resolve("@assistant/server", entry.href));
    const dataDir = await mkdtemp(join(tmpdir(), "pi-desktop-smoke-"));
    let service;
    try {
      service = await startServer(readConfig({ NODE_ENV: "test", LLM_API: "faux", DATA_DIR: dataDir, PORT: "0", NOTIFY_MODE: "off" }), "127.0.0.1", new URL("../../web/dist/", entry));
      for (const path of ["/", "/app.js", "/style.css", "/tasks.css", "/workspace.css", "/assets/icons.svg", "/assets/orb-reference.png", "/api/info", "/api/settings/model"]) {
        assert.equal((await fetch(service.origin + path)).status, 200, path);
      }
      const settings = await (await fetch(service.origin + "/api/settings/model")).json();
      assert.equal(Object.hasOwn(settings, "apiKey"), false, "Settings must not expose credentials");
      await service.close();
      service = await startServer(readConfig({ DATA_DIR: dataDir, PORT: "0", NOTIFY_MODE: "off" }), "127.0.0.1", new URL("../../web/dist/", entry));
      const info = await (await fetch(service.origin + "/api/info")).json();
      assert.equal(info.configured, false, "First launch opens setup without model credentials");
      assert.equal((await fetch(service.origin + "/api/settings/model")).status, 200);
      assert.equal((await fetch(service.origin + "/api/conversations/direct", { method: "POST" })).status, 409);
      console.log("Desktop package entry, service and assets: PASS");
    } finally {
      await service?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  `, entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", timeout: 30_000 });
}
