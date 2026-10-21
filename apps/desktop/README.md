# 小 D 桌面程序

Electron 是独立 API 客户端：加载 Web 服务，不启动后端，不采集 Teams，不管理微信桥接进程，不打开助手数据库。桌面端和浏览器连接同一 Web/API 实例，共享后端数据。

## 本机运行

在仓库根目录安装依赖后，分开运行三个进程：

```bash
pnpm install --frozen-lockfile
# 终端一：后端，默认 127.0.0.1:3000
pnpm run start:api
# 终端二：Web 页面与 API/WebSocket 代理，默认 127.0.0.1:8080
pnpm run start:web
# 终端三：桌面客户端
pnpm run desktop
```

模型、账号、数据目录及微信配置只提供给后端。首次在网页「设置」配置真实模型并重启后端；未配置模型时仍可管理数据，不能生成回复。Web 用 `API_ORIGIN` 选择后端；桌面用菜单「连接设置…」选择 Web 地址，也可由 `ASSISTANT_WEB_URL` 覆盖（默认 `http://127.0.0.1:8080`）。远程 Web 必须为 HTTPS，只允许根地址，不接受地址内嵌凭据、路径、查询或片段。

连接设置可填写 Basic Auth 用户名与密码（后端用户名为 `demo`）。连接 URL 和用户名保存在 Electron `userData/desktop-connection.json`；密码仅在系统安全存储可用时加密保存，否则仅本次运行使用。修改环境变量为其他 Web 来源不会复用原有凭据。配置和断线重连使用本地连接窗口，不在远程页面暴露配置 IPC。

远程页面启用 sandbox、context isolation，禁用 Node.js、webview 和权限请求；仅向当前 Web 的 HTTP/WebSocket 请求附加认证。HTTP(S) 外链由系统浏览器打开，跨源导航被阻止。

macOS 关闭窗口后应用继续轮询邮件通知；完全退出时停止轮询，但不会停止后端任务。Windows/Linux 关闭最后一个窗口即退出客户端。通知由 `/api/mail/notices` 获取，首次连接跳过历史通知，不读取本机邮件或 Teams 数据库。

## 旧桌面数据

旧版桌面在 macOS `~/Library/Application Support/Pi Durable Assistant/data` 保存数据库。新版不会自动迁移、打开或修改该目录；直接运行默认后端会使用仓库 `./data`，不是旧桌面数据。

保留旧数据时，先退出旧版桌面并备份整个数据目录，再将后端 `DATA_DIR` 指向该目录（或者指向完整备份副本）。不要让旧版桌面与新版后端同时访问同一目录；不要只复制 SQLite 主文件而遗漏 WAL 或其他数据库。

Teams 同步/发送由后端 `TEAMS_CONFIG_DIR` 指定包含 `teams-forward-config.json` 的配置目录；Outlook 账号文件由 `MAIL_ACCOUNT_FILE` 指定。旧桌面 `wechat` 目录中的文件不会自动加载，迁移时显式配置对应路径。微信 Bot 必须作为独立服务运行，配置后端发送地址及两个方向的令牌。不要在前端或桌面客户端放模型、公司账号配置。

## 打包与验证

```bash
pnpm run desktop:package
```

生成当前系统/架构应用，输出在 `dist/desktop/`。包内只包含桌面编译产物、图标、连接页及许可证，不包含后端、网页、依赖树、微信二进制、源码或数据库。打包后使用包内 Electron 运行时检查资源、连接策略及无安全存储时不落盘密码，并验证包内不存在服务端或数据目录。临时打包目录无论成功失败均清理。

`pnpm run check`、`pnpm test` 覆盖连接策略、凭据边界、API 生命周期和 Web 代理。桌面原生窗口、系统安全存储、系统通知与真实账号集成需要现场验证。当前无分发签名、公证、安装器、自动更新或跨平台交叉打包。
