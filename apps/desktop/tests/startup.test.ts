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

async function desktop(options: { localOnly?: boolean; notificationsSupported?: boolean; offline?: boolean; invalidEnvironment?: boolean; brokenPin?: boolean; noSavedConnection?: boolean; connectionError?: boolean; environment?: Record<string, string>; lan?: boolean; lanLoadFails?: boolean } = {}) {
  const windows: FakeWindow[] = [];
  const state = { offline: options.offline ?? false, notifications: 0, errors: 0, storageName: "", edits: [] as string[] };
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
      setWindowOpenHandler: () => {},
      copy: () => state.edits.push("copy"), cut: () => state.edits.push("cut"), paste: () => state.edits.push("paste"),
      selectAll: () => state.edits.push("selectAll"), undo: () => state.edits.push("undo"), redo: () => state.edits.push("redo"),
    });
    constructor(readonly options: { title: string; show?: boolean; frame?: boolean; titleBarStyle?: string; titleBarOverlay?: unknown; webPreferences?: { partition?: string } }) {
      super(); this.visible = options.show !== false; windows.push(this);
    }
    async loadURL(url: string) {
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
    quit() {}, dock: { setIcon() {} },
  });
  const web = {
    setCertificateVerifyProc() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeSendHeaders(handler: typeof headersHook) { headersHook = handler; } }, fetch: async () => new Response(),
  };
  let openServer: (() => Promise<void>) | undefined;
  let localWindow: (() => FakeWindow | undefined) | undefined;
  const electron = {
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
      if (specifier === "./agent-ipc.js") return { registerDesktopAgent: async (input: { openServer(): Promise<void>; getWindow(): FakeWindow | undefined }) => { openServer = input.openServer; localWindow = input.getWindow; return { close: async () => {} }; } };
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
  if (!options.localOnly) { localWindow?.()?.destroy(); await openServer?.(); await flush(); }
  const main = () => windows.filter(w => !w.destroyed && w.options.title !== "连接 Dee").at(-1)!;
  const settings = () => windows.filter(w => !w.destroyed && w.options.title === "连接 Dee");
  const openSettings = () => main().webContents.emit("before-input-event", { preventDefault() {} }, { meta: true, key: ",", type: "keyDown" });
  return { openServer, app, windows, main, settings, openSettings, state, handlers, flush, saved, headersHook,
    menu: () => menu,
    mailStatus: () => handlers.get("desktop:notification-status")!({ sender: main().webContents, senderFrame: main().webContents.mainFrame }),
    reportMailStatus: (status: unknown) => reportMailStatus?.(status),
  };
}

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
    const d = await desktop({ localOnly: true }); const original = d.main(); original.minimize();
    d.app.emit(event); await d.flush();
    assert.equal(d.main(), original);
    assert.equal(original.isMinimized(), false);
    assert.equal(original.isVisible(), true);
    assert.equal(d.settings().length, 0);
  });
  test(`${event} recreates a closed main window with the saved connection`, async () => {
    const d = await desktop({ localOnly: true }); const original = d.main(); original.close();
    d.app.emit(event); await d.flush(); await d.flush();
    assert.notEqual(d.main(), original);
    assert.ok(d.main()?.urls.includes("dee://local/"));
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
  test(`connection read failure never navigates to a backend or falls back to another app (${noSavedConnection})`, async () => {
    const d = await desktop({ connectionError: true, noSavedConnection });
    assert.equal(d.settings().length, 0);
    assert.ok(d.main().urls.every(url => url.startsWith("data:")));
    assert.match(decodeURIComponent(d.main().urls.at(-1)!), /连接读取失败/);
    assert.doesNotMatch(decodeURIComponent(d.main().urls.at(-1)!), /href=/);
    let prevented = false;
    d.main().webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, noSavedConnection ? "http://127.0.0.1:3000" : "https://assistant.example");
    assert.equal(prevented, true);
    d.main().close(); d.app.emit("activate"); await d.flush(); await d.flush();
    assert.ok(d.main().urls.every(url => url === "dee://local/"));
    await d.openServer?.(); d.openSettings(); const settings = d.settings()[0]!;
    const event = { sender: settings.webContents, senderFrame: settings.webContents.mainFrame };
    assert.equal((d.handlers.get("desktop:connection-save")!(event, { url: "https://assistant.example", username: "fixture", password: "fixture" }) as { ok: boolean }).ok, true);
    await d.handlers.get("desktop:connection-retry")!(event);
    assert.ok(d.main().urls.includes("https://assistant.example"));
  });
}
