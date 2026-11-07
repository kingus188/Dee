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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { showMailNotification, startMailNotifications, type MailNotificationStatus } from "./mail-notifications.js";
import { selectServer } from "./network.js";

// Electron captures this name for safeStorage before ready; keep the existing keychain identity.
app.setName("Pi Durable Assistant");
// Keep existing connection settings, certificate pins and local skill state across the rename.
const userData = join(app.getPath("appData"), "Pi Durable Assistant");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
const icon = fileURLToPath(new URL("../assets/icon.png", import.meta.url));
const connectionPage = new URL("../connection.html", import.meta.url).href;
let window: BrowserWindow | undefined;
let settings: BrowserWindow | undefined;
let config: ConnectionConfig = { url: "http://127.0.0.1:3000" };
let activeOrigin = config.url;
let pin: unknown;
let password: string | undefined;
let startupError: string | undefined;
let stopNotifications = () => {};
let initialized = false;
const desktopPartition = "persist:desktop-web";
let mailNotificationLabel = "邮件提醒：等待服务连接";

function setMailNotificationLabel(label: string) {
  mailNotificationLabel = `邮件提醒：${label}`;
}

function showMailNotificationStatus(status: MailNotificationStatus) {
  setMailNotificationLabel(status.state === "connected" ? "已连接" :
    status.reason === "authorization" ? "认证失败，请检查连接设置" :
      status.reason === "timeout" ? "连接超时，正在自动重试" : "连接中断，正在自动重试");
}

function showConnection() {
  if (settings) { settings.show(); settings.focus(); return; }
  const current = new BrowserWindow({ title: "连接 Dee", width: 660, height: 650, icon,
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

async function connect(initialError = startupError) {
  stopNotifications();
  setMailNotificationLabel("等待服务连接");
  settings?.close();
  if (window) { window.destroy(); window = undefined; }
  const current = new BrowserWindow({ title: "Dee · 你的个人智能助手", width: 1440, height: 920, minWidth: 720, minHeight: 560, icon,
    frame: false, titleBarStyle: "hidden", trafficLightPosition: { x: 20, y: 19 },
    titleBarOverlay: { color: "#f6f8fc", symbolColor: "#49546a", height: 52 }, backgroundColor: "#f6f8fc",
    webPreferences: { preload: fileURLToPath(new URL("./skills-preload.cjs", import.meta.url)), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, partition: desktopPartition } });
  window = current;
  current.webContents.on("before-input-event", (event, input) => {
    if (!(process.platform === "darwin" ? input.meta : input.control) || input.type !== "keyDown") return;
    if (input.key === ",") { event.preventDefault(); showConnection(); }
    // Keep standard editing shortcuts after removing the native Edit menu on macOS.
    if (process.platform === "darwin") {
      const actions: Record<string, () => void> = { c: () => current.webContents.copy(), x: () => current.webContents.cut(),
        v: () => current.webContents.paste(), a: () => current.webContents.selectAll(),
        z: () => input.shift ? current.webContents.redo() : current.webContents.undo(), q: () => app.quit() };
      const action = actions[input.key.toLowerCase()];
      if (action) { event.preventDefault(); action(); }
    }
  });
  let origin = config.url;
  let failed = false, loading = true;
  const showFailure = () => {
    if (window !== current || current.isDestroyed() || failed) return;
    failed = true;
    stopNotifications();
    setMailNotificationLabel("等待服务连接");
    void current.loadURL(connectionStatusPage(origin, "服务暂时未连接。请确认网络和服务状态，然后重新连接；已保存的连接配置会继续保留。"))
      .catch(error => console.error("Desktop connection status page failed to load", error));
  };
  current.on("closed", () => { if (window === current) window = undefined; });
  current.webContents.on("will-navigate", (event, url) => { if (initialError || !isAppUrl(url, origin)) event.preventDefault(); });
  current.webContents.on("will-redirect", (event, url) => { if (initialError || !isAppUrl(url, origin)) event.preventDefault(); });
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  current.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3 && !loading) showFailure();
  });
  current.webContents.on("did-finish-load", () => {
    if (window !== current || !isAppUrl(current.webContents.getURL().split("#")[0] ?? "", origin)) return;
    failed = false;
    stopNotifications();
    if (!Notification.isSupported()) {
      setMailNotificationLabel("系统通知不可用，请使用网页提醒");
      return;
    }
    setMailNotificationLabel("正在连接");
    stopNotifications = startMailNotifications(origin, basicAuth(config.username, password), (title, body) => {
      if (!Notification.isSupported()) return false;
      return showMailNotification(new Notification({ title, body, timeoutType: "default" }));
    }, (input, init) => session.fromPartition(desktopPartition).fetch(String(input), init), showMailNotificationStatus);
  });
  try {
    await current.loadURL(connectionStatusPage(origin, initialError, !initialError));
    if (initialError || window !== current) return;
    const selectedConfig = config;
    const selected = await selectServer(config, pin, basicAuth(config.username, password));
    if (window !== current || config !== selectedConfig) return;
    origin = activeOrigin = selected.origin;
    if (selected.lanUrl && config.lanUrl !== selected.lanUrl) {
      config = { ...config, lanUrl: selected.lanUrl };
      try { saveConnection(config, password); }
      catch { console.warn("LAN connection verified but preference could not be saved"); }
    }
    try { await current.loadURL(origin); }
    catch {
      if (origin === config.url || window !== current) throw new Error("Server unavailable");
      origin = activeOrigin = config.url;
      await current.loadURL(origin);
    }
  } catch { showFailure(); }
  finally { loading = false; }
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
    app.setName("Dee");
    app.dock?.setIcon(icon);
    const loaded = loadConnection();
    if (loaded.config) config = loaded.config;
    password = loaded.password;
    startupError = loaded.error;
    const serverUrl = process.env.ASSISTANT_SERVER_URL || process.env.ASSISTANT_WEB_URL;
    if (serverUrl) {
      try {
        const url = validateWebUrl(serverUrl);
        // Never reuse saved credentials for an environment-selected different origin.
        if (url !== config.url) { config = { url }; password = undefined; startupError = undefined; } else config.url = url;
      } catch { startupError = "连接地址设置无效。请按 Cmd+,（Windows/Linux 使用 Ctrl+,）打开连接设置，检查后台服务器地址。"; }
    }
    const web = session.fromPartition(desktopPartition);
    activeOrigin = config.url;
    const certificatePath = join(app.getPath("userData"), "desktop-certificate.json");
    try { pin = existsSync(certificatePath) ? JSON.parse(readFileSync(certificatePath, "utf8")) : undefined; }
    catch { startupError = "本机证书配置读取失败。请检查服务证书配置后重试；按 Cmd+,（Windows/Linux 使用 Ctrl+,）可打开连接设置。"; }
    web.setCertificateVerifyProc((request, callback) => {
      const trusted = request.errorCode === 0 || isPinnedCertificate(activeOrigin, pin, request.hostname, request.certificate.data);
      callback(trusted ? 0 : -2);
    });
    web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    web.setPermissionCheckHandler(() => false);
    web.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders;
      for (const name of Object.keys(headers)) if (name.toLowerCase() === "authorization") delete headers[name];
      const authorization = basicAuth(config.username, password);
      if (authorization && isAppConnection(details.url, activeOrigin)) headers.Authorization = authorization;
      callback({ requestHeaders: headers });
    });
    // Do not amend response headers: the selected server owns its CSP.
    const trustedWorkspace = (event: IpcMainInvokeEvent) => Boolean(window && !window.isDestroyed() &&
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
      isAppUrl(event.senderFrame.url.split("#")[0] ?? "", activeOrigin));
    ipcMain.handle("desktop:connection-open", event => {
      if (!trustedWorkspace(event)) throw new Error("Untrusted connection window");
      showConnection();
    });
    ipcMain.handle("desktop:notification-status", event => {
      if (!trustedWorkspace(event)) throw new Error("Untrusted connection window");
      return mailNotificationLabel;
    });
    ipcMain.handle("desktop:server-connect", (event, input: unknown) => {
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        !isAppUrl(event.senderFrame.url.split("#")[0] ?? "", activeOrigin)) throw new Error("Untrusted server connection window");
      try {
        if (typeof input !== "string") throw new Error("Invalid server address");
        const next = { url: validateWebUrl(input) };
        if (next.url === config.url || next.url === activeOrigin) return { ok: true };
        saveConnection(next, undefined);
        config = next; activeOrigin = next.url; password = undefined; startupError = undefined;
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
        if (typeof value.url !== "string" || (value.username !== undefined && typeof value.username !== "string") || (value.password !== undefined && typeof value.password !== "string") || (value.lanUrl !== undefined && typeof value.lanUrl !== "string")) throw new Error("连接配置无效");
        if (typeof value.username === "string" && /[:\r\n]/.test(value.username)) throw new Error("用户名不得包含冒号或换行");
        const next: ConnectionConfig = { url: validateWebUrl(value.url), username: value.username as string | undefined,
          ...(value.lanUrl ? { lanUrl: value.lanUrl as string } : {}) };
        const nextPassword = value.password as string | undefined;
        const saved = saveConnection(next, nextPassword);
        config = next; activeOrigin = next.url; password = nextPassword; startupError = undefined;
        return { ok: true, persistedPassword: saved.persistedPassword };
      } catch { return { ok: false, error: "无法保存连接。请使用 HTTPS 或本机 HTTP 根地址，并检查配置目录权限。" }; }
    });
    ipcMain.handle("desktop:connection-retry", async event => {
      if (!trustedSettings(event)) throw new Error("Untrusted connection window");
      await connect();
    });
    registerLocalSkills({ ipc: ipcMain, dialog, shell,
      catalog: new LocalSkillCatalog({ home: app.getPath("home"), stateFile: join(app.getPath("userData"), "local-skills.json") }),
      getWindow: () => window, getOrigin: () => activeOrigin,
    });
    Menu.setApplicationMenu(null);
    initialized = true;
    await connect(startupError);
  }).catch(error => {
    console.error("Desktop initialization failed", error);
    initialized = true;
    void connect("连接初始化失败。请按 Cmd+,（Windows/Linux 使用 Ctrl+,）检查连接设置，或重新启动 Dee。")
      .catch(failure => console.error("Desktop main window failed to open", failure));
  });
}
