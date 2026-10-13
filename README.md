# 小 D · 个人数字人助手

**有自己的形象，记得你的约定，把交代的事情继续做完。**

小 D 是一个可以自托管的个人数字人助手。你通过对话交代事情，它用动态形象呈现工作状态，保存经你确认的记忆，安排提醒，并在后台处理需要时间的任务。

项目名称为 **Pi Durable Assistant**，基于 [Pi Durable](https://github.com/earendil-works/pi) 构建。数字形象负责表达，持久化 Agent 负责执行：关闭网页后，服务端仍可继续工作；服务重启后，可恢复的任务从持久化状态继续运行。

[English](README.en.md) · [快速开始](docs/GETTING_STARTED.md) · [配置说明](docs/CONFIGURATION.md) · [架构与开发](docs/ARCHITECTURE.md)

[![Node.js](https://img.shields.io/badge/Node.js-22.19%2B-43853d?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![CI](https://github.com/kingus188/pi-durable-assistant/actions/workflows/v3-ci.yml/badge.svg)](https://github.com/kingus188/pi-durable-assistant/actions/workflows/v3-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 当前是面向个人、单用户的实验性实现，交互以文字对话和二维动态形象为主。实时语音、口型同步、写实视频形象尚未实现。

## 我们希望小 D 成为什么

一个长期为你工作的数字伙伴，需要让你认得它、知道它在做什么，也能接着上次的事情继续。

- **看得见的状态。** 小 D 会用表情和状态文字反馈思考、工具执行、等待、断线和恢复。形象变化对应程序运行状态。
- **由你决定的记忆。** 偏好、稳定事实和常用流程可以跨会话保留。助手提出的记忆和技能先等待批准，再用于后续对话。
- **能够持续的行动。** 提醒、周期计划和后台任务有持久化记录。离开网页后，事情可以继续推进。
- **可管理的个人空间。** 对话、记忆和任务状态保存在你部署的实例中；你可以停止任务、管理记忆、归档会话和导出对话。

## 可以交给小 D 的事

以下示例需要接入真实模型；实际执行效果取决于模型能力和相关配置。

| 你可以这样说 | 当前具备的能力 |
| --- | --- |
| “请记住，我喜欢简洁、带要点的回答。” | 提交长期记忆候选，经你批准后用于后续会话 |
| “十分钟后提醒我站起来活动一下。” | 创建持久提醒，到点后在会话中提醒 |
| “先记下这几个想法，再帮我列一个待办清单。” | 保存当前会话的备忘和待办 |
| “阅读这个公开网页，后台整理重点，完成后告诉我。” | 抓取公开网页文字，将适合的工作交给后台子 Agent |
| “帮我找一下笔记里关于这个项目的决定，附上出处。” | 在配置好的 Obsidian 白名单目录中只读检索，返回路径和行号 |
| “把这套步骤整理成技能，以后遇到类似事情再用。” | 提交技能候选，批准后按需读取流程；不会重新训练模型 |

网页支持多会话、会话分叉、流式回复，以及图片和文本附件。可选的微信 iLink 通道用于收发文字及微信提供的语音转写文字。通用 Webhook 和飞书机器人可用于发送任务通知。

## 在本机体验

需要 **Node.js ≥ 22.19**、pnpm 12.9.1 和 Git。

```bash
git clone https://github.com/kingus188/pi-durable-assistant.git
cd pi-durable-assistant
corepack enable
pnpm install --frozen-lockfile
LLM_API=faux pnpm run dev
```

打开 **http://127.0.0.1:3000**，创建一个会话并发送消息，观察小 D 的状态变化和任务执行过程。

`faux` 不需要 API Key，运行的是固定模拟剧本，适合体验界面和恢复机制。**它不会理解任意自然语言指令，也不会完成上面的真实任务。**

### 接入真实模型

```bash
cp .env.example .env
# 用编辑器填写 LLM_API、LLM_BASE_URL、LLM_API_KEY、LLM_MODEL
set -a
. ./.env
set +a
pnpm run dev
```

支持 `openai-completions`、`openai-responses` 和 `anthropic-messages` 三类接口。具体模型、图片理解能力、费用和数据处理方式由所选服务商决定。知识库、通知和微信接入需要单独配置，见 [配置说明](docs/CONFIGURATION.md)。

## 让小 D 持续运行

后台工作需要服务端保持运行，或在退出后由进程管理器重新拉起。仓库提供 Docker Compose 配置，默认持久化 SQLite 数据并自动重启服务。

```bash
cp .env.example .env
# 填写真实模型配置和强密码 DEMO_PASSWORD
docker compose up -d --build
docker compose ps
```

默认访问地址为 **http://127.0.0.1:3300**。对外提供访问时配置 HTTPS 反向代理，并保留登录鉴权；HTTP Basic Auth 用户名为 `demo`。升级前备份数据卷，**不要用 `docker compose down -v` 升级**，它会删除持久数据。

详细步骤见 [部署与备份](docs/DEPLOYMENT.md)。微信接入见 [微信 iLink 手册](docs/WECHAT.md)，需要额外启动 `wx-bot` 容器并完成扫码。

## 当前边界

- **形象与声音：** 当前使用 SVG/CSS 动态形象，没有实时语音对话、声音克隆、口型驱动、Live2D 或三维模型接入。
- **记忆与数据：** 自托管保存对话和记忆；调用外部模型时，相关消息、附件和检索内容仍可能发送给模型服务商。不要提交 `.env`、密钥或微信会话凭据。
- **执行与恢复：** 恢复依赖已保存的状态和对应任务的可恢复性，不保证任意外部操作只执行一次。周期计划按固定分钟间隔运行，不是支持时区和夏令时的日历调度。
- **消息送达：** 通用 Webhook／飞书通知为尽力发送，网络故障可能丢失通知。微信有独立持久发送队列，仍可能重复投递或受平台限制；真实微信扫码和生产送达需单独验收。
- **附件与权限：** 网页单次最多 5 个附件，图片每个 5 MiB、文本每个 200 KiB、总计 10 MiB。微信图片、视频和文件尚不解析。知识库只读，不提供任意本地文件写入或通用电脑控制。
- **适用范围：** 当前面向个人使用，尚无多租户隔离和企业角色权限体系。归档会停止该会话未完成的任务；从列表移除会话不等于彻底删除其持久化记录。

## 数字人方向

后续演进围绕小 D 的身份表达和持续协作展开。以下是产品方向，**不代表已交付功能或发布时间承诺**：

| 方向 | 希望带来的体验 |
| --- | --- |
| 形象与角色配置 | 设置称呼、外观和交流风格，保持跨会话一致的身份表达 |
| 语音交互 | 支持语音输入、语音回复和打断，与任务状态协调 |
| 更丰富的形象表现 | 将表情、动作和口型与对话、执行事件同步 |
| 可回顾的长期协作 | 看清记忆来源、授权范围与任务进展，方便纠正和撤销 |
| 跨入口连续体验 | 在网页和消息通道之间延续任务，并改善通知送达与权限控制 |

## 开发与扩展

技术栈：**TypeScript / 原生浏览器界面 / Node.js / Pi Durable 1.1.0 / SQLite / SSE**。使用 pnpm workspaces 和 `tsc`，无需前端框架、打包器或独立数据库服务。

| 目录 | 职责 |
| --- | --- |
| `apps/web` | 小 D 的数字形象、对话和交互界面 |
| `apps/server` | 服务启动、鉴权、HTTP/SSE 和应用用例 |
| `packages/contracts` | 前后端共同使用的协议类型 |
| `packages/runtime` | 模型接入、会话与持久化运行时 |
| `packages/features` | 记忆、技能、笔记、知识检索、提醒和任务 |
| `packages/channel-wechat` | 微信消息适配与持久发送队列 |
| `tests/integration` | 跨模块接口与恢复行为验证 |

```bash
pnpm run check
pnpm --recursive --workspace-concurrency=1 run build
pnpm test
```

`pnpm start` 和 `pnpm run dev` 都会先构建。`dev` 会在进程退出后重启，但不监听源码变化；修改源码后需重新构建。单包开发与依赖边界见 [架构与开发约定](docs/ARCHITECTURE.md)。

自动化测试覆盖本地模拟模型、接口、持久化与恢复路径，不代替真实模型、浏览器、微信和生产部署验收。

## 更多文档

[快速开始](docs/GETTING_STARTED.md) · [配置](docs/CONFIGURATION.md) · [部署与备份](docs/DEPLOYMENT.md) · [微信接入](docs/WECHAT.md) · [故障排查](docs/TROUBLESHOOTING.md) · [v3 设计记录](docs/V3_PLAN.md) · [知识库需求](docs/KNOWLEDGE_FEATURE_REQUIREMENTS.md)

部分文档记录了早期任务中心界面和历史设计；具体界面操作以所运行版本为准，功能规划不代表已实现能力。

## 开源与致谢

本项目基于 [xiaomoBoy/pi-durable-assistant](https://github.com/xiaomoBoy/pi-durable-assistant) 继续开发，现作为独立仓库维护，保留原作者版权声明。持久化能力由 [Pi Durable](https://github.com/earendil-works/pi) 提供。

采用 [MIT 许可证](LICENSE)。本项目并非 Pi Durable、微信或模型服务商的官方产品。
