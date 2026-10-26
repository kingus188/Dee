# 小 D 桌面程序

Electron 直接连接后台服务器：后台同源提供已构建的网页、API 与 WebSocket；桌面不启动后端，不采集 Teams，不管理微信桥接进程，不打开助手数据库。桌面端和浏览器连接同一后台实例，共享后端数据。

## 本机运行

在仓库根目录安装依赖并构建后，分开运行后端和桌面两个进程：

```bash
pnpm install --frozen-lockfile
pnpm run build
# 终端一：后台服务器，默认 127.0.0.1:3000，同源提供网页/API/WebSocket
pnpm run start:api
# 终端二：桌面客户端
pnpm run desktop
```

已有独立 Web 网关仍可通过 `pnpm run start:web` 使用，默认 `127.0.0.1:8080`；其 `API_ORIGIN` 配置继续有效。后端未找到构建后的 `apps/web/dist` 页面时返回 404，请先构建。

模型、账号、数据目录及微信配置只提供给后端。管理员通过服务器 `LLM_MODELS_FILE` 模型目录或 `LLM_*` 环境变量配置真实模型并重启后端；桌面和网页只选择服务器提供的模型，保存选择后重启后台生效。未配置模型时仍可管理数据。桌面用菜单「连接设置…」填写后台服务器根地址（默认 `http://127.0.0.1:3000`），也可直接在页面「连接与设置」切换后台；`ASSISTANT_SERVER_URL` 优先覆盖，兼容旧 `ASSISTANT_WEB_URL` 以及已保存的 `url` 配置。远程服务器必须为 HTTPS，只允许根地址，不接受地址内嵌凭据、路径、查询或片段。

连接设置可填写 Basic Auth 用户名与密码（后端用户名为 `demo`）。连接 URL 和用户名保存在 Electron `userData/desktop-connection.json`；密码仅在系统安全存储可用时加密保存，否则仅本次运行使用。修改环境变量为其他 Web 来源不会复用原有凭据。配置和断线重连可用本地连接窗口。远程页面只向当前后台的主框架公开后台地址切换操作，校验并保存后重建连接；切换来源会清除旧登录信息，页面不接收保存的凭据。

远程页面启用 sandbox、context isolation，禁用 Node.js、webview 和权限请求；仅向当前 Web 的 HTTP/WebSocket 请求附加认证。HTTP(S) 外链由系统浏览器打开，跨源导航被阻止。

受控自签名 HTTPS 服务可在 Electron `userData/desktop-certificate.json` 配置公开证书，格式为 `{ "origin": "https://服务器地址:端口", "certificate": "PEM 证书文本" }`。先通过可信管理通道核实证书；客户端仅接受该来源、匹配的主机与证书指纹及有效期，其他连接继续使用系统校验。邮件轮询复用同一会话。证书更换或过期后应重新核实并更新此公开配置。

macOS 安装包声明局域网用途，系统出现访问提示时选择允许。终端可访问服务器不代表桌面已获权限；已保存的凭据可直接重试。打包会构建独立主程序，避免与其他 Electron 应用共享主 UUID 而混用网络权限。

macOS 关闭窗口后应用继续轮询邮件通知；完全退出时停止轮询，但不会停止后端任务。Windows/Linux 关闭最后一个窗口即退出客户端。通知由 `/api/mail/notices` 获取，首次连接跳过历史通知，不读取本机邮件或 Teams 数据库。

## 旧桌面数据

旧版桌面在 macOS `~/Library/Application Support/Pi Durable Assistant/data` 保存数据库。新版不会自动迁移、打开或修改该目录；直接运行默认后端会使用仓库 `./data`，不是旧桌面数据。

保留旧数据时，先退出旧版桌面并备份整个数据目录，再将后端 `DATA_DIR` 指向该目录（或者指向完整备份副本）。不要让旧版桌面与新版后端同时访问同一目录；不要只复制 SQLite 主文件而遗漏 WAL 或其他数据库。

Teams 同步/发送由后端 `TEAMS_CONFIG_DIR` 指定包含 `teams-forward-config.json` 的配置目录；Outlook 账号文件由 `MAIL_ACCOUNT_FILE` 指定。旧桌面 `wechat` 目录中的文件不会自动加载，迁移时显式配置对应路径。微信 Bot 必须作为独立服务运行，配置后端发送地址及两个方向的令牌。不要在前端或桌面客户端放模型、公司账号配置。

## 打包与验证

macOS 打包需安装 Xcode Command Line Tools。主入口从本项目源码构建，保留 Electron 框架、辅助程序及 Node/fuse 行为；最终应用使用本地临时签名，并执行严格签名与包内容检查。

```bash
pnpm run desktop:package
```

生成当前系统/架构应用，输出在 `dist/desktop/`。包内只包含桌面编译产物、图标、连接页及许可证，不包含后端、网页、依赖树、微信二进制、源码或数据库。打包后使用包内 Electron 运行时检查资源、连接策略及无安全存储时不落盘密码，并验证包内不存在服务端或数据目录。临时打包目录无论成功失败均清理。

`pnpm run check`、`pnpm test` 覆盖连接策略、凭据边界、API 生命周期和 Web 代理。桌面原生窗口、系统安全存储、系统通知与真实账号集成需要现场验证。当前无分发签名、公证、安装器、自动更新或跨平台交叉打包。
