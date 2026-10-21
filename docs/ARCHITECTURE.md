# 多应用、多模块开发约定

项目使用 pnpm workspaces 和 TypeScript project references。源码分为三个应用、四个私有包，使用 ESM、React、HTTP/WebSocket 和 Pi Durable 1.3.0。根目录命令统一执行构建、依赖检查与回归测试。

## 应用与包

| 位置 / 包名 | 职责 |
| --- | --- |
| `apps/server` / `@assistant/server` | API、鉴权、HTTP/WebSocket/SSE、持久化、任务调度、Teams/微信/邮件集成；不提供静态页面 |
| `apps/desktop` / `@assistant/desktop` | Electron 薄客户端、连接配置、安全存储与 API 邮件通知；不依赖后端运行时代码 |
| `apps/web` / `@assistant/web` | React 界面，由 esbuild 打包；通过独立静态/代理服务 `scripts/web-server.ts` 连接后端 |
| `packages/contracts` / `@assistant/contracts` | 可序列化的 HTTP/WebSocket 数据类型，浏览器和服务端共同使用；无 Node 或 SDK 依赖 |
| `packages/runtime` / `@assistant/runtime` | 模型目录、会话索引、Harness 与 SQLite 生命周期；不注册具体助手功能 |
| `packages/features` / `@assistant/features` | 笔记、网页阅读、附件、计划、提醒、子 Agent、记忆、技能和只读知识检索 |
| `apps/server/src/postgres.ts` / `daily-reports.ts` / `daylight-store.ts` | PostgreSQL 业务数据连接与日报、Daylight 持久化；迁移旧 SQLite 数据时只读源文件，目标写入使用事务和幂等源标记 |
| `packages/channel-wechat` / `@assistant/channel-wechat` | 微信入站验证、会话绑定、回复游标与发送队列 |

`features` 按能力划分内部目录，通过包入口导出当前实际使用的功能。应用入口显式注册助手、前台委派、任务中心和个人资料扩展。通知与知识库配置由应用注入；模块导入不启动服务、不打开数据库。

```mermaid
flowchart LR
  Web[apps/web] --> Contracts[contracts]
  Server[apps/server] --> Contracts
  Server --> Runtime[runtime]
  Server --> Features[features]
  Server --> Wechat[channel-wechat]
  Features --> Runtime
  Wechat --> Runtime
```

图中表示代码依赖。桌面端加载独立 Web，浏览器与桌面都经 Web 服务同源 `/api` 代理访问后端；WebSocket、SSE、上传和下载保持流式转发。API 后端不读取前端 dist；Web 服务不读取账号或数据目录。只有后端运行时打开数据库、采集消息并调度任务。`start:api`、`start:web`、`desktop` 可分别构建和启动，桌面包只包含客户端。

## 开发命令

Node.js 最低版本为 22.19，与 Pi SDK 的运行要求一致。开发依赖固定 TypeScript 6.0.3；模块边界检查使用其 JavaScript Compiler API，升级 TypeScript 7 前需迁移该脚本。`@types/node` 保持 22.x，与部署使用的 Node 主版本一致。

2026-10-18 依赖升级：Pi 的 `chord`、`pi-ai`、`pi-durable` 统一固定为 1.3.0，ACP SDK 为 1.9.0，React / React DOM 为 19.3.1，Electron 为 44.9.0，jsdom 为 30.1.3，lucide-static 为 1.59.0。Pi Durable 1.2 起工具执行结果使用 `output` 而非 `content`；统一由 `packages/features/src/results.ts` 生成，持久化转录消息仍使用 `content`。聊天集成测试检查工具结果包含实际待办正文，防止副作用成功但模型与界面收到空输出。

升级 SDK 后先执行 `pnpm exec tsc -b --force`，再执行检查和测试；普通增量构建可能复用旧依赖类型的检查结果，不能单独证明新 SDK 兼容。

2026-10-21 业务数据迁移：日报与 Daylight 待办从应用管理的 SQLite 迁移到 PostgreSQL/pgvector；PostgreSQL 使用独立业务账号和事务写入，旧 SQLite 作为只读迁移源保留。测试通过 `DATABASE_URL` 连接隔离 schema，避免依赖开发数据。

工作区由 `pnpm-workspace.yaml` 声明，内部依赖使用 `workspace:*`；根 `packageManager` 固定 pnpm 12.9.1。通过 Corepack 使用固定版本，安装时只允许 Electron 和 esbuild 执行必要的依赖构建脚本。

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm test
# 已配置并注入真实模型环境变量后启动
pnpm run dev
```

- `pnpm run build`：按依赖顺序编译源码和测试，将网页静态资源复制到 `apps/web/dist/`。
- `pnpm run check`：增量编译并检查类型、依赖声明、跨包路径、循环依赖以及浏览器/Node 边界。
- `pnpm test`：构建后运行各包、各应用及跨模块集成测试。浏览器模块链接测试使用 Node 的实验性 VM Modules；它不代替真实浏览器交互验收。
- `pnpm run dev`：构建后启动服务，并保留进程退出自动重启功能。源码修改后需要重新构建；此命令不提供文件监听。
- `pnpm start`：构建并启动；已构建环境可直接执行 `node apps/server/dist/main.js`。

只处理一个工作区：

```bash
pnpm --filter @assistant/runtime run build
pnpm --filter @assistant/web run build
pnpm --filter @assistant/server run check
pnpm --filter @assistant/features test
pnpm --filter @assistant/web test
```

工作区构建会先构建自身的 TypeScript 引用。Web 构建可独立执行；完整网页访问需要同时构建并启动 server。单包 `check` 检查该包及其依赖，仓库依赖规则由根目录 `pnpm run check` 执行。

## 必须保持的边界

1. 跨包通过 `@assistant/*` 公开入口导入，禁止引用其他包的 `src/` 或 `dist/`。
2. `contracts` 仅提供类型；Web 除这些类型外只依赖 React 和 React DOM；TSX 与浏览器运行时代码由 esbuild 打包。依赖检查仍禁止引用服务端实现。
3. 服务端只使用 Node 类型环境；Web 使用 DOM 类型环境；不能通过共享全局类型掩盖依赖错误。
4. 环境变量在服务端入口读取。模型凭据、通知目标、知识库目录和微信配置以参数传递，不在功能包内读取进程环境。
5. 跨功能用例放在 `apps/server/src/application/`。例如，归档会话要先检查微信绑定，再停止计划、提醒和后台任务，最后更新会话列表。

这些约定由 `scripts/check-boundaries.ts` 和各工作区配置共同约束。仅增加依赖声明不足以绕过已规定的包依赖方向。

## 持久化与协议兼容

目录迁移保持 HTTP 路径、SSE 数据和 SQLite 文件名称不变。已有 Document 的 `kind`、`version`、作用域、历史与 Fork 行为，以及 Task 的名称和版本保持不变。

四类旧文档的 `history` 原先未设置；代码显式保留 `undefined`，不能仅为满足 SDK 类型而改成 `latest`。`tests/fixtures/durable-definitions.json` 来自迁移前代码，回归测试会核对定义。

静态文件改为支持多层模块路径，仍限定在 Web 产物目录内，只提供 HTML/CSS/JS，并检查路径穿越与目录外符号链接。旧 `/app.js` 入口仍可使用。

## 测试与部署

单元测试随工作区放在 `tests/` 中，跨应用 HTTP、持久化、崩溃恢复和模拟微信测试位于根目录 `tests/integration/`。生成目录为各工作区的 `dist/`、`dist-tests/`、根目录的 `.build/` 和 `tests/dist/`，不提交生成产物。

Docker 共用构建阶段，分别生成 `server` 与 `web` 目标；Web 镜像只含静态资源和 Node 标准库代理脚本，不含后端依赖、不挂载数据、不注入账号环境。API 镜像保留工作区包描述、生产依赖与服务端产物，不含前端 dist 或 Electron 二进制。Compose 只向宿主发布 Web 端口；微信桥仍与后端共享网络命名空间。外部 wx-bot 构建位于 `deploy/wechat/`。

本次组织结构调整不升级 Pi SDK、不更换数据库、不更换 UI 框架。真实模型、真实微信、浏览器交互和实际 Docker 部署需要分别验收。

React 对话与 WebSocket 协议细节见 [Web 对话](WEB_CHAT.md)。
