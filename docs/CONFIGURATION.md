# 配置参考（当前 main）

本页基于 `.env.example`、`apps/server/src/config.ts`、`packages/features/src/tasks/index.ts`、`packages/channel-wechat/src/index.ts` 和 `compose.yaml` 的**当前主分支实现**。请按 [快速开始](GETTING_STARTED.md) 配置真实模型后启动。产品不提供模拟体验，`faux` 仅允许在自动化测试环境中使用。

## 环境变量

服务启动后，可从网页左侧「设置」打开「模型连接」，配置 Provider（接口协议）、Base URL、模型 ID 和 API Key。支持下表对应的三类模型协议。

网页配置保存后需重启服务生效。模型连接保存在 `DATA_DIR/agent.sqlite` 的私有配置表中，已保存的连接优先于 `LLM_API`、`LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY`；上下文窗口和最大输出仍使用环境变量。首次使用有效的模型环境变量启动时，会自动将连接保存到 SQLite，之后不再依赖这四个环境变量。

没有已保存的模型配置时，应用仍可打开设置页。填写连接并保存后重启即可聊天；配置完成前不启动模型生成或恢复后台任务，不提供模拟回复。启用了微信通道的服务需先完成模型配置。

切换模型 ID 时，请等正在生成的回复结束后再重启。会话和分叉后续使用新模型，但 SDK 已保存的未完成生成请求可能仍引用旧模型 ID。

API Key 输入为空时保留原值；更换 Provider 或 Base URL 时必须重新填写，避免把旧 Key 发给另一个服务。数据库文件及 WAL/SHM 文件权限限制为 `0600`；Key 在 SQLite 中为明文，数据目录和备份应按凭据管理，勿提交到 Git。读取接口只返回 Key 是否已配置，不返回 Key 内容。

旧版 `DATA_DIR/model-settings.json` 会在启动时迁移到 SQLite，只有成功入库后才删除旧文件。SQLite 中已有的配置优先，损坏的存储配置不会静默回退到环境变量。

| 变量 | 默认 / 示例 | 说明 |
| --- | --- | --- |
| `LLM_API` | `openai-completions` | 可选 `openai-completions` / `openai-responses` / `anthropic-messages` |
| `LLM_BASE_URL` | 空 | 实际服务商提供的 API 基础地址，必须配置 |
| `LLM_API_KEY` | 空 | 实际 API Key，不提交到 Git |
| `LLM_MODEL` | 空 | 模型 ID，须与 API 类型及服务商匹配 |
| `LLM_CONTEXT_WINDOW` | `128000` | 提供给模型目录的上下文窗口配置，并非真实配额保证 |
| `LLM_MAX_TOKENS` | `8192` | 模型目录的最大输出 token 配置 |
| `DEMO_PASSWORD` | 空 | HTTP Basic Auth 密码；生产模式必须配置，用户名固定 `demo` |
| `HOST_PORT` | `3300` | Docker 映射到宿主机 `127.0.0.1` 的端口 |
| `NOTIFY_WEBHOOK_URL` | 空 | 通用 Webhook 或飞书机器人的完整 URL，含签名时视为敏感凭据 |
| `NOTIFY_WEBHOOK_KIND` | `generic` | `generic` JSON / `feishu` 文本机器人 |
| `NOTIFY_MODE` | `errors` | `errors`：仅明确失败的后台任务；`all`：也发成功/提醒/计划触发；`off`：不发送 |
| `MAIL_ACCOUNT_FILE` | 空 | Web 服务复用现有账号 JSON 的路径（建议绝对路径）；桌面端默认使用应用数据目录下的 `wechat/teams-forward-config.json`。不在网页配置密码 |
| `WECHAT_ENABLED` | `0` | 是否启用微信入站转发；需同时启动 `wx-bot` profile |
| `WECHAT_WEBHOOK_KEY` | 空 | 微信桥到 Node 的入站 Bearer token |
| `WECHAT_SEND_TOKEN` | 空 | Node 到微信桥本地发送接口的令牌，必须与入站令牌不同 |
| `WECHAT_SEND_URL` | `http://127.0.0.1:18790/v1/send` | 共用网络命名空间内的微信发送地址，通常不要更改 |
| `OBSIDIAN_ROOT` | 空 | 只读 Obsidian 仓库根目录。留空时知识库工具会说明未启用，不影响聊天 |
| `OBSIDIAN_ALLOW` | 空 | 额外允许的相对路径，用英文逗号分隔。默认已包含 AI学习、X灵感、VPS小白教程 |
| `PI_OFFLINE` | 空 | 设为 `1` 时强制关闭微信通道、Teams 发送和 Webhook 通知，不受数据库里保存的配置影响。**用真实数据目录的副本做测试或调试时必须开启**，否则副本会连到真实的微信和 Teams |
| `INVESTIGATE_REPOS` | 空 | 允许开发任务的本机仓库，`名称=绝对路径[#测试命令]`，逗号分隔，如 `erp=/Users/me/erp#pnpm test`。助手可在隔离 git worktree 里启动后台 Claude Code 排查修复（fix）或开发功能（feature），成果提交到新分支 `fix/pi-<id>` / `feat/pi-<id>`（工作目录 `$DATA_DIR/investigations/`），不推送、不发布。基于仓库当前 HEAD 的已提交代码；主仓库的 `node_modules` 会链接进去供测试使用；同时最多 2 个任务、单个预算 5 美元。你回复「确认合并 任务ID」后才会本地合并到仓库当前分支（仓库须无未提交改动）。完成通知走 Webhook，需 `NOTIFY_MODE=all`；微信回复令牌约 30 分钟过期，不能依赖微信推送完成消息 |
| `INVESTIGATE_AGENT` | `codex` | 开发任务默认使用的编码 Agent，对话里也可以按任务指定（如“用 claude 做”）。可选：`codex`（通过 ACP 驱动）或 `claude`（Claude Code 的 `claude -p`）。Codex 会话固定为 `workspace-write`：工作区内可写，网络和工作区外写入被拒绝；仅 git 的 add/commit/diff/status/log、printf/echo 和该仓库配置的测试命令会被自动批准。两种 Agent 都由服务进程持有，**服务重启会中断正在运行的任务**（分支上已提交的内容保留）。新增 Agent 只需在 `packages/features/src/investigate/agents.ts` 实现一个 runner |
| `INVESTIGATE_CODEX_BIN` | `codex-acp` | ACP 适配器 `@agentclientprotocol/codex-acp`（建议固定版本 `npm i -g @agentclientprotocol/codex-acp@2.2.2`），需已登录 Codex；服务进程的 PATH 里要能找到，否则填绝对路径 |
| `INVESTIGATE_CLAUDE_BIN` | `claude` | `INVESTIGATE_AGENT=claude` 时使用的 Claude Code 可执行文件；需已登录 |
| `MATERIALS_ROOT` | `$DATA_DIR/materials` | 生产资料目录（Markdown），只读检索。路径含「归档」为归档、含「草稿」或「待确认」为草稿，只有其余文件算现行；建议每篇头部写明负责人和更新日期。启动时自动创建。也可以在对话里让助手记入资料：先存入「待确认」，你确认后转为现行，同名旧资料自动归档 |

另外，`PORT`（本地默认 `3000`）和 `DATA_DIR`（本地默认 `./data`、Docker 默认 `/data`）在代码中读取，可用于开发或容器环境；它们不是当前示例 `.env.example` 的主要部署配置。

### 最小可运行配置

**真实模型配置：**

```dotenv
LLM_API=openai-completions
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=YOUR_OWN_KEY
LLM_MODEL=your-model-id
```

请用真实供应商参数替换占位符。该项目通过显式提供 `baseUrl` 和 API 协议类型接入模型，**不能保证所有 OpenAI 兼容中转都支持图像、工具或相同的模型字段**。供应商不支持的能力不要默认当作项目已支持。

### 生产部署最低配置

```dotenv
DEMO_PASSWORD=REPLACE_WITH_A_STRONG_RANDOM_PASSWORD
LLM_API=openai-completions
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=YOUR_OWN_KEY
LLM_MODEL=your-model-id
```

使用 `docker compose up -d --build`。生产未配置 `DEMO_PASSWORD` 会拒绝启动，不能通过移除鉴权来解决。默认容器映射只绑定到 `127.0.0.1`，需要远程访问时应另外部署 TLS 反向代理。

## 运行模式与可选通道

`POST /api/crash` 已移除，通过鉴权的同源请求在所有环境返回 404；旧 `ENABLE_CRASH_DEMO` 配置不再生效。自动化测试可以显式使用 `NODE_ENV=test` 和 `LLM_API=faux`，正式服务和桌面应用不使用该模式。

**通知：**不配置 `NOTIFY_WEBHOOK_URL` 时后台任务照常进行，只是不会主动向手机或飞书群发送事件。主分支的 Webhook / 飞书仍是尽力发送：**没有持久通用 Outbox**；出错可能丢失消息。带幂等重试的改造仍在 [PR #6](https://github.com/xiaomoBoy/pi-durable-assistant/pull/6)，不要把未合并功能当作当前能力。Webhook 对端应按 `X-Pi-Event-ID` 去重。

**微信：**默认不开启。启用前分别用 `openssl rand -hex 32` 生成 `WECHAT_WEBHOOK_KEY` 与 `WECHAT_SEND_TOKEN`，将 `WECHAT_ENABLED=1` 放入 `.env`，按 [微信接入手册](WECHAT.md) 使用 `--profile wechat` 启动。微信扫码凭据保存在专用 Docker 命名卷，不应导出到仓库。

**笔记检索：**设置 `OBSIDIAN_ROOT` 后，助手只能只读检索白名单笔记，回答带来源路径和行号，不会写回 Obsidian。默认只开放 AI学习、X灵感、VPS小白教程；财务、个人档案和服务器资产不在范围内。这与未合并的 [PR #4](https://github.com/xiaomoBoy/pi-durable-assistant/pull/4) 不是同一份代码。

**工作区审批：**仍在待验收的 [PR #5](https://github.com/xiaomoBoy/pi-durable-assistant/pull/5) 中。当前 `main` 没有对应配置，请勿按待合并分支的参数尝试启用。

## 安全建议

- 不提交 `.env`、服务商 Key、微信数据卷备份和包含鉴权信息的日志。
- 项目是单用户原型，不提供多租户隔离、SSO 或多用户权限矩阵；尽量只通过自己控制的 HTTPS 入口访问。
- 模型费用可能产生在供应商/中转平台；**项目内 `cost: 0` 占位不等于免费**，建议在上游平台设置预算和额度限制。
- 只下载/接入信任的模型或服务地址；不要把私有文件附件发送给不信任的模型提供商。
- 对持久化 SQLite 和微信状态卷进行一致性备份；参考 [部署手册](DEPLOYMENT.md)。

[返回 README](../README.md) · [故障排查](TROUBLESHOOTING.md)

## Outlook / Microsoft 365 邮件（当前工作区）

桌面端和独立 Web 服务都能在「设置 → Outlook 邮件」管理，不依赖 Teams 或微信是否启用。两端的令牌、缓存各自保存在当前实例的数据目录，不会自动跨设备同步。

### 复用已有公司账号

桌面端自动使用应用数据目录下的 `wechat/teams-forward-config.json`；独立 Web 服务用 `MAIL_ACCOUNT_FILE=/绝对路径/teams-forward-config.json` 指定同格式的本地文件。文件中的 `account` 需已有 `tenantId`、`clientId`、`username`、`password` 四个字符串，网页不接收或显示密码，也不另存一份密码。无需复制账号信息到聊天或邮件设置。

仅在**当前实例从未保存过邮件配置**且找得到该文件时，自动启用邮件监听、申请 `Mail.Read offline_access` 并开始同步。已有手动配置、已保存的暂停或断开操作不会被启动覆盖。设置页的「使用现有账号连接」可显式重新启用或切换回已有账号；连接完成后后台自动同步，通常用刷新令牌续期，不每分钟提交密码。

这是微软密码授权（ROPC），只能在公司策略允许时使用，不支持 MFA 挑战。密码错误、MFA/条件访问要求、授权失败或刷新令牌被撤销时会停止自动密码重试，**重启也不会重新撞密码**；核对原配置后手动重连，或改用下方交互授权。单次进程内密码登录至少间隔一分钟。选择交互登录后不会悄悄回退到密码方式。

重启或手动重连时重新读取账号来源，检测到租户、应用或用户名变化会先清空旧邮件、通知、令牌与游标，为新账号建立静默基线；运行中修改来源文件需手动重连或重启。密码轮换不改变邮箱身份。不要依赖缓存状态来确认公司策略仍允许登录。

### 手动配置应用并交互授权

1. 请公司管理员在 Microsoft Entra ID 注册适用于公司租户的应用，取得 **Directory (tenant) ID** 和 **Application (client) ID**。设置页只接受这两个 UUID；不填邮箱密码或客户端密钥。
2. 在应用的「Authentication → Advanced settings」启用 **Allow public client flows**，配置 Microsoft Graph **委托权限 `Mail.Read`**。程序另外请求 `offline_access` 用于刷新令牌；若公司要求，请先完成管理员同意。不需要 `Mail.ReadWrite`、`Mail.Send` 或应用级邮箱权限。
3. 在设置页填写 Tenant ID、Client ID，勾选「启用邮件监听」并保存，再点击「登录微软邮箱」。
4. 打开页面显示的微软授权链接，输入一次性代码，使用公司账号完成登录和 MFA。小 D 会后台轮询授权结果，成功后自动同步。代码过期可重新登录。

这一替代入口是设备代码登录，不使用原配置中的密码。若公司条件访问策略禁止设备代码流，或要求特定受管设备，此流程仍可能被拒绝；不能用关闭 MFA 解决，需由管理员确认是否允许这种接入方式。首版只支持微软全球云，公司中国云或政府云不在范围内。

### 查询与提醒

- 同步范围是授权账号的 **收件箱**，首次仅获取近 **30 天**邮件。之后使用 Microsoft Graph delta，每分钟左右检查一次；分页较多、网络错误或限流会延迟，限流遵守 `Retry-After`。
- 首次同步是建立基线，不提醒历史邮件。后续新进入收件箱的邮件产生通知，更新已读状态、修改已有邮件不会重复通知。缓存及游标按页一起落盘，正常重启不重复入库。
- 可以问「查看最新邮件」「今天张三发了哪些邮件」「找主题包含报价的未读邮件」「读一下这封邮件的正文」。工具为 `outlook_messages` 和 `outlook_read`，查询前会尝试同步，失败时明确说明只读本地缓存与最后同步时间。
- 本地缓存最多保留 90 天；邮件列表默认最多 20 封、单次最多 50 封；正文只保存纯文本，最多 20000 字。如果 Graph 未按要求返回纯文本，则只保留纯文本预览，不呈现 HTML 或加载外部图片。附件仅展示是否存在，不下载。
- Web 在页面打开时显示新邮件横幅；桌面端另有系统通知，macOS 窗口关闭但应用仍运行时也可提醒。需要允许系统通知。通知按批合并，不保证每封单独弹窗；提醒不自动写进聊天，也不转发微信或 Webhook。
- 程序启动、网页刷新时跳过此前已有的通知；网页短暂断线后可继续读取近 7 天通知。提醒是尽力展示，不是跨重启保证投递的持久通知队列。停止独立服务或完全退出桌面应用后不再监听。

### 暂停、退出与数据处理

取消「启用邮件监听」并保存，会停止当前同步并保留登录和缓存。重新启用即可恢复。点击「断开并清除缓存」会停止监听，清除当前实例中的邮件、通知记录、令牌与增量游标，但保留应用 ID。更换 Tenant ID / Client ID 或重新登录也会先清空旧账号缓存，防止不同账号混用数据；首次重建不补发历史提醒。微软端的授权仍需在微软账号/企业应用中撤销。

增量游标过期（Graph HTTP 410）时，会清掉失效缓存并重新建立近 30 天基线，避免已移出或删除的邮件长期残留。重建期间不会提醒历史邮件。

令牌和邮件在 `DATA_DIR/agent.sqlite` 的 `outlook_*` 表内明文保存，沿用数据目录与数据库的私有文件权限。接口不返回账号密码、用户名、配置文件路径、访问令牌、刷新令牌或设备授权私码，仅返回登录方式、账号文件是否可用及交互登录需用户输入的一次性代码与授权链接。数据目录及其备份应按凭据管理；清除当前缓存不会清除备份、已生成的对话或模型供应商已收到的内容。对话查询邮件时，查询结果会进入你配置的模型上下文。第三方邮件只能作为资料，不能代替用户指令或授权。

`PI_OFFLINE=1` 会强制禁止 Outlook 登录与后台同步，即使保存配置已启用且已有令牌也不联网，仍可读缓存和清理本地数据。测试真实数据副本时必须开启。

### 本地接口

以下接口与其他 API 共用 Basic Auth、同源写保护和 WebSocket 请求入口：

| 方法和路径 | 用途 |
| --- | --- |
| `GET /api/settings/mail` | 读取配置、登录状态、同步时间与错误；不返回令牌 |
| `POST /api/settings/mail` | 保存 `{enabled, tenantId, clientId}`，立即生效 |
| `POST /api/mail/login` | 切换为交互授权并申请设备代码，返回后自动后台轮询 |
| `POST /api/mail/login-account` | 显式使用本地已有账号连接并启用监听，不接收密码或文件路径 |
| `POST /api/mail/refresh` | 尝试立即同步，离线或停用时不联网 |
| `POST /api/mail/disconnect` | 停止监听并清除当前账号缓存和令牌 |
| `GET /api/mail/notices` | 获取当前通知游标，不补发历史 |
| `GET /api/mail/notices?after=<序列>` | 获取该序列后的最多 50 条新邮件通知 |

真实公司租户的应用注册、管理员同意、MFA/条件访问与实际邮件投递需在配置后现场验收；本地自动化测试只使用假的 OAuth/Graph 响应，不代表租户已经授权。
