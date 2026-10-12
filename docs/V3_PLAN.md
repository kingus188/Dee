# v3 第一阶段交付与第二阶段规划

> **当前状态：已于 2026-10-10 通过 [PR #1](https://github.com/xiaomoBoy/pi-durable-assistant/pull/1) 合并到 `main`**。本文件既是 v3 功能边界说明，也记录回归修复与下一阶段待办。使用方法请先阅读 [README](../README.md)。

## 1. 第一阶段交付范围

| 模块 | 已交付能力 | 核心实现 |
| --- | --- | --- |
| 持久计划 | 一次性 / 固定分钟间隔；暂停、恢复、取消；最近/下次执行与运行次数 | `Schedules` Document + `ScheduleTask` |
| 后台子 Agent | 独立子会话、非阻塞执行、进程重启恢复、结果回传、人工停止 | `BackgroundJobs` + `BackgroundTask` |
| 提醒管理 | 旧版提醒的列表、取消和可选 Webhook | `Reminders` + `ReminderTask` |
| 管理 UI | 独立抽屉，可在网页右下角打开 | `apps/web/src/tasks/center.ts` |
| 通知 | 通用 JSON Webhook 或飞书机器人；`errors`/`all`/`off` | `notifyEvent` |
| 成果导出 | 当前会话的用户和助手文本导出为 Markdown | `export.md` |
| 回归测试 | TypeScript 严格类型检查、单测、HTTP、安全与崩溃恢复测试 | `npm run check`、`npm test` |

兼容性约束：继续使用 Node ESM、SQLite、Pi Durable **1.1.0**；保留 v1/v2 的聊天、记事本、Fork、前台子 Agent 和多端 SSE 功能；未引入前端框架或新的 npm 运行时依赖。

## 2. 接口与数据语义

所有 HTTP 接口延用原有 Basic Auth（配置了 `DEMO_PASSWORD` 时）及同源写操作保护。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/conversations/:id/management` | 当前会话的计划、提醒和后台任务；异常终止任务展示失败状态 |
| POST | `/api/conversations/:id/schedules` | `{text,minutesFromNow,everyMinutes?,requestId?}` |
| POST | `/api/conversations/:id/schedules/:uuid/pause` | 暂停；已休眠的旧 Task 不能继续有效触发 |
| POST | `/api/conversations/:id/schedules/:uuid/resume` | 恢复；若已错过时间点，则重新安排未来触发 |
| POST | `/api/conversations/:id/schedules/:uuid/cancel` | 取消计划 |
| POST | `/api/conversations/:id/background` | `{text,requestId?}` 创建后台子 Agent |
| POST | `/api/conversations/:id/background/:uuid/stop` | 请求停止后台任务 |
| POST | `/api/conversations/:id/reminders/:taskId/cancel` | 取消未触发的旧提醒 |
| GET | `/api/conversations/:id/export.md` | 导出当前会话文字 |

参数约束：首次延迟 0.25～525600 分钟，重复间隔为 `0` 或 1～525600 分钟；计划文本最多 1000 字，后台任务最多 4000 字。`requestId` 最多 100 字，特殊属性名会被拒绝。重复提交同一个 requestId 返回该任务**当前状态**，不会创建第二份任务。

### 持久语义

- 周期 Task 经过持久检查点入库，到时间后向主会话提交 `[计划任务]` follow-up；下一次执行时间基于上次计划时间推进。大段停机后跳过错过的周期，避免积压风暴。
- 后台任务由会话拥有，且设置 `background: true`；子会话由后台 Task 拥有，子 Agent 执行完成后结果以 `[后台任务结果]` follow-up 回报。任务报告路径使用稳定的 requestId 去重。
- 对于已取消任务，在投递阶段会重新检查状态。但**取消不是完全事务化的“撤销已经进入 inbox 的消息”**：极端竞争窗口内，提交成功的内容仍可能被 Agent 处理。
- `faux` 测试验证过一次性计划和后台子 Agent 的进程重启恢复，并非所有真实模型行为的保证。

## 3. 配置与操作

本地（Node ≥22.13）：

~~~bash
npm ci
npm run check
npm test
LLM_API=faux npm run dev
~~~

浏览器访问 http://localhost:3000 ，新建会话，右下角打开「任务中心」。

Docker 运行：

~~~bash
cp .env.example .env
# 配置 DEMO_PASSWORD 和模型；生产环境必须有密码
docker compose up -d --build
~~~

默认 Docker 对宿主机仅开放 `127.0.0.1:3300`，需要 Nginx HTTPS 反向代理。无密码的本地 Node 开发模式只监听 loopback；`NODE_ENV=production` 时无口令拒绝启动。生产默认禁止模拟崩溃接口，需要演示时才暂时将 `ENABLE_CRASH_DEMO=1`。持久卷不要随意删除，更新前备份。

通知配置：

~~~dotenv
NOTIFY_WEBHOOK_URL=
NOTIFY_WEBHOOK_KIND=generic
NOTIFY_MODE=errors
~~~

`errors` 仅对明确失败的后台任务触发通知；如需正常提醒或周期计划触发推送，请设 `NOTIFY_MODE=all`。未设置 URL 则不会外部通知。飞书使用 `feishu` 消息格式，其他接收方使用 `generic` JSON；均为尽力投递，没有 outbox/持久重试。详情见 README。

## 4. 质量审计和 Bug 修复记录

[PR #1](https://github.com/xiaomoBoy/pi-durable-assistant/pull/1) 合并前完成以下修复：

1. JSON `null`/数组/字符串不再进入业务逻辑导致 500，而是明确 400。
2. 幂等 requestId 禁止 `__proto__`、`constructor`、`prototype`，对过长键报错，避免原型链属性误判；重试时返回当前状态。
3. HTTP 返回先完成 JSON 序列化再写入响应头，避免成功状态码附带空正文。
4. 提醒与后台子 Agent 在投递前增加取消状态检查，降低取消后回报的竞态风险。
5. 任务管理视图能显示 Durable Task 异常终止；实时任务树纳入后台子 Agent 子会话。
6. 管理页面异步刷新增加会话和请求版本校验，避免旧会话数据覆盖。
7. 本地无密码默认只绑定 loopback；生产环境必须鉴权；模拟崩溃接口默认禁止。
8. Webhook 失败日志不直接输出潜在包含签名的 URL/错误信息；测试增加鉴权与恶意请求场景。

**合并前 CI：8 项测试全通过（8 passed，0 failed）**，覆盖基本 CRUD、请求校验、生产鉴权、任务状态、重启后一次性计划和后台子 Agent 恢复。未进行真实模型/浏览器/生产 VPS 的完整 E2E 验证。

## 5. 第二阶段待办（尚未实现）

- **带时区的日历任务**：Cron/RRULE、按当地时间每日/每周执行，修改任务内容与计划时间。
- **可靠通知**：持久 outbox、发送重试、失败记录、去重与更丰富的推送渠道。
- **模型与成本**：会话级模型选择、真实费率、缓存读写 Token、费用报表。
- **任务与产物**：可筛选的任务历史、失败重试策略、文件型报告与 Artifacts、审批式外部工具。
- **长会话性能**：SSE 增量化、历史分页或虚拟列表、数据与后台任务数量限制。
- **上线验收**：真实 Docker/HTTPS 环境、浏览器 UI、多设备、并发与长时间稳定性测试。

**边界说明**：v3 第一阶段是可运行的单用户个人 Agent，并非多租户平台；未提供强一致外部通知和精确本地日历调度。进入第二阶段前建议先备份并验证 VPS 上现有 SQLite 数据。
