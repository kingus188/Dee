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
type MenuItem = { id?: string; label?: string; submenu?: MenuItem[]; click?: () => void };

async function desktop(options: { notificationsSupported?: boolean; offline?: boolean; invalidEnvironment?: boolean; brokenPin?: boolean; noSavedConnection?: boolean; connectionError?: boolean; environment?: Record<string, string>; lan?: boolean; lanLoadFails?: boolean } = {}) {
  const windows: FakeWindow[] = [];
  let agentRegistered = false;
  let agentWindow: (() => FakeWindow | undefined) | undefined;
  let agentRequest: ((path: string) => Promise<unknown>) | undefined;
  let localProtocolRegistered = false;
  const state = { offline: options.offline ?? false, notifications: 0, errors: 0, storageName: "", keychainReads: 0, edits: [] as string[], agentCloses: 0, quitCalls: 0 };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const saved: { config: { url: string; username?: string }; secret?: string }[] = [];
  let menu: MenuItem[] | null = [];
  let reportMailStatus: ((status: unknown) => void) | undefined;
  let headersHook!: (details: { url: string; requestHeaders: Record<string, string> }, callback: (result: { requestHeaders: Record<string, string> }) => void) => void;
  class FakeWindow extends EventEmitter {
    visible = true;
    minimized = false;
    destroyed = false;
    urls: string[] = [];
    webContents = Object.assign(new EventEmitter(), {
      url: "", mainFrame: { url: "" }, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      getURL: () => this.webContents.url,
      getTitle: () => "",
      setWindowOpenHandler: () => {},
      copy: () => state.edits.push("copy"), cut: () => state.edits.push("cut"), paste: () => state.edits.push("paste"),
      selectAll: () => state.edits.push("selectAll"), undo: () => state.edits.push("undo"), redo: () => state.edits.push("redo"),
    });
    constructor(readonly options: { title: string; show?: boolean; frame?: boolean; titleBarStyle?: string; titleBarOverlay?: unknown; webPreferences?: { partition?: string } }) {
      super(); this.visible = options.show !== false; windows.push(this);
    }
    async loadURL(url: string) {
      if (!url.startsWith("file:")) assert.equal(agentRegistered, true, "Agent IPC must be ready before App loads");
      if (url.startsWith("dee:")) {
        assert.equal(this.options.webPreferences?.partition, "persist:desktop-web");
        assert.equal(localProtocolRegistered, true, "dee handler must belong to the workspace session");
      }
      this.urls.push(url); this.webContents.url = url; this.webContents.mainFrame.url = url;
      if ((state.offline && url.startsWith("https:")) || (options.lanLoadFails && url.startsWith("https://192.168.31.5:3443"))) {
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
  const paths = new Map<string, string>([["appData", "/synthetic-app-data"]]);
  const app = Object.assign(new EventEmitter(), {
    commandLine: { getSwitchValue: () => "" },
    name: "Pi Durable Assistant", setName(name: string) { this.name = name; },
    requestSingleInstanceLock: () => true, whenReady: () => { state.storageName = app.name; return Promise.resolve(); }, isReady: () => true,
    getPath: (name: string) => paths.get(name) ?? "/synthetic-desktop-state",
    setPath: (name: string, path: string) => { paths.set(name, path); },
    quit() { state.quitCalls++; }, dock: { setIcon() {} },
  });
  const web = {
    protocol: { handle(scheme: string) { assert.equal(scheme, "dee"); localProtocolRegistered = true; } },
    setCertificateVerifyProc() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeSendHeaders(handler: typeof headersHook) { headersHook = handler; } }, fetch: async () => new Response(),
  };
  let openServer: ((hash?: string) => Promise<void>) | undefined;
  const electron = {
    get safeStorage(): never { state.keychainReads++; throw new Error("System keychain must not be accessed"); },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} }, net: { fetch: async () => new Response() },
    app, BrowserWindow: FakeWindow,
    dialog: { showErrorBox() { state.errors++; } },
    ipcMain: { handle(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); } },
    Menu: { setApplicationMenu(items: MenuItem[] | null) { menu = items; } },
    Notification: { isSupported: () => options.notificationsSupported ?? true }, session: { fromPartition: () => web }, shell: { openExternal: async () => {} },
  };
  // Run the real entry point without reading any user configuration.
  const source = readFileSync(entry, "utf8").replaceAll("import.meta.url", JSON.stringify(entry.href));
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, {
    exports: {}, URL, Buffer, console, setImmediate,
    process: { platform: "darwin", env: options.invalidEnvironment ? { ASSISTANT_WEB_URL: "invalid" } : options.environment ?? {} },
    require(specifier: string) {
      if (specifier === "./agent-ipc.js") return { registerDesktopAgent: async (input: { openServer(hash?: string): Promise<void>; getWindow(): FakeWindow | undefined; request(path: string): Promise<unknown> }) => { openServer = input.openServer; agentWindow = input.getWindow; agentRequest = input.request; agentRegistered = true; return { close: async () => { state.agentCloses++; } }; } };
      if (specifier === "electron") return electron;
      if (specifier === "./skills/catalog.js") return { LocalSkillCatalog: class {} };
      if (specifier === "./skills-ipc.js") return { registerLocalSkills() {} };
      if (specifier === "./network.js" && options.lan) return { selectServer: async () => ({ origin: "https://192.168.31.5:3443", lanUrl: "https://192.168.31.5:3443" }) };
      if (specifier === "./connection.js") return {
        loadConnection: () => ({ ...(!options.noSavedConnection ? { config: { url: "https://assistant.example", username: "fixture" }, ...(options.lan ? { password: "fixture-secret" } : {}) } : {}), ...(options.connectionError ? { error: "连接读取失败，请打开连接设置" } : {}) }),
        saveConnection: (config: { url: string; username?: string }, secret?: string) => { saved.push({ config, secret }); return { persistedPassword: true }; },
      };
      if (specifier === "./mail-notifications.js") return { startMailNotifications: (...args: unknown[]) => { state.notifications++; reportMailStatus = args[4] as (status: unknown) => void; return () => {}; }, showMailNotification() {} };
      if (specifier === "node:fs") return { existsSync: () => Boolean(options.brokenPin), mkdirSync() {}, readFileSync: () => "malformed-public-pin" };
      return nativeRequire(specifier);
    },
  }, { filename: fileURLToPath(entry) });
  await flush(); await flush();
  // Observe startup itself; never destroy or replace a workspace on behalf of the app.
  const main = () => windows.filter(w => !w.destroyed && w.options.title !== "连接 Dee").at(-1)!;
  const settings = () => windows.filter(w => !w.destroyed && w.options.title === "连接 Dee");
  const openSettings = () => main().webContents.emit("before-input-event", { preventDefault() {} }, { meta: true, key: ",", type: "keyDown" });
  return { openServer, agentWindow, agentRequest, app, windows, main, settings, openSettings, state, handlers, flush, saved, headersHook,
    menu: () => menu,
    mailStatus: () => handlers.get("desktop:notification-status")!({ sender: main().webContents, senderFrame: main().webContents.mainFrame }),
    reportMailStatus: (status: unknown) => reportMailStatus?.(status),
  };
}

test("quit waits for windows to close before stopping Agent and repeated quit cannot bypass cleanup", async () => {
  const desktopApp = await desktop();
  let prevented = 0;
  const event = { preventDefault() { prevented++; } };
  desktopApp.app.emit("before-quit", event);
  assert.equal(prevented, 0, "normal window close and unsaved-change handling must run first");
  assert.equal(desktopApp.state.agentCloses, 0, "cancelled window closure must leave Agent available");
  desktopApp.main().close();
  desktopApp.app.emit("will-quit", event);
  desktopApp.app.emit("will-quit", event);
  assert.equal(prevented, 2, "every quit request must wait for the same cleanup");
  assert.equal(desktopApp.state.agentCloses, 1);
  assert.equal(desktopApp.state.quitCalls, 0);
  await desktopApp.flush();
  assert.equal(desktopApp.state.quitCalls, 1);
  desktopApp.app.emit("will-quit", event);
  assert.equal(prevented, 2, "the final quit is allowed after cleanup");
  assert.equal(desktopApp.state.agentCloses, 1);
});

test("device credential lookup never accesses the system keychain", async () => {
  const desktopApp = await desktop();
  assert.ok(desktopApp.agentRequest);
  await assert.rejects(desktopApp.agentRequest("/api/peers/bootstrap"));
  assert.equal(desktopApp.state.keychainReads, 0);
});

test("startup and server navigation use one workspace with its local Agent bridge", async () => {
  const d = await desktop({ lan: true });
  const local = d.main();
  assert.equal(local.webContents.getURL(), "https://192.168.31.5:3443");
  assert.equal(d.agentWindow!(), local);
  await d.openServer!("#tasks");
  assert.equal(d.windows.length, 1);
  const server = d.main();
  assert.equal(local, server); assert.equal(local.destroyed, false);
  assert.equal(server.webContents.getURL(), "https://192.168.31.5:3443/#tasks");
  const count = d.windows.length;
  server.minimize();
  await d.openServer!("#notes");
  assert.equal(d.main(), server); assert.equal(d.windows.length, count);
  assert.equal(server.isMinimized(), false); assert.equal(server.isVisible(), true);
  assert.equal(server.webContents.getURL(), "https://192.168.31.5:3443/#notes");
  await d.openServer!();
  assert.equal(server.webContents.getURL(), "https://192.168.31.5:3443/#notes");
  assert.equal(local.destroyed, false);
});

test("server navigation reports offline state and retries when the network returns", async () => {
  const d = await desktop({ offline: true });
  const local = d.main();
  await assert.rejects(d.openServer!("#tasks"), /服务器未连接/);
  assert.equal(local.destroyed, false);
  d.state.offline = false;
  await d.openServer!("#activity");
  assert.equal(d.main().webContents.getURL(), "https://assistant.example/#activity");
  assert.equal(local.destroyed, false);
});

test("LAN detection changes only the active route, preserves the configured server and scopes credentials", async () => {
  const d = await desktop({ lan: true });
  const origin = "https://192.168.31.5:3443";
  assert.ok(d.main().urls.includes(origin));
  assert.equal(d.saved.length, 1);
  assert.equal(d.saved[0]!.config.url, "https://assistant.example");
  assert.equal((d.saved[0]!.config as { lanUrl?: string }).lanUrl, origin);
  for (const [url, expected] of [[origin + "/api/info", true], ["wss://192.168.31.5:3443/api/socket", true], ["https://assistant.example/api/info", false], ["https://192.168.31.5:3444/api/info", false]]) {
    let headers: Record<string, string> = {};
    d.headersHook({ url: url as string, requestHeaders: { Authorization: "untrusted" } }, result => { headers = result.requestHeaders; });
    assert.equal(Boolean(headers.Authorization), expected);
    assert.notEqual(headers.Authorization, "untrusted");
  }
  const current = d.main();
  assert.equal((d.handlers.get("desktop:server-connect")!({ sender: current.webContents, senderFrame: current.webContents.mainFrame }, origin) as { ok: boolean }).ok, true);
  assert.equal(d.saved.length, 1, "saving the active alias must not replace the logical server or clear credentials");
});

test("frameless workspace removes the native menu and keeps trusted connection settings", async () => {
  const d = await desktop();
  assert.equal(d.menu(), null);
  assert.equal(d.main().options.frame, false);
  assert.equal(d.main().options.titleBarStyle, "hidden");
  assert.ok(d.main().options.titleBarOverlay);
  let prevented = 0;
  for (const [key, shift] of [["c", false], ["x", false], ["v", false], ["a", false], ["z", false], ["z", true]] as const) {
    d.main().webContents.emit("before-input-event", { preventDefault() { prevented++; } }, { meta: true, type: "keyDown", key, shift });
  }
  assert.deepEqual(d.state.edits, ["copy", "cut", "paste", "selectAll", "undo", "redo"]);
  assert.equal(prevented, 6);
  for (const name of ["desktop:connection-open", "desktop:notification-status"]) {
    assert.throws(() => d.handlers.get(name)!({ sender: {}, senderFrame: {} }), /Untrusted/);
    assert.throws(() => d.handlers.get(name)!({ sender: d.main().webContents, senderFrame: { url: "https://assistant.example" } }), /Untrusted/);
  }
  d.handlers.get("desktop:connection-open")!({ sender: d.main().webContents, senderFrame: d.main().webContents.mainFrame });
  assert.equal(d.settings().length, 1);
});

test("a failed LAN page load falls back to the public server in the same window", async () => {
  const d = await desktop({ lan: true, lanLoadFails: true });
  assert.ok(d.main().urls.includes("https://192.168.31.5:3443"));
  assert.equal(d.main().urls.at(-1), "https://assistant.example");
  assert.equal(d.windows.filter(window => !window.destroyed).length, 1);
  assert.equal(d.settings().length, 0);
});

test("Dee keeps the existing desktop state directory after renaming", async () => {
  const d = await desktop();
  assert.equal(d.app.name, "Dee");
  assert.equal(d.state.storageName, "Pi Durable Assistant");
  assert.equal(d.app.getPath("userData"), "/synthetic-app-data/Pi Durable Assistant");
  assert.ok(d.main().urls.includes("https://assistant.example"));
});

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
  assert.equal(d.main().options.webPreferences?.partition, "persist:desktop-web");
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

test("startup network failure loads the offline App in the same workspace with settings available", async () => {
  const d = await desktop({ offline: true });
  assert.equal(d.settings().length, 0);
  assert.equal(d.main().isVisible(), true);
  assert.equal(d.main().webContents.getURL(), "dee://local/");
  assert.equal(d.agentWindow!(), d.main());
  assert.equal(d.windows.length, 1);
  d.handlers.get("desktop:connection-open")!({ sender: d.main().webContents, senderFrame: d.main().webContents.mainFrame });
  assert.equal(d.settings().length, 1);
  d.settings()[0]!.close();
  d.state.offline = false; await d.main().loadURL("https://assistant.example"); await flush(); await flush();
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
  assert.equal(d.main().webContents.getURL(), "dee://local/");
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
  old.close(); d.app.emit("activate"); await d.flush(); await d.flush();
  const current = d.main();
  const urls = [...current.urls];
  old.webContents.emit("did-fail-load", {}, -109, "old main", "https://assistant.example", true);
  assert.equal(d.main(), current); assert.equal(current.isVisible(), true);
  assert.deepEqual(current.urls, urls);
  for (const name of ["desktop:connection-open", "desktop:server-connect", "desktop:notification-status"]) {
    assert.throws(() => d.handlers.get(name)!({ sender: old.webContents, senderFrame: old.webContents.mainFrame }), /Untrusted/);
  }
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
  assert.equal(original.isDestroyed(), false);
  assert.equal(d.main(), original);
  assert.ok(d.main().urls.includes("https://backend.example"));
  const stale = { sender: {}, senderFrame: original.webContents.mainFrame };
  assert.throws(() => d.handlers.get("desktop:server-connect")!(stale, "https://stale.example"), /Untrusted server connection window/);
});

test("offline workspace reconnects to the same configured server without replacing its window", async () => {
  const d = await desktop();
  const current = d.main();
  current.webContents.mainFrame.url = "dee://local/#settings";
  const before = current.urls.length;
  const result = d.handlers.get("desktop:server-connect")!({ sender: current.webContents, senderFrame: current.webContents.mainFrame }, "https://assistant.example") as { ok: boolean };
  assert.equal(result.ok, true);
  await d.flush(); await d.flush();
  assert.equal(d.main(), current);
  assert.ok(current.urls.length > before);
  assert.equal(current.urls.at(-1), "https://assistant.example");
  assert.equal(d.saved.length, 0, "重连同一服务器不能清除原账号配置");
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


test("mail polling status stays available to settings without opening dialogs or replacing the workspace", async () => {
  const d = await desktop();
  const current = d.main(), urls = [...current.urls];
  assert.equal(d.mailStatus(), "邮件提醒：正在连接");
  d.reportMailStatus({ state: "retrying", reason: "timeout" });
  assert.equal(d.mailStatus(), "邮件提醒：连接超时，正在自动重试");
  d.reportMailStatus({ state: "retrying", reason: "authorization" });
  assert.equal(d.mailStatus(), "邮件提醒：认证失败，请检查连接设置");
  d.reportMailStatus({ state: "retrying", reason: "unavailable" });
  assert.equal(d.mailStatus(), "邮件提醒：连接中断，正在自动重试");
  d.reportMailStatus({ state: "connected" });
  assert.equal(d.mailStatus(), "邮件提醒：已连接");
  assert.equal(d.main(), current); assert.deepEqual(current.urls, urls);
  assert.equal(d.settings().length, 0); assert.equal(d.state.errors, 0);
});


test("unsupported native notifications do not claim shared deliveries and leave Web fallback available", async () => {
  const d = await desktop({ notificationsSupported: false });
  assert.equal(d.state.notifications, 0);
  assert.equal(d.mailStatus(), "邮件提醒：系统通知不可用，请使用网页提醒");
  assert.ok(d.main().urls.includes("https://assistant.example"));
  await d.main().loadURL("https://assistant.example");
  assert.equal(d.state.notifications, 0);
});
for (const noSavedConnection of [false, true]) {
  test(`connection read failure skips backend and opens the offline workspace (${noSavedConnection})`, async () => {
    const d = await desktop({ connectionError: true, noSavedConnection });
    assert.equal(d.settings().length, 0);
    assert.ok(d.main().urls.every(url => url.startsWith("file:") || url === "dee://local/"));
    assert.equal(d.main().urls.at(-1), "dee://local/");
    assert.match(new URL(d.main().urls.find(url => url.startsWith("file:"))!).searchParams.get("message")!, /连接读取失败/);
    let prevented = false;
    d.main().webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, noSavedConnection ? "http://127.0.0.1:3000" : "https://assistant.example");
    assert.equal(prevented, true);
    d.main().close(); d.app.emit("activate"); await d.flush(); await d.flush();
    assert.equal(d.main().urls.at(-1), "dee://local/");
    assert.ok(d.main().urls.every(url => url.startsWith("file:") || url === "dee://local/"));
    await d.openServer?.(); d.openSettings(); const settings = d.settings()[0]!;
    const event = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame };
    assert.equal((d.handlers.get("desktop:connection-save")!(event, { url: "https://assistant.example", username: "fixture", password: "fixture" }) as { ok: boolean }).ok, true);
    await d.handlers.get("desktop:connection-retry")!(event);
    assert.ok(d.main().urls.includes("https://assistant.example"));
  });
}
