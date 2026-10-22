import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
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
let config: ConnectionConfig = { url: "http://127.0.0.1:8080" };
let password: string | undefined;
let stopNotifications = () => {};

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

async function connect() {
  stopNotifications();
  if (window) { window.destroy(); window = undefined; }
  const current = new BrowserWindow({ title: "小 D · 个人数字人助手", width: 1200, height: 820, minWidth: 720, minHeight: 560, icon, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, partition: "desktop-web" } });
  window = current;
  const origin = config.url;
  current.on("closed", () => { if (window === current) window = undefined; });
  current.webContents.on("will-navigate", (event, url) => { if (!isAppUrl(url, origin)) event.preventDefault(); });
  current.webContents.on("will-redirect", (event, url) => { if (!isAppUrl(url, origin)) event.preventDefault(); });
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  current.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3 && window === current) { current.hide(); showConnection(); }
  });
  try {
    await current.loadURL(origin);
    if (window !== current) return;
    current.show(); settings?.close();
    stopNotifications = startMailNotifications(origin, basicAuth(config.username, password), (title, body) => {
      if (Notification.isSupported()) showMailNotification(new Notification({ title, body, timeoutType: "default" }));
    }, (input, init) => session.fromPartition("desktop-web").fetch(String(input), init));
  } catch { if (window === current) { current.hide(); showConnection(); } }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (window?.isVisible()) { window.restore(); window.focus(); } else showConnection(); });
  app.on("activate", () => { if (window?.isVisible()) window.focus(); else showConnection(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", () => { stopNotifications(); });
  void app.whenReady().then(async () => {
    app.dock?.setIcon(icon);
    const loaded = loadConnection();
    if (loaded.config) config = loaded.config;
    password = loaded.password;
    let invalidEnvironment = false;
    if (process.env.ASSISTANT_WEB_URL) {
      try {
        const url = validateWebUrl(process.env.ASSISTANT_WEB_URL);
        // Never reuse saved credentials for an environment-selected different origin.
        if (url !== config.url) { config = { url }; password = undefined; } else config.url = url;
      } catch { invalidEnvironment = true; }
    }
    const web = session.fromPartition("desktop-web");
    const certificatePath = join(app.getPath("userData"), "desktop-certificate.json");
    const pin: unknown = existsSync(certificatePath) ? JSON.parse(readFileSync(certificatePath, "utf8")) : undefined;
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
    // Do not amend response headers: the independent Web service owns its CSP.
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [{ label: "连接设置…", click: showConnection }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" }, { role: "viewMenu" },
    ]));
    if (invalidEnvironment) {
      showConnection();
      dialog.showErrorBox("连接地址无效", "ASSISTANT_WEB_URL 必须为 HTTPS 或本机 HTTP 根地址。请重新设置连接。");
    } else await connect();
  }).catch(() => { showConnection(); dialog.showErrorBox("连接配置无效", "请重新设置 Web 服务地址。"); });
}
