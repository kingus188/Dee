# 快速开始：运行小 D

本手册从真实模型配置开始。产品已停用模拟体验，网页和桌面版都需要可用的模型服务。

## 准备环境

- Node.js **22.19 或以上**、pnpm 12.9.1 和 Git。
- 可用的模型 API 地址、模型名称及服务商要求的凭据。
- 本地运行使用 SQLite，不需要独立数据库服务。

## 安装与配置

```bash
git clone https://github.com/kingus188/pi-durable-assistant.git
cd pi-durable-assistant
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

用编辑器填写以下变量：

| 变量 | 填写内容 |
| --- | --- |
| `LLM_API` | 服务商支持的协议：`openai-completions`、`openai-responses` 或 `anthropic-messages` |
| `LLM_BASE_URL` | 模型服务的实际 API 基础地址 |
| `LLM_MODEL` | 服务商提供的模型 ID |
| `LLM_API_KEY` | 服务商要求的 API Key |

地址和模型名必须来自实际服务配置，不要直接使用文档中的占位值。调用费用和可用能力由所选服务商决定。

```bash
set -a
. ./.env
set +a
pnpm run start:api
```

另开终端运行 `pnpm run start:web`，访问 **http://127.0.0.1:8080**。后端端口冲突时使用 `PORT=3001 pnpm run start:api`，并用 `API_ORIGIN=http://127.0.0.1:3001 pnpm run start:web` 连接；前端端口由 `WEB_PORT` 控制。

Shell 导入方式适用于简单的 `KEY=value` 配置；值包含特殊字符时需正确加引号，也可以直接由系统注入环境变量。不要把密钥发到 Issue。

桌面版不读取模型凭据、不启动后端。保持 API 与 Web 服务运行，再执行 `pnpm run desktop`；`ASSISTANT_WEB_URL` 可指向其他已部署 Web 服务，详见 [桌面程序](../apps/desktop/README.md)。

## 确认实际功能

1. 打开小 D，发送一条普通消息，核对回复和模型服务连接。
2. 让它记录一个待办或备忘，检查对应记录。
3. 设置短期提醒，查看是否在会话中触发。
4. 提交适合后台执行的任务，查看运行状态和完成结果。
5. 提交一条长期记忆，确认批准后才用于后续对话。

实际模型可能不支持工具调用、图片或某些协议字段。出现 401、404 或模型错误时，先核对 API 地址、协议和凭据。

旧模拟会话及未记录模型的历史会话会保留，正式模型使用新的聊天记录，不会将这些旧会话直接切换到真实模型。旧 `/api/crash` 接口已删除；恢复机制由自动化测试验证，真实模型恢复行为需独立验收。

## 图片与文本附件

| 项目 | 支持情况 |
| --- | --- |
| 图片 | PNG / JPEG / WebP / GIF，校验文件签名 |
| 文本 | UTF-8 文本、Markdown、CSV、JSON 和代码文件 |
| 文件数 | 每次最多 5 个 |
| 大小 | 图片每个最多 5 MiB，文本每个最多 200 KiB，总计最多 10 MiB |

在输入框旁添加附件，或拖动文件到聊天区域。图片理解要求模型支持图像；微信 iLink 通道仍不解析图片、视频和文件附件。

## 持续运行与部署

- [部署与备份](DEPLOYMENT.md)：Docker、HTTPS、访问密码和数据卷备份。
- [配置参考](CONFIGURATION.md)：知识库、通知和模型参数。
- [微信接入](WECHAT.md)：启用通道、扫码及消息送达限制。

关闭网页或退出桌面应用不会停止后端任务；后端进程必须持续运行。周期计划按固定分钟间隔执行，不是按当地时区的日历调度。没有配置通知渠道时，提醒和完成结果仅在应用中显示。

## 自动化检查

```bash
pnpm run check
pnpm test
```

测试在隔离数据目录中使用模拟模型，不需要真实模型凭据。它们验证接口和恢复逻辑，不替代真实模型、微信与部署验收。

遇到问题请参考 [故障排查](TROUBLESHOOTING.md)，提供已脱敏日志和复现步骤。
