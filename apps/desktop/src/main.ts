import { app, BrowserWindow, dialog, session, shell } from "electron";
import type { WebContents } from "electron";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, startServer } from "@assistant/server";
import { isAppConnection, isAppUrl, isExternalUrl } from "./policy.js";

app.setName("Pi Durable Assistant");
const icon = fileURLToPath(new URL("../assets/icon.png", import.meta.url));
let service: Awaited<ReturnType<typeof startServer>> | undefined;
let window: BrowserWindow | undefined;
let quitting = false;
let stopped = false;

function fail(message: string) {
  dialog.showErrorBox("小 D 启动失败", message);
  app.quit();
}

function secureContents(contents: WebContents, origin: string) {
  contents.on("will-navigate", (event, url) => { if (!isAppUrl(url, origin)) event.preventDefault(); });
  contents.on("will-redirect", (event, url) => { if (!isAppUrl(url, origin)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    // Image previews use same-origin links that open in a separate window.
    if (isAppUrl(url, origin)) return { action: "allow", overrideBrowserWindowOptions: {
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, partition: "desktop" },
    } };
    if (isExternalUrl(url)) {
      void shell.openExternal(url).catch(() => dialog.showErrorBox("无法打开链接", "请检查系统默认浏览器。"));
    }
    return { action: "deny" };
  });
  contents.on("did-create-window", child => secureContents(child.webContents, origin));
}

async function openWindow() {
  if (!service || quitting) return;
  if (window) { window.show(); window.focus(); return; }
  const current = new BrowserWindow({
    title: "小 D · 个人数字人助手", width: 1200, height: 820, minWidth: 720, minHeight: 560,
    show: false, backgroundColor: "#f7f7f8", icon,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, partition: "desktop" },
  });
  window = current;
  current.on("closed", () => { window = undefined; });
  current.once("ready-to-show", () => { if (!quitting) current.show(); });
  secureContents(current.webContents, service.origin);
  await current.loadURL(service.origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (window?.isMinimized()) window.restore(); void openWindow().catch(() => fail("界面加载失败，请重启应用。")); });
  app.on("activate", () => { void openWindow().catch(() => fail("界面加载失败，请重启应用。")); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", event => {
    if (stopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    // Wait for startup too, so quitting during initialization cannot leave storage open.
    const timeout = setTimeout(() => app.exit(1), 10_000);
    void startup.then(() => service?.close()).catch(() => {
      dialog.showErrorBox("小 D 退出异常", "本地服务未正常关闭，下次启动时将尝试恢复持久化任务。");
    }).finally(() => { clearTimeout(timeout); stopped = true; app.quit(); });
  });
  const startup = app.whenReady().then(async () => {
    if (quitting) return;
    app.dock?.setIcon(icon);
    const env = process.env;
    const config = readConfig({ ...env, NODE_ENV: "production" });
    config.port = 0;
    config.dataDir = join(app.getPath("userData"), "data");
    config.password = randomBytes(32).toString("hex");
    config.production = true;
    config.wechat.enabled = false;
    service = await startServer(config, "127.0.0.1", new URL("../../web/dist/", import.meta.url));
    const origin = service.origin;
    const desktopSession = session.fromPartition("desktop");
    desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    desktopSession.setPermissionCheckHandler(() => false);
    desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (isAppConnection(details.url, origin)) details.requestHeaders.Authorization = `Basic ${Buffer.from("demo:" + config.password).toString("base64")}`;
      callback({ requestHeaders: details.requestHeaders });
    });
    desktopSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders ?? {};
      // Explicitly allow the local WebSocket origin across Chromium CSP implementations.
      if (isAppUrl(details.url, origin)) headers["Content-Security-Policy"] = [`default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${origin.replace(/^http/, "ws")}; object-src 'none'; frame-src 'none'; base-uri 'none'`];
      callback({ responseHeaders: headers });
    });
    await openWindow();
  });
  void startup.catch(() => fail("本地服务或界面启动失败，请检查模型环境变量及应用数据目录的写入权限。"));
}
