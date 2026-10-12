# Pi Durable Demo — 技术规格与版本记录

> **当前版本：v3 第一阶段，已合并到 main。** 本文件保留 v1/v2 的设计记录，其中部分段落描述的是当时的目标而不是当前行为。**当前功能、运行步骤和安全约束以 [README.md](README.md) 及 [docs/V3_PLAN.md](docs/V3_PLAN.md) 为准**；v3 增量规则见文末。

项目最初是用于演示持久存储、断点恢复、Document、Fork 和多端同步的网页版个人 Agent。v3 在保留演示用途的同时，新增可管理的周期任务、后台子 Agent、Webhooks、Markdown 导出及回归测试。仍保持单用户、易读和最少依赖的方向。

本文件由 Claude 编写，下面的 API 用法都已在 `@earendil-works/pi-durable@1.1.0` 上核对过；写代码时以 `node_modules/@earendil-works/*/dist/**/*.d.ts` 和 `node_modules/@earendil-works/pi-durable/README.md` 为准，不要凭记忆编 API。

## 技术约束

- Node ≥ 22.13，纯 JavaScript ESM（`.mjs`），**不要 TypeScript、不要构建步骤、不要前端框架**。
- 依赖只有 `package.json` 里已有的三个包，加 Node 内置模块。不新增 npm 依赖。
- 后端以 `server.mjs` 路由和 `lib/*.mjs` 能力模块组织；保留原生 JavaScript ESM。前端基础界面在 `public/index.html`，v3 管理抽屉在 `public/v3.js`，无构建步骤。
- 界面文字用简体中文，中文标点用全角。
- 代码注释用中文，少而准。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口；无密码且非生产模式绑定 `127.0.0.1`，有密码时绑定 `0.0.0.0` |
| `DATA_DIR` | `./data` | SQLite 文件放在 `${DATA_DIR}/agent.sqlite` |
| `DEMO_PASSWORD` | 空 | 全站（含 SSE）HTTP Basic Auth，用户名固定 `demo`；**生产模式必须设置** |
| `LLM_API` | `openai-completions` | 可选 `openai-completions`、`openai-responses`、`anthropic-messages`、`faux` |
| `LLM_BASE_URL` | 空 | 例如 `http://sub2api:8080/v1`；`anthropic-messages` 时按 pi-ai 约定填 |
| `LLM_API_KEY` | 空 | 只从环境变量读，**绝不打印、不写日志、不返回给前端** |
| `LLM_MODEL` | 空 | 模型 ID |
| `LLM_CONTEXT_WINDOW` | `128000` | |
| `LLM_MAX_TOKENS` | `8192` | |
| `NOTIFY_WEBHOOK_URL` | 空 | 可选通知接收端 URL；未设置不对外推送 |
| `NOTIFY_WEBHOOK_KIND` | `generic` | `generic` 或 `feishu` |
| `NOTIFY_MODE` | `errors` | `errors` 只推送明确失败的后台任务；`all` 才会推送正常提醒/计划触发；`off` 禁用 |
| `ENABLE_CRASH_DEMO` | `0` | 生产模式只有显式设为 `1` 才允许模拟崩溃 |

## 模型接入（已核对）

非 `faux` 时，用 `createProvider()` 建一个自定义 provider，id 固定 `demo`：

```js
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
// openai-responses → openAIResponsesApi from ".../api/openai-responses.lazy"
// anthropic-messages → anthropicMessagesApi from ".../api/anthropic-messages.lazy"

const model = {
  id: LLM_MODEL, name: LLM_MODEL, api: LLM_API, provider: "demo", baseUrl: LLM_BASE_URL,
  reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: LLM_CONTEXT_WINDOW, maxTokens: LLM_MAX_TOKENS,
  // openai-completions 走未知中转，保守关闭可能不支持的字段
  compat: { supportsStore: false, supportsDeveloperRole: false },
};
const provider = createProvider({
  id: "demo", name: "Demo", baseUrl: LLM_BASE_URL,
  auth: { apiKey: envApiKeyAuth("Demo API key", ["LLM_API_KEY"]) },
  models: [model], api: openAICompletionsApi(),
});
const models = createModels();
models.setProvider(provider);
// 会话的 agent：{ model: { provider: "demo", modelId: LLM_MODEL } }
```

`faux` 模式用于本地无 Key 测试：

```js
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
const faux = fauxProvider();            // provider id "faux"，模型 "faux-1"
models.setProvider(faux.provider);
```

faux 要写成一个**固定剧本**的响应工厂（类型 `FauxResponseFactory = (context, options, state, model) => AssistantMessage`），预置足够多份（例如 `faux.setResponses(Array(1000).fill(factory))`）。剧本：看 `context.messages` 里最后一条 user 消息之后已经有几条 toolResult，按顺序返回：

1. `todo` 工具调用 add 三条：“第一步：查资料”“第二步：等待 10 秒”“第三步：整理结论”（三个 tool call 放在同一条 assistant 消息里）
2. `wait_seconds`（seconds: 10）
3. `todo` done 三条
4. 最终文字回答：“演示任务完成。”

带工具调用的 assistant 消息必须传 `{ stopReason: "toolUse" }`，否则会被当成最终回答（已实测）。

## Durable 核心（已核对）

```js
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const harness = await Harness.open(
  await openNodeSqliteStorage(file),
  { models, registry, onReport: (error) => console.error("Harness 报告：", error?.message) },
  ctx,
);
harness.resume(); // 启动时继续上个进程没做完的任务
// 注意：1.1.0 没有 harness.closed；参见 server.mjs 的致命存储异常处理。
```

- 一个存储文件同时只能被一个进程打开。
- `harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: {...} } }, ctx)` 新建会话，返回 `Conversation`（`.id` 是数字）。
- `harness.conversation(id, ctx)` 取会话，不存在返回 `undefined`。没有“列出所有会话”的接口，见下文 `app.index`。
- `conv.submit({ type: "input", content, requestId, whenBusy }, ctx)` 提交输入；`requestId` 相同会返回同一个 submission（幂等），由前端生成 UUID 传入。`whenBusy` 用 `"followUp"`（默认）或 `"steer"`。**不要 await `wait()`**，接口立即返回。
- `conv.fork(entryId, { ownership: { kind: "ownerless" } }, ctx)` 从某条 entry 分叉。
- `conv.abort(ctx)` 停止当前任务。
- `conv.viewState(ctx)` 返回可订阅状态：`view.value`、`const off = view.subscribe((value) => ...)`、`view.dispose()`。`value.entries` 是当前上下文的全部 entry；`value.docs["pi.live"]` 是运行中的生成和工具（流式输出在这里）；`value.docs["pi.inbox"].items` 是排队的输入；`value.docs["pi.usage"]` 是用量。
- `harness.snapshot(Doc, conversationId, ctx)` 读会话级 Document；`harness.snapshot(SessionDoc, ctx)` 读会话库级 Document。
- 写 Document：`conv.commit(async (tx) => { (await tx.doc(Doc, conv.id)).items.push(x); }, ctx)`；会话库级：`(await tx.doc(SessionDoc))`。

Entry 结构（实测）：每个 entry 有 `id`、`kind`、`model[0]`：

- `pi.user`：`model[0] = { role: "user", content: "文字" }`（content 也可能是数组）
- `pi.assistant`：`model[0].content` 是数组，元素 `{ type: "text", text }`、`{ type: "thinking", thinking }`、`{ type: "toolCall", id, name, arguments }`
- `pi.tool-result`：`model[0] = { role: "toolResult", toolCallId, toolName?, content: [...], isError? }`
- `pi.system`：系统提示变化，前端不显示

`pi.live` 的结构没有实测，前端按“尽力显示”处理：能找到流式文字就显示，找不到就只显示“正在思考…”，并在控制台打印一次结构方便调试。

## Documents

```js
// 每个会话的记事本：Agent 自己维护的待办和备忘。fork 时继承分叉那一刻的内容。
const Notes = defineDoc({
  kind: "app.notes", version: 1, scope: "conversation",
  history: "rewindable", fork: "asOf",
  initial: () => ({ todos: [], memos: [] }),   // todos: [{ text, done }]，memos: [string]
});
// 会话列表（没有官方列表接口，自己记）
const Index = defineDoc({
  kind: "app.index", version: 1, scope: "session",
  initial: () => ({ items: [] }),   // items: [{ id, title, createdAt, forkOf?, forkAtEntry? }]
});
// 进程信息：每次启动 boots + 1，用来在页面上证明“进程重启过”
const Meta = defineDoc({
  kind: "app.meta", version: 1, scope: "session",
  initial: () => ({ boots: 0, lastBootAt: null }),
});
```

会话库级 Document 需要通过某个会话的 `commit` 来写（`tx.doc(Index)` 不带会话 ID）。启动时用 `harness.root(ctx, { agent })` 拿到根会话，专门用来做这类写入，根会话本身不出现在列表里。

## 工具（一个扩展 `assistant`）

用 `defineTool` + `Type`（TypeBox）定义，挂在 `defineExtension({ name: "assistant", tools, sections })`：

1. `fetch_page({ url })`：抓网页正文。只允许 http/https；**先 DNS 解析，拒绝回环、私网、链路本地、元数据地址**（127.0.0.0/8、10/8、172.16/12、192.168/16、169.254/16、100.64/10、::1、fc00::/7、fe80::/10），防止被用来访问服务器内网；15 秒超时；去掉 script/style 和标签，合并空白，截断到 6000 字。`replay: "safe"`。
2. `wait_seconds({ seconds, reason })`：等待 1–120 秒，每秒用 `api.output()` 输出一行进度。用任务备忘把截止时间存下来：`const deadline = await api.memo("deadline", Date.now() + seconds * 1000, ctx)`，崩溃重启后按原截止时间继续等，而不是从头等。`replay: "safe"`。
3. `todo({ action: "add" | "done", text })`：增加待办或把匹配的待办标记完成，写 `Notes`（`api.commit` + `api.conversationId`）。
4. `memo({ text })`：追加一条备忘到 `Notes`。
5. `current_time({})`：返回 Asia/Shanghai 当前时间。

工具执行函数签名：`execute: async (args, api, callContext) => ({ content: [{ type: "text", text }] })`。注意 1.1.0 发布版用 `content`，README 里的 `output` 是更新版本的写法（已实测）；同理 1.1.0 没有 `harness.closed`，错误用 `onReport` 记录。

系统提示用 `section("preamble", () => "...", { tag: false })`，内容大意：你是“小墨的 Durable 助手”，用简体中文简洁回答；遇到多步骤任务先用 `todo` 列出步骤，做完一步标记一步；用户要求等待、定时、隔一段时间再检查时用 `wait_seconds`；需要记住的信息用 `memo`。再加一个 `section("notes", ...)` 把当前记事本内容渲染给模型（参考 README 的 `11-extension-state` 写法：`input.read.snapshot(Notes, input.conversationId, renderContext)`，不存在时返回 `undefined`）。

## HTTP 接口

全部 JSON，出错返回 `{ error: "中文说明" }` 和合适的状态码。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 返回 `public/index.html` |
| GET | `/api/info` | `{ model, api, pid, startedAt, boots }` |
| GET | `/api/conversations` | `Index.items`，新的在前 |
| POST | `/api/conversations` | 新建会话，标题“新对话”，返回 `{ id }` |
| GET | `/api/conversations/:id/events` | SSE。连接时立刻推一次，之后每次 `viewState` 变化推送（合并到最多每 150ms 一次）。事件名 `view`，数据见下 |
| POST | `/api/conversations/:id/messages` | body `{ text, requestId, mode: "followUp" \| "steer" }`；会话标题还是“新对话”时用前 20 字改标题 |
| POST | `/api/conversations/:id/fork` | body `{ entryId }`，新会话标题“分叉：原标题”，记 `forkOf`、`forkAtEntry`，返回 `{ id }` |
| POST | `/api/conversations/:id/abort` | 停止当前任务 |
| POST | `/api/crash` | 演示模式先返回 `{ ok: true }`，再退出进程；生产模式默认 403，仅 `ENABLE_CRASH_DEMO=1` 放开 |

SSE `view` 数据：

```js
{
  conversationId,
  entries: [ // 只保留 user、assistant、tool-result，按时间顺序
    { id, kind: "user", text },
    { id, kind: "assistant", text, toolCalls: [{ id, name, args }] },
    { id, kind: "tool", toolCallId, name, text, isError },
  ],
  live,          // docs["pi.live"] 原样，前端尽力解析
  busy,          // live 非空即视为忙
  inbox: n,      // 排队中的输入数
  notes,         // Notes 快照，没有时 { todos: [], memos: [] }
  usage,         // docs["pi.usage"] 原样
}
```

SSE 要发心跳注释（每 15 秒 `: ping`），连接关闭时 `unsubscribe` 并 `dispose`。

## 前端 `public/index.html`

三栏，手机上自动变单栏（会话列表收进顶部抽屉，记事本放到对话下方）：

- 左栏：会话列表（标题、时间，分叉的会话前加“⑂”），顶部“新对话”按钮。
- 中栏：消息流。用户消息靠右；助手消息靠左，支持简化 Markdown 渲染；工具调用显示成小卡片（工具名＋参数摘要＋结果前 200 字，可展开）；运行中显示流式文字或“正在思考…”；每条用户消息悬停出现“从这里分叉”。底部输入框，Enter 发送，Shift+Enter 换行；忙碌时显示“插话（steer）”开关和“停止”按钮。
- 右栏：“记事本”（待办带勾选状态、备忘列表）＋“运行状态”卡片（进程 PID、启动时间、第几次启动、模型名、本会话 token 用量）＋红色“模拟崩溃”按钮（点击二次确认）。
- 断线时顶部出现黄色横条“与服务器断开，正在重连…”，`EventSource` 自动重连后横条消失，并重新拉 `/api/info`（PID 和启动次数会变，这是演示重点）。
- URL 带 `#会话ID`，刷新后停在同一会话；另一台设备打开同一 URL 能实时看到同一对话（多端同步）。
- 视觉：干净、留白多，浅色为主，适配深色模式（`prefers-color-scheme`）；不引入任何外部 CSS/JS/字体。

## 验收（本地，faux 模式）

1. `LLM_API=faux npm run dev` 启动，浏览器打开能新建会话、发消息，看到 faux 剧本依次出现三条待办、等待进度、待办勾完、最终回答。
2. 在 `wait_seconds` 等待期间点“模拟崩溃”：进程退出，`scripts/dev.sh` 自动拉起；页面出现重连横条后恢复，启动次数 +1，任务**接着等完剩余时间**并给出最终回答，消息不丢、不重复。
3. 两个浏览器窗口打开同一会话，一边发消息另一边实时出现。
4. 对第一条用户消息点“从这里分叉”，出现新会话，记事本是分叉时的状态。
5. 设置 `DEMO_PASSWORD` 后不带口令访问返回 401。
6. `node --check server.mjs` 通过；日志里搜不到 `LLM_API_KEY` 的值。

## 其他文件

- `scripts/dev.sh`：循环运行 `node server.mjs`，进程退出后 1 秒重启（模拟 Docker 的 restart），Ctrl+C 能整体退出。
- `Dockerfile`：`node:22-slim`，`npm ci --omit=dev`，非 root 用户运行，`DATA_DIR=/data`，`EXPOSE 3000`。
- `compose.yaml`：服务名 `pi-durable-assistant`，`restart: unless-stopped`，`env_file: .env`，数据卷 `pi-durable-assistant-data:/data`，`ports: ["127.0.0.1:${HOST_PORT:-3300}:3000"]`，`mem_limit: 1g`，`cpus: 1.0`，`read_only: true` 配 `tmpfs: /tmp`，`security_opt: ["no-new-privileges:true"]`，并加入外部网络 `${SUB2API_NETWORK}`（用来访问 sub2api 容器）以及自己的默认网络。
- `.env.example`：列出所有变量，值留空或示例，**不放真实 Key**。

---

# v2（2026-10-10）

目标：让 Demo 更有意思、更像一个“活的”个人 Agent，同时把 Pi Durable 的流程讲全。v1 的接口全部保留，下面是新增部分。

## 新能力（后端，Claude 实现）

1. **定时提醒（后台持久任务）**：工具 `remind_me({ minutes, text })`，0.25–1440 分钟。建一个后台 Task `app.reminder`，到点后以“follow-up 输入”投回会话（内容以 `[定时提醒]` 开头），Agent 会主动开口提醒用户。进程重启、浏览器关掉都不影响，这是“合上电脑它还在跑”的直接演示。
2. **子 Agent**：工具 `delegate({ task })`，创建一个由这次工具调用拥有的子会话，派它独立完成一件事，等它答完把结果交回主 Agent。子会话可以在前端单独打开查看。
3. **任务面板**：把 Harness 的任务图（每一步都是一个带检查点的持久任务）推给前端。

## SSE `view` 新增字段

```js
{
  // ……v1 字段不变
  tasks: [   // 本会话及其子会话里还活着的任务；结束的任务会消失
    { id, kind, status, phase, owner, background, conversations: [子会话ID] }
    // kind 常见值：pi.generation（调模型）、pi.tool（执行工具）、pi.compaction、app.reminder（定时提醒）
    // status：pending / running / waiting / completing
  ],
  reminders: [ // 本会话的提醒，按时间排序
    { id, text, at /* 毫秒时间戳 */, status: "scheduled" | "fired" | "cancelled" }
  ],
  subagents: [ // 本会话派出的子 Agent
    { conversationId, task, status: "running" | "done" }
  ],
  parentId,    // 如果本会话是子 Agent 会话，这里是主会话 ID，否则 null
}
```

`/api/conversations` 列表不包含子 Agent 会话；子会话通过 `#会话ID` 直接打开，SSE、发消息接口与普通会话相同。

## 前端 v2（Gemini 实现，只改 `public/index.html`）

### 吉祥物“小 D”

右栏顶部放一个内联 SVG 小机器人（自己画，圆润可爱，不用外部图片），带一个对话气泡，根据状态切换表情和动作（CSS 动画即可）。状态判定优先级从高到低：

| 状态 | 判定 | 表现 | 气泡文字示例 |
|---|---|---|---|
| 断线 | SSE 断开 | 眼睛变成 ×，头顶冒烟，轻微抖动 | 我挂了……等我一下 |
| 刚恢复 | 重连后 `boots` 比之前大，持续 4 秒 | 跳起来，眼睛变成星星 | 我回来了！第 N 次启动，接着干 |
| 等待中 | `live.tools` 里有 `wait_seconds` 在跑 | 打瞌睡，头顶 Zzz | 小睡一下，还剩 12 秒 |
| 用工具 | `live.tools` 里有其他工具在跑 | 头顶灯闪，手里举工具 | 正在看网页……（按下表映射） |
| 思考中 | `busy` 且没有工具在跑 | 眼睛转圈，头顶天线闪 | 思考中…… |
| 有提醒 | 空闲且有 `scheduled` 提醒 | 抱着小闹钟 | 3 分 20 秒后提醒你喝水 |
| 空闲 | 其他 | 慢慢眨眼、轻微上下浮动 | 有事叫我～ |

工具名映射：`fetch_page` 看网页、`wait_seconds` 等待、`todo` 记待办、`memo` 记备忘、`remind_me` 定闹钟、`delegate` 派子 Agent、`current_time` 看时间。

手机宽度下小 D 缩小放在顶栏右侧，只显示表情，点一下弹出气泡。

### 新面板（右栏，小 D 下面依次排列）

1. **记事本**（v1 已有，保留）。
2. **定时提醒**：列出提醒，`scheduled` 的显示实时倒计时，`fired` 的显示“已提醒”并变灰。
3. **任务面板**：标题“持久任务（每一步都有检查点）”，按 owner 关系缩进成树，每个任务一行：中文名（`pi.generation` 调用模型、`pi.tool` 执行工具、`app.reminder` 定时提醒、其他显示原名）＋状态小标签（pending 排队、running 运行中、waiting 等待中、completing 收尾）。没有任务时显示“空闲，没有正在运行的任务”。崩溃重启后这里的任务会从 running 变 pending 再变 running，正好能截图。
4. **运行状态**（v1 已有，保留）。

### 消息流

- `delegate` 的工具卡片显示成“子 Agent”样式：任务内容＋状态，并带“查看子 Agent 对话 →”链接（`#子会话ID`）。
- 以 `[定时提醒]` 开头的用户消息不显示成用户气泡，显示成居中的“⏰ 提醒”系统卡片。
- 子 Agent 会话页面顶部显示一条提示：“这是子 Agent 的对话，← 返回主对话”。
- 空会话显示 4 个示例按钮，点击填入输入框：
  - “帮我看看 https://pi.dev 首页讲了什么，抓完等 20 秒再总结”（副标题：演示断点恢复，等待时点模拟崩溃）
  - “2 分钟后提醒我站起来活动一下”（副标题：演示后台提醒，关掉网页也会提醒）
  - “派一个子 Agent 去看看 https://earendil.com 有什么新文章，再告诉我”（副标题：演示子 Agent）
  - “记住：我喜欢简洁、带要点的回答”（副标题：演示 Document 记忆）

### 整体视觉

现在太素。要有个性但干净：

- 品牌名“Pi Durable 小助手”，配一个小 Logo。
- 主色用一个有活力的颜色（比如靛蓝到紫的渐变用在按钮和重点处），背景加很淡的纹理或渐变，卡片圆角和柔和阴影。
- 消息出现、待办勾选、任务状态变化加轻量过渡动画；尊重 `prefers-reduced-motion`。
- 深色模式同样精致。
- 仍然不引入任何外部 CSS、JS、字体、图片。

### 验收

后端 v2 完成前，用仓库外的 mock 服务器自测（按上面的字段造数据，覆盖小 D 的全部 7 种状态）。交付时说明每种状态怎么触发、截图看过没有。

---

# v3（2026-10-10，已合并到 main）

v3 使用现有 `@earendil-works/pi-durable@1.1.0`，没有引入新的运行依赖；新增 `lib/v3.mjs` 和 `lib/v3-utils.mjs` 承担周期计划、后台子 Agent 和任务参数校验，`public/v3.js` 提供独立的可管理抽屉。

核心新增对象与操作：
- `app.v3.schedules` 文档 / `app.v3.schedule` Task：固定分钟间隔的单次或重复计划；带版本号和幂等请求 ID，可暂停、恢复、取消。
- `app.v3.background` 文档 / `app.v3.background-agent` Task：会话拥有的后台任务、Task 拥有的子会话，完成后通过 follow-up 回传结果；支持停止。
- `app.v3.parents` Session 文档：后台子会话返回主会话的导航。
- 原有 `app.reminder` Task：可以在新任务中心取消，并支持可选通知。
- `GET /api/conversations/:id/management`：读取计划、提醒和后台任务，包括异常终结状态。
- `POST /api/conversations/:id/schedules`：创建计划；`POST /schedules/:uuid/pause|resume|cancel` 对当前会话的计划执行状态变更（完整路径以 docs/V3_PLAN.md 为准）。
- `POST /api/conversations/:id/background` / `.../background/:uuid/stop`：后台子 Agent。
- `GET /api/conversations/:id/export.md`：导出用户和助手的可见文字。
- 可选 Webhook：`NOTIFY_WEBHOOK_KIND=generic|feishu`，`NOTIFY_MODE=errors|all|off`，当前为尽力投递而非持久重试。
- `npm run check` 和 `npm test`：合并前 8 项自动化测试通过，含无 Key `faux` 崩溃恢复/安全回归。

**当前 v3 的剩余限制**：不支持精确 Cron / 具备时区语义的日历任务、通知 outbox 与保证送达、完整模型计费、多用户隔离、长会话增量 SSE 或真实生产 VPS 端到端测试。有关每个 API 的入参、部署与第二阶段计划，请阅读 [docs/V3_PLAN.md](docs/V3_PLAN.md)。

