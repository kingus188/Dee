import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
import { LocalSkillCatalog } from "./skills/catalog.js";
import { registerLocalSkills } from "./skills-ipc.js";
import { connectionStatusPage } from "./connection-status.js";
import type { IpcMainInvokeEvent } from "electron";
import { fileURLToPath } from "node:url";
import { loadConnection, saveConnection } from "./connection.js";
import { basicAuth, type ConnectionConfig } from "./connection-config.js";
import { isAppConnection, isAppUrl, isExternalUrl, validateWebUrl } from "./policy.js";
import { isPinnedCertificate } from "./certificate-trust.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { showMailNotification, startMailNotifications } from "./mail-notifications.js";

app.setName("Pi Durable Assistant");
const icon = fileURLToPath(new URL("../assets/icon.png", import.meta.url));
const connectionPage = new URL("../connection.html", import.meta.url).href;
let window: BrowserWindow | undefined;
let settings: BrowserWindow | undefined;
let config: ConnectionConfig = { url: "http://127.0.0.1:3000" };
let password: string | undefined;
let stopNotifications = () => {};
let initialized = false;

function showConnection() {
  if (settings) { settings.show(); settings.focus(); return; }
  const current = new BrowserWindow({ title: "连接小 D", width: 660, height: 650, icon,
    webPreferences: { preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } });
  settings = current;
  current.on("closed", () => { settings = undefined; });
  current.webContents.on("will-navigate", event => event.preventDefault());
  current.webContents.on("will-redirect", event => event.preventDefault());
  current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void current.loadURL(connectionPage);
}

function trustedSettings(event: IpcMainInvokeEvent) {
  return Boolean(settings && event.sender === settings.webContents && event.senderFrame === settings.webContents.mainFrame && event.senderFrame.url === connectionPage);
}

async function connect(initialError?: string) {
  stopNotifications();
  settings?.close();
  if (window) { window.destroy(); window = undefined; }
  const current = new BrowserWindow({ title: "小 D · 你的个人智能助手", width: 1200, height: 820, minWidth: 720, minHeight: 560, icon,
    webPreferences: { preload: fileURLToPath(new URL("./skills-preload.cjs", import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, partition: "desktop-web" } });
  window = current;
  const origin = config.url;
  let failed = false;
  const showFailure = () => {
    if (window !== current || current.isDestroyed() || failed) return;
    failed = true;
    stopNotifications();
    void current.loadURL(connectionStatusPage(origin, "服务暂时未连接。请确认网络和服务状态，然后重新连接；已保存的连接配置会继续保留。"))
      .catch(error => console.error("Desktop connection status page failed to load", error));
  };
  current.on("closed", () => { if (window === current) window = undefined; });
  current.webContents.on("will-navigate", (event, url) => { if (!isAppUrl(url, origin)) event.preventDefault(); });
  current.webContents.on("will-redirect", (event, url) => { if (!isAppUrl(url, origin)) event.preventDefault(); });
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  current.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) showFailure();
  });
  current.webContents.on("did-finish-load", () => {
    if (window !== current || !isAppUrl(current.webContents.getURL().split("#")[0] ?? "", origin)) return;
    failed = false;
    stopNotifications();
    stopNotifications = startMailNotifications(origin, basicAuth(config.username, password), (title, body) => {
      if (Notification.isSupported()) showMailNotification(new Notification({ title, body, timeoutType: "default" }));
    }, (input, init) => session.fromPartition("desktop-web").fetch(String(input), init));
  });
  try {
    await current.loadURL(connectionStatusPage(origin, initialError));
    if (initialError || window !== current) return;
    await current.loadURL(origin);
  } catch { showFailure(); }
}

function showMainWindow() {
  if (!initialized) return;
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  } else void connect();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showMainWindow);
  app.on("activate", showMainWindow);
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", () => { stopNotifications(); });
  void app.whenReady().then(async () => {
    app.dock?.setIcon(icon);
    const loaded = loadConnection();
    if (loaded.config) config = loaded.config;
    password = loaded.password;
    let startupError: string | undefined;
    const serverUrl = process.env.ASSISTANT_SERVER_URL || process.env.ASSISTANT_WEB_URL;
    if (serverUrl) {
      try {
        const url = validateWebUrl(serverUrl);
        // Never reuse saved credentials for an environment-selected different origin.
        if (url !== config.url) { config = { url }; password = undefined; } else config.url = url;
      } catch { startupError = "连接地址设置无效。请从应用菜单手动打开「连接设置…」，检查后台服务器地址。"; }
    }
    const web = session.fromPartition("desktop-web");
    const certificatePath = join(app.getPath("userData"), "desktop-certificate.json");
    let pin: unknown;
    try { pin = existsSync(certificatePath) ? JSON.parse(readFileSync(certificatePath, "utf8")) : undefined; }
    catch { startupError = "本机证书配置读取失败。请检查服务证书配置后重试；连接设置仍可从应用菜单手动打开。"; }
    web.setCertificateVerifyProc((request, callback) => {
      const trusted = request.errorCode === 0 || isPinnedCertificate(config.url, pin, request.hostname, request.certificate.data);
      callback(trusted ? 0 : -2);
    });
    web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    web.setPermissionCheckHandler(() => false);
    web.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders;
      for (const name of Object.keys(headers)) if (name.toLowerCase() === "authorization") delete headers[name];
      const authorization = basicAuth(config.username, password);
      if (authorization && isAppConnection(details.url, config.url)) headers.Authorization = authorization;
      callback({ requestHeaders: headers });
    });
    // Do not amend response headers: the selected server owns its CSP.
    ipcMain.handle("desktop:server-connect", (event, input: unknown) => {
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        !isAppUrl(event.senderFrame.url.split("#")[0] ?? "", config.url)) throw new Error("Untrusted server connection window");
      try {
        if (typeof input !== "string") throw new Error("Invalid server address");
        const next = { url: validateWebUrl(input) };
        if (next.url === config.url) return { ok: true };
        saveConnection(next, undefined);
        config = next; password = undefined;
        // Reply before replacing the invoking renderer. A new origin gets no previous credentials.
        setImmediate(() => { void connect().catch(error => console.error("Desktop server connection failed", error)); });
        return { ok: true };
      } catch { return { ok: false, error: "保存后台地址失败，请检查地址格式和配置目录权限。" }; }
    });
    ipcMain.handle("desktop:connection-load", event => {
      if (!trustedSettings(event)) throw new Error("Untrusted connection window");
      return config;
    });
    ipcMain.handle("desktop:connection-save", (event, input: unknown) => {
      if (!trustedSettings(event)) throw new Error("Untrusted connection window");
      try {
        if (!input || typeof input !== "object") throw new Error("连接配置无效");
        const value = input as Record<string, unknown>;
        if (typeof value.url !== "string" || (value.username !== undefined && typeof value.username !== "string") || (value.password !== undefined && typeof value.password !== "string")) throw new Error("连接配置无效");
        if (typeof value.username === "string" && /[:\r\n]/.test(value.username)) throw new Error("用户名不得包含冒号或换行");
        const next = { url: validateWebUrl(value.url), username: value.username as string | undefined };
        const nextPassword = value.password as string | undefined;
        const saved = saveConnection(next, nextPassword);
        config = next; password = nextPassword;
        return { ok: true, persistedPassword: saved.persistedPassword };
      } catch { return { ok: false, error: "无法保存连接。请使用 HTTPS 或本机 HTTP 根地址，并检查配置目录权限。" }; }
    });
    ipcMain.handle("desktop:connection-retry", async event => {
      if (!trustedSettings(event)) throw new Error("Untrusted connection window");
      await connect();
    });
    registerLocalSkills({ ipc: ipcMain, dialog, shell,
      catalog: new LocalSkillCatalog({ home: app.getPath("home"), stateFile: join(app.getPath("userData"), "local-skills.json") }),
      getWindow: () => window, getOrigin: () => config.url,
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ label: "连接设置…", click: showConnection }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" }, { role: "viewMenu" },
    ]));
    initialized = true;
    await connect(startupError);
  }).catch(error => {
    console.error("Desktop initialization failed", error);
    initialized = true;
    void connect("连接初始化失败。请从应用菜单检查连接设置，或重新启动小 D。")
      .catch(failure => console.error("Desktop main window failed to open", failure));
  });
}
