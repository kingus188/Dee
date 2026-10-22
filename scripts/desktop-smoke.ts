import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function verifyDesktopPackage(directory: string) {
  const name = "Pi Durable Assistant";
  const executable = process.platform === "darwin"
    ? join(directory, name + ".app/Contents/MacOS", name)
    : join(directory, name + (process.platform === "win32" ? ".exe" : ""));
  const resources = process.platform === "darwin" ? name + ".app/Contents/Resources" : "resources";
  const entry = join(directory, resources, "app.asar/apps/desktop/dist/main.js");
  if (process.platform === "darwin") {
    const description = execFileSync("/usr/bin/plutil", ["-extract", "NSLocalNetworkUsageDescription", "raw", "-o", "-", join(directory, name + ".app/Contents/Info.plist")], { encoding: "utf8" });
    if (!description.trim()) throw new Error("Desktop package is missing its local network usage description");
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(directory, name + ".app")], { stdio: "inherit" });
  }
  execFileSync(executable, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFile, readdir } from "node:fs/promises";
    import { pathToFileURL } from "node:url";
    const entry = pathToFileURL(process.argv[1]);
    const root = new URL("../../../", entry);
    assert.deepEqual((await readdir(new URL("apps/", root))).sort(), ["desktop"]);
    assert.deepEqual((await readdir(root)).sort(), ["LICENSE", "apps", "package.json"]);
    const icon = await readFile(new URL("../assets/icon.png", entry));
    assert.equal(icon.subarray(1, 4).toString(), "PNG");
    assert.match(await readFile(new URL("../connection.html", entry), "utf8"), /connection.js/);
    await readFile(new URL("../connection.js", entry));
    await readFile(new URL("./preload.cjs", entry));
    // Module URLs are selected from the runtime-created packaged application path.
    const { validateWebUrl, isAppConnection } = await import(new URL("./policy.js", entry));
    const { encodeConnection, decodeConnection } = await import(new URL("./connection-config.js", entry));
    assert.equal(validateWebUrl("https://assistant.example.com"), "https://assistant.example.com");
    assert.equal(isAppConnection("https://other.example.com/api/info", "https://assistant.example.com"), false);
    const storage = { isEncryptionAvailable: () => false, encryptString() { throw new Error("not available"); }, decryptString() { throw new Error("not available"); } };
    const encoded = encodeConnection({ url: "http://127.0.0.1:8080" }, "smoke-private-password", storage);
    assert.equal(encoded.persistedPassword, false);
    assert.equal(encoded.text.includes("smoke-private-password"), false);
    assert.equal(decodeConnection(encoded.text, storage).config.url, "http://127.0.0.1:8080");
    console.log("Desktop client package isolation, assets and connection policy: PASS");
  `, entry], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", timeout: 30_000 });
}
