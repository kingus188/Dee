import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const entry = new URL("../dist/main.js", import.meta.url);
const nativeRequire = createRequire(entry);
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
type MenuItem = { label?: string; submenu?: MenuItem[]; click?: () => void };

async function desktop(options: { offline?: boolean; invalidEnvironment?: boolean; brokenPin?: boolean; noSavedConnection?: boolean; environment?: Record<string, string> } = {}) {
  const windows: FakeWindow[] = [];
  const state = { offline: options.offline ?? false, notifications: 0, errors: 0 };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const saved: { config: { url: string; username?: string }; secret?: string }[] = [];
  let menu: MenuItem[] = [];
  class FakeWindow extends EventEmitter {
    visible = true;
    minimized = false;
    destroyed = false;
    urls: string[] = [];
    webContents = Object.assign(new EventEmitter(), {
      url: "", mainFrame: { url: "" },
      getURL: () => this.webContents.url,
      setWindowOpenHandler: () => {},
    });
    constructor(readonly options: { title: string; show?: boolean }) {
      super(); this.visible = options.show !== false; windows.push(this);
    }
    async loadURL(url: string) {
      this.urls.push(url); this.webContents.url = url; this.webContents.mainFrame.url = url;
      if (state.offline && url.startsWith("https:")) {
        this.webContents.emit("did-fail-load", {}, -109, "ERR_ADDRESS_UNREACHABLE", url, true);
        throw Object.assign(new Error("ERR_ADDRESS_UNREACHABLE"), { code: "ERR_ADDRESS_UNREACHABLE" });
      }
      this.webContents.emit("did-finish-load");
    }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    isVisible() { return this.visible && !this.minimized; }
    isMinimized() { return this.minimized; }
    isDestroyed() { return this.destroyed; }
    restore() { this.minimized = false; }
    minimize() { this.minimized = true; }
    close() { this.destroy(); }
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
  }
  const app = Object.assign(new EventEmitter(), {
    name: "Pi Durable Assistant", setName() {},
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), isReady: () => true,
    getPath: () => "/synthetic-desktop-state", quit() {}, dock: { setIcon() {} },
  });
  const web = {
    setCertificateVerifyProc() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeSendHeaders() {} }, fetch: async () => new Response(),
  };
  const electron = {
    app, BrowserWindow: FakeWindow,
    dialog: { showErrorBox() { state.errors++; } },
    ipcMain: { handle(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); } },
    Menu: { buildFromTemplate: (items: MenuItem[]) => items, setApplicationMenu(items: MenuItem[]) { menu = items; } },
    Notification: { isSupported: () => false }, session: { fromPartition: () => web }, shell: { openExternal: async () => {} },
  };
  // Run the real entry point without reading any user configuration.
  const source = readFileSync(entry, "utf8").replaceAll("import.meta.url", JSON.stringify(entry.href));
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, {
    exports: {}, URL, Buffer, console, setImmediate,
    process: { platform: "darwin", env: options.invalidEnvironment ? { ASSISTANT_WEB_URL: "invalid" } : options.environment ?? {} },
    require(specifier: string) {
      if (specifier === "electron") return electron;
      if (specifier === "./skills/catalog.js") return { LocalSkillCatalog: class {} };
      if (specifier === "./skills-ipc.js") return { registerLocalSkills() {} };
      if (specifier === "./connection.js") return {
        loadConnection: () => options.noSavedConnection ? {} : ({ config: { url: "https://assistant.example", username: "fixture" } }),
        saveConnection: (config: { url: string; username?: string }, secret?: string) => { saved.push({ config, secret }); return { persistedPassword: true }; },
      };
      if (specifier === "./mail-notifications.js") return { startMailNotifications: () => { state.notifications++; return () => {}; }, showMailNotification() {} };
      if (specifier === "node:fs") return { existsSync: () => Boolean(options.brokenPin), readFileSync: () => "malformed-public-pin" };
      return nativeRequire(specifier);
    },
  }, { filename: fileURLToPath(entry) });
  await flush(); await flush();
  const main = () => windows.filter(w => !w.destroyed && w.options.title !== "连接小 D").at(-1)!;
  const settings = () => windows.filter(w => !w.destroyed && w.options.title === "连接小 D");
  const openSettings = () => { const item = menu[0]?.submenu?.find(item => item.label === "连接设置…"); assert.ok(item?.click); item.click(); };
  return { app, windows, main, settings, openSettings, state, handlers, flush, saved };
}

test("new installations load the API backend directly on port 3000", async () => {
  const d = await desktop({ noSavedConnection: true });
  assert.ok(d.main().urls.includes("http://127.0.0.1:3000"));
  assert.equal(d.settings().length, 0);
});

for (const [environment, expected] of [
  [{ ASSISTANT_SERVER_URL: "https://backend.example", ASSISTANT_WEB_URL: "https://legacy.example" }, "https://backend.example"],
  [{ ASSISTANT_WEB_URL: "https://legacy.example" }, "https://legacy.example"],
] as const) {
  test(`environment chooses ${expected}`, async () => {
    const d = await desktop({ environment });
    assert.ok(d.main().urls.includes(expected));
    d.openSettings();
    const settings = d.settings()[0]!;
    const loaded = d.handlers.get("desktop:connection-load")!({ sender: settings.webContents, senderFrame: settings.webContents.mainFrame }) as { url: string; username?: string };
    assert.equal(loaded.url, expected);
    assert.equal(loaded.username, undefined);
  });
}

test("saved connection starts in the main window without a connection dialog", async () => {
  const d = await desktop();
  assert.equal(d.main().isVisible(), true);
  assert.ok(d.main().urls.includes("https://assistant.example"));
  assert.equal(d.settings().length, 0);
  assert.equal(d.state.notifications, 1);
});

for (const event of ["activate", "second-instance"]) {
  test(`${event} restores a minimized main window instead of opening connection settings`, async () => {
    const d = await desktop(); const original = d.main(); original.minimize();
    d.app.emit(event); await d.flush();
    assert.equal(d.main(), original);
    assert.equal(original.isMinimized(), false);
    assert.equal(original.isVisible(), true);
    assert.equal(d.settings().length, 0);
  });
  test(`${event} recreates a closed main window with the saved connection`, async () => {
    const d = await desktop(); const original = d.main(); original.close();
    d.app.emit(event); await d.flush(); await d.flush();
    assert.notEqual(d.main(), original);
    assert.ok(d.main()?.urls.includes("https://assistant.example"));
    assert.equal(d.main()?.isVisible(), true);
    assert.equal(d.settings().length, 0);
  });
}

test("startup network failure stays in a visible main window with retry, not a settings popup", async () => {
  const d = await desktop({ offline: true });
  assert.equal(d.settings().length, 0);
  assert.equal(d.main().isVisible(), true);
  const page = decodeURIComponent(d.main().urls.at(-1)!);
  assert.match(page, /重新连接/); assert.match(page, /https:\/\/assistant.example/);
  d.state.offline = false; await d.main().loadURL("https://assistant.example");
  assert.equal(d.state.notifications, 1);
  assert.equal(d.settings().length, 0);
});

test("only the manual menu opens connection settings; retry closes it after successful connection", async () => {
  const d = await desktop(); d.openSettings();
  assert.equal(d.settings().length, 1);
  const settings = d.settings()[0]!;
  await d.handlers.get("desktop:connection-retry")!({ sender: settings.webContents, senderFrame: settings.webContents.mainFrame });
  assert.equal(d.settings().length, 0);
  assert.equal(d.main().isVisible(), true);
});

test("failed manual retry returns to the main window rather than reopening settings", async () => {
  const d = await desktop(); d.openSettings(); const settings = d.settings()[0]!;
  d.state.offline = true;
  await d.handlers.get("desktop:connection-retry")!({ sender: settings.webContents, senderFrame: settings.webContents.mainFrame });
  assert.equal(d.main().isVisible(), true);
  assert.equal(d.settings().length, 0);
  assert.match(decodeURIComponent(d.main().urls.at(-1)!), /重新连接/);
});

for (const options of [{ invalidEnvironment: true }, { brokenPin: true }, { environment: { ASSISTANT_SERVER_URL: "invalid", ASSISTANT_WEB_URL: "https://legacy.example" } }]) {
  test(`initialization errors stay in the main window: ${JSON.stringify(options)}`, async () => {
    const d = await desktop(options);
    assert.equal(d.settings().length, 0);
    assert.equal(d.main()?.isVisible(), true);
    assert.equal(d.state.errors, 0);
  });
}

test("subframe errors, aborted loads, and stale windows leave the current main window intact", async () => {
  const d = await desktop(); const old = d.main();
  old.webContents.emit("did-fail-load", {}, -109, "subframe", "https://assistant.example/frame", false);
  old.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://assistant.example", true);
  assert.equal(d.settings().length, 0);
  d.openSettings(); const settings = d.settings()[0]!;
  await d.handlers.get("desktop:connection-retry")!({ sender: settings.webContents, senderFrame: settings.webContents.mainFrame });
  const current = d.main();
  old.webContents.emit("did-fail-load", {}, -109, "old main", "https://assistant.example", true);
  assert.equal(d.main(), current); assert.equal(current.isVisible(), true);
  assert.equal(d.settings().length, 0);
});

test("retry IPC rejects callers other than the trusted connection page", async () => {
  const d = await desktop();
  await assert.rejects(async () => d.handlers.get("desktop:connection-retry")!({ sender: {}, senderFrame: {} }), /Untrusted connection window/);
});

test("manual settings reuse their window and preserve validation and connection changes", async () => {
  const d = await desktop(); d.openSettings(); d.openSettings();
  assert.equal(d.settings().length, 1);
  const settings = d.settings()[0]!;
  const event = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame };
  const load = () => d.handlers.get("desktop:connection-load")!(event) as { url: string };
  const save = (value: unknown) => d.handlers.get("desktop:connection-save")!(event, value) as { ok: boolean };
  assert.equal(load().url, "https://assistant.example");
  for (const input of [null, "invalid", { url: 1 }, { url: "https://assistant.example", username: 1 }, { url: "https://assistant.example", username: "bad:name" }, { url: "http://remote.example" }]) {
    assert.equal(save(input).ok, false);
    assert.equal(load().url, "https://assistant.example");
  }
  assert.equal(save({ url: "https://changed.example", username: "fixture" }).ok, true);
  assert.equal(load().url, "https://changed.example");
  await d.handlers.get("desktop:connection-retry")!(event);
  assert.ok(d.main().urls.includes("https://changed.example"));
  assert.equal(d.settings().length, 0);
  for (const name of ["desktop:connection-load", "desktop:connection-save"]) {
    assert.throws(() => d.handlers.get(name)!({ sender: {}, senderFrame: {} }, {}), /Untrusted connection window/);
  }
});

test("settings page switches the native server without carrying previous credentials", async () => {
  const d = await desktop();
  const original = d.main();
  const event = { sender: original.webContents, senderFrame: original.webContents.mainFrame };
  let prevented = false;
  original.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://backend.example");
  assert.equal(prevented, true);
  const result = d.handlers.get("desktop:server-connect")!(event, "https://backend.example/") as { ok: boolean };
  assert.equal(result.ok, true);
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0]!.config.url, "https://backend.example");
  assert.equal(d.saved[0]!.config.username, undefined);
  assert.equal(d.saved[0]!.secret, undefined);
  await d.flush(); await d.flush();
  assert.equal(original.isDestroyed(), true);
  assert.ok(d.main().urls.includes("https://backend.example"));
  assert.throws(() => d.handlers.get("desktop:server-connect")!(event, "https://stale.example"), /Untrusted server connection window/);
});

test("server switch only accepts a trusted top frame and a valid backend root", async () => {
  const d = await desktop();
  const current = d.main();
  const change = d.handlers.get("desktop:server-connect")!;
  const event = { sender: current.webContents, senderFrame: current.webContents.mainFrame };
  for (const caller of [{ sender: {}, senderFrame: {} }, { sender: current.webContents, senderFrame: { url: "https://assistant.example" } }]) {
    assert.throws(() => change(caller, "https://backend.example"), /Untrusted server connection window/);
  }
  current.webContents.mainFrame.url = "https://foreign.example";
  assert.throws(() => change(event, "https://backend.example"), /Untrusted server connection window/);
  current.webContents.mainFrame.url = "https://assistant.example/#settings";
  for (const input of [null, 42, "http://remote.example", "https://backend.example/path", "https://backend.example?token=x"]) {
    assert.equal((change(event, input) as { ok: boolean }).ok, false);
  }
  assert.equal(d.saved.length, 0);
  assert.equal(d.main(), current);
});
