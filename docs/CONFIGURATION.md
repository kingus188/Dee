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
| `WECHAT_ENABLED` | `0` | 是否启用微信入站转发；需同时启动 `wx-bot` profile |
| `WECHAT_WEBHOOK_KEY` | 空 | 微信桥到 Node 的入站 Bearer token |
| `WECHAT_SEND_TOKEN` | 空 | Node 到微信桥本地发送接口的令牌，必须与入站令牌不同 |
| `WECHAT_SEND_URL` | `http://127.0.0.1:18790/v1/send` | 共用网络命名空间内的微信发送地址，通常不要更改 |
| `OBSIDIAN_ROOT` | 空 | 只读 Obsidian 仓库根目录。留空时知识库工具会说明未启用，不影响聊天 |
| `OBSIDIAN_ALLOW` | 空 | 额外允许的相对路径，用英文逗号分隔。默认已包含 AI学习、X灵感、VPS小白教程 |
| `MATERIALS_ROOT` | `$DATA_DIR/materials` | 生产资料目录（Markdown），只读检索。路径含「归档」为归档、含「草稿」或「待确认」为草稿，只有其余文件算现行；建议每篇头部写明负责人和更新日期。启动时自动创建 |

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
