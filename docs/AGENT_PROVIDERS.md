# 桌面 Agent 接入

Dee 保留 Pi Durable，并在桌面本机会话中支持 Codex、Claude Code 和通用 ACP Agent。服务器业务、定时任务继续使用 Pi Durable。双端队列可以寻址具体 Agent 的已有会话；服务器任务仍须桌面批准，不因当前界面选择了其他 Agent 而改派。外部 Agent 通过协作工具请求服务器执行，不直接获得服务器业务工具。

## 使用

在桌面本机首页点击输入框中的 Agent 与模型名称，选择 Pi、Codex、Claude Code 或 ACP Agent。工作目录默认自动创建。面板支持搜索和左侧筛选；Pi 显示其原生配置中的默认模型，外部 Agent 当前使用各自默认模型，未提供模型目录或推理强度选项。

| Agent | 接入协议 | 配置 |
| --- | --- | --- |
| Pi | Pi Durable + 已安装 Pi 的模型 SDK | 安装提供 `SettingsManager` 和 `ModelRuntime` 的 `@earendil-works/pi-coding-agent`，在 Pi 中选择默认模型并配置认证；支持 `PI_CODING_AGENT_DIR` |
| Codex | `codex app-server` / stdio JSON-RPC | 安装支持 app-server 的 Codex CLI，在终端完成其支持的认证；必要时在「Agent 设置」填写可执行文件绝对路径 |
| Claude Code | Claude Agent SDK `0.3.318` | 安装 Claude Code，在终端完成其支持的认证；「Agent 设置」填写本机 Claude 可执行文件路径 |
| ACP Agent | 已有 ACP SDK `1.9.0` / stdio | 安装并认证所选 ACP Agent，填写可执行文件、每行一个的启动参数及其模式 ID |

各 Agent 使用自己支持的登录、API 配置和计费方式，Dee 不再提供「本机模型」表单或保存模型密钥。Pi 通过原生 SDK 在主进程读取配置并处理认证，页面只接收模型名称和限制；修改 Pi 配置后重新选择 Pi。缺少默认模型、认证或兼容 SDK 时会提示，不会回退到旧桌面模型。Codex、Claude 的原生配置读取保持不变。可执行文件优先在桌面进程的 PATH 中查找，并补充常见安装目录及 `~/.nvm/versions/node/*/bin`；多个 nvm 版本存在时优先较新版本，显式 PATH 的优先级更高。Codex、Claude 使用其他位置的安装时，可填写绝对路径。

原生 Codex、Claude 不提供额外启动参数入口，避免参数覆盖本次会话的权限约定。ACP 参数按字面值传递，不经过 shell 展开；一个参数占一行，不要把命令和参数一起写进可执行文件字段，也不要在这里填写密钥。

如果 ACP Agent 声明了多种模式，必须指定其实际模式 ID；未填写时，首次启动会显示可用 ID 并停止，不发送任务。ACP 的模式与沙箱由具体 Agent 实现，Dee 不把不同 Agent 的模式名称视为相同权限保证。

## 会话与执行状态

同一 Agent、工作目录及执行配置继续使用其原生会话。切换 Agent、目录或配置会选中另一条绑定的会话；「新会话」建立新的原生会话，保留旧记录。界面仍只显示当前绑定；协作工具可以列出和读取旧会话，并按明确地址在旧上下文继续执行，不会切换当前界面。不支持将一个 Agent 的原生历史迁移给另一个 Agent。

界面显示文本、执行过程、待审批或待回答的问题，以及完成、失败、取消和中断状态。允许只针对当前请求，不保存永久放行规则；审批五分钟未响应会拒绝，执行最多三十分钟。重复发送同一请求 ID 不重复执行，内容不同则拒绝。

停止操作会等待本次执行清理。macOS/Linux 中，Dee 为外部 Agent 建立独立进程组，停止时也终止该进程组中的工具后代；无法确认退出时显示中断并提示核对，不报告停止成功。Windows 采用系统进程树终止路径，本轮未完成 Windows 验证。Agent 自行脱离进程组的服务不属于此终止保证。

应用重启后保留对话与原生会话标识，执行中的记录标为中断，不自动重放未知结果。发送新消息时尝试恢复原生会话；ACP 未声明恢复能力时会明确报错，需要新建会话。恢复原生上下文不保证已经中断的外部操作只执行一次。

## 权限与数据

Pi 工具继续走原来的本机确认。Codex 使用 `workspace-write` 和 `untrusted` 审批策略；Claude 使用原生 `default` 权限模式，沿用用户、项目及本机配置，由 SDK 回调把需要处理的请求送回 Dee。原生配置已经允许的操作可能不触发回调，不承诺所有工具逐项询问。

ACP 权限请求只选择允许本次或拒绝本次；不支持相应选项时取消请求。Agent 自己执行的工具仍受它自身的权限、沙箱和系统限制控制，工作目录或 worktree 不等于安全沙箱。

未指定会话地址的旧式入站任务继续在独立 Pi 子会话执行，按钮显示「批准 Pi 执行」。指定 `targetSession` 的任务只在该 Agent、该持久会话及其保存的工作目录/执行配置上运行；确认区显示目标 Agent 与会话，批准后仍保留该 driver 的原生权限约定。

本机与服务器窗口可以同时使用。本机首页独立运行自己的 Agent；服务器提供远程业务能力，通过双端任务队列向客户端请求本机操作。服务器请求必须先经客户端批准，文件和命令工具继续按本机授权处理。

桌面通过主进程 WebSocket 连接 `/api/peers/socket`，在连接内使用配对凭据或服务器口令认证，兼容丢弃握手认证头的代理；认证前不能读取或写入业务数据。服务器推送任务变化，客户端每 30 秒校准队列，对话正文经同一连接传输。连接断开后自动重连并重新订阅，不在连接层重放未确认的写操作。健康探测在无法建立协作连接时仍可使用只读 HTTP，区分服务器离线与配对失败。

本机首页保留左侧主导航。「对话」返回本机 Agent；待办、通知及「更多」中的个人内容在服务器窗口打开，复用现有窗口并保留本机对话与未发送内容。外部 Agent 继续通过顶部的「新会话」开始新对话，Pi 继续使用现有持久会话。

本机侧栏沿用原有工作空间的展开与收起布局，桌面记住收起偏好，窄窗口使用覆盖侧栏。本机会话列表显示当前所选 Agent 的持久会话。Pi 和所有外部 Agent 的对话正文通过双端认证保存到服务器，在服务器历史中标记为「本机」，可阅读和导出；继续执行须回到原本机 Agent。

桌面每 5 秒检查变化，发送 Pi 消息和正常退出时也尝试同步。断网时保留本机记录，恢复连接或重启后补传；同步失败会提示。重试使用持久化版本号，不重复创建服务器会话。每条对话绑定首次同步的服务器，切换连接不会将旧对话传到另一台服务器。旧的本机记录也会补传；已从服务器历史移除的对话不会被后续同步重新加入。每条对话最多 10000 条消息、单条消息最多 1000000 字符、总计最多 20 MiB，超限保留本机记录并报告未同步，不截断正文。

连接状态分别检测服务器 `/api/info` 与双端接口：健康接口可用时显示「服务器已连接」，协作队列也就绪时显示「双端已连接」。协作接口缺失或未配对会给出对应提示，不再将其误报为整个服务器断线。网页自用免登录不开放匿名协作：管理员在服务器配置 `PEER_TOKEN`，为桌面配对相同凭据；客户端将其按服务器地址加密保存到 `desktop-peers.json`，不放入模型配置或页面。已有服务器口令认证仍可使用。

`userData/desktop-agent.json` 保存 Agent 类型和命令配置；旧版 Pi 模型数据原样保留供回退，但不解密、不使用。新配置不保存模型密钥。`userData/external-agent-sessions.json` 保存外部会话绑定、文本、活动与状态，文件权限为 `0600`。本机运行状态和断网缓存继续保留；服务器同步不包含原生会话标识、工作目录、命令配置、活动或凭据，只上传 Agent 类型、正文及同步标识。原生 Agent 的会话数据继续由其自身管理。记录无法读取时保留原文件并阻止外部执行，Pi 不受该文件损坏影响。

外部记录总量限制为 20 MiB，单条回复限制为一百万字符，执行过程显示最近两百项。达到记录限制后须先人工备份并归档记录；Dee 不自动删除历史。

## 已有会话协作协议

`source` / `target` 继续使用 `server` 或 `desktop-UUID`。新增的 `sourceSession` / `targetSession` 均为 `{ agent, sessionId }`：`agent` 为 `pi | codex | claude | acp`，Pi 地址为 `pi-<conversationId>`，外部 Agent 地址为 Dee 保存的会话 UUID。外部地址不是 Codex thread ID、Claude session ID 或 ACP session ID；原生标识只在桌面内部传给原 driver，不能从服务器伪造。服务器目标只接受 Pi。

| 接口 | 行为 |
| --- | --- |
| `GET /api/peers/sessions?nodeId=server` | 列出服务器可寻址 Pi 会话；省略 `nodeId` 也表示服务器 |
| `GET /api/peers/sessions?nodeId=desktop-UUID` | 列出该桌面最近同步的会话目录，包括空会话；`syncedAt` 表示同步时间，状态不是实时执行保证 |
| 同一路径增加 `agent`、`sessionId` | 读取明确会话，最近最多 200 条、合计最多 64000 字符；超过限制返回 `truncated: true`。桌面内容来自同步快照 |
| `POST /api/peers/sessions`，`{ deviceId, items }` | 桌面发布地址与状态目录，最多 500 条；不发布命令、工作目录、原生标识或凭据 |
| `POST /api/peers/messages`，`{ id, source, sourceSession, target, targetSession, task }` | 向已有会话持久受理，返回 `202 { item }`；`id` 是调用方持久复用的请求 UUID，任务最多 16000 字符 |
| `GET /api/peers/tasks/:id?deviceId=desktop-UUID` | 复用原队列查询状态、结果与 `deliveryError` |
| `POST /api/peers/tasks/:id/complete` | 保留原目标设备结果确认接口、认证及冲突保护 |

HTTP 与已配对 WebSocket 使用同一 API；未新增另一套消息通道。服务器中保存的桌面正文仍是只读历史，不能通过将其编号包装成 Pi 地址在服务器执行。移除的桌面历史也不会重新成为可执行服务器会话。目录及正文沿用首次同步服务器的绑定，切换连接后不自动向新服务器上传旧会话。服务器转发不支持桌面 A 到桌面 B；同一桌面内不同 Agent/会话使用本地队列。

Pi 的 `peers` 扩展提供 `peer_sessions`、`read_peer_session`、`send_to_peer_session`、`peer_task_status`，原 `delegate_to_peer` 保留。`send_to_peer_session` 要求 `target`、`agent`、`sessionId`、`task`，请求 UUID 使用工具 memo 持久复用，来源从当前 Pi 会话取得。旧版已经持久化的无会话地址任务不改写。

服务器的状态工具还返回桌面目标的 `targetOnline`，用于区分等待批准/空闲与目标离线；它来自设备心跳，不保证原生模型或账户可用。

Codex、Claude、ACP 注入同名的 `dee_peers` MCP 工具。原生发送工具额外要求调用方提供并在重试时保留 `requestId` UUID；桌面自动绑定实际来源会话，不能通过工具参数冒充其他来源。MCP 只把调用交回现有队列：Codex 通过 `thread/start` / `thread/resume` 的会话配置，Claude 通过 SDK 的 `mcpServers`，ACP 通过 `session/new` / `session/load` 的 `mcpServers` 注册 stdio 适配器。适配器使用进程生命周期内的本地鉴权连接，不持有业务凭据，也不在断线后重放操作。原生配置中的已有工具权限继续生效。

桌面操作入口为现有对话，不另设手工路由表单：先要求 Agent 查询服务端已有会话并显示地址，再明确要求把任务发到指定地址。服务器模型同样先查询在线设备的已有会话后发送；桌面右侧「委托任务」显示目标 session、等待批准/正在执行/已完成及「查看结果」，用户点击「批准 Pi / Codex / Claude Code / ACP Agent 执行」后才进入目标原会话。后台目标执行不切换当前选中的 Agent 或对话。连接设置中的「保存口令」可取消，此时口令只保留在当前应用进程，不调用系统钥匙串保存；重启需重新输入。

桌面可信 preload 还提供 `peerSessions(node?)`、`readPeerSession({ node, session })`、`sendPeer(submission)`、`peerStatus(id)`；IPC 沿用本机窗口及主 frame 校验。这些接口不改变当前选择，也不放宽服务器配对要求。

忙时，Pi 使用原会话的持久 `followUp` inbox，当前执行完成后才开始新轮次。外部 Agent 复用单个执行槽；批准的请求保持 `queued` 并显示「等待空闲」，不停止当前任务，不把消息发送给当前选中的另一会话。每个请求记录自己的执行状态，后续轮次不会覆盖先前结果。断线可见，队列保留相同 UUID 重试；相同 UUID 的地址或任务不同返回冲突。

完成或失败结果以稳定的 `peer-result:<jobId>` 请求送回来源已有会话，内容包括任务 ID、目标节点及会话、状态与结果，并自动在原上下文继续执行。Pi 使用 `input` + `followUp`，同时以 `app.peer-result` 保存关联信息；外部 Agent 使用已保存的原生会话绑定和原请求 ledger 启动真实 driver turn，不切换当前界面。回传本身不创建新 peer job；只有继续工作确实需要另一个协作任务时才由模型明确发送，避免纯回执递归。

`PeerJobs.resultDelivered` 只表示 continuation 已持久受理，不表示来源新轮次已完成。来源 Pi 未配置或外部执行槽忙时，结果和 `deliveryError` 留在原队列，桌面即使离线也会重试本地续跑，重启后同样恢复；不以目标完成为由丢弃待送达结果。受理后、队列确认前中断，使用同一请求 ID 查找既有请求，不重跑目标或续跑。旧版 Pi 已占用同名请求 ID 的被动 write 使用稳定的 `peer-result:<jobId>:continuation` 升级一次；旧版外部展示消息在首次原生续跑受理时替换。整应用退出或崩溃后，已受理但结果未知的外部原生请求仍明确标记 interrupted，不自动重放；Pi 沿用 SDK 的持久 submission 恢复。

Codex 0.167.1 的 MCP 单次工具审批通过 `mcpServer/elicitation/request`（`mode=form`、`_meta.codex_approval_kind=mcp_tool_call`、空表单）传递。该请求经过当前 thread/turn 校验后走现有用户审批；仅返回本次 `accept` / `decline`，不接受其 session/always 持久授权选项，不修改 `approvalPolicy=untrusted`。其他 elicitation 表单不自动放行。

## 验证边界

自动测试覆盖类型与模块边界、进程组、审批竞态、持久化及切换。隔离 Electron 检查覆盖真实 preload/IPC、选择面板和最小窗口布局，使用合成 Agent，不等于真实业务验收。

打包使用现有 esbuild 流程，Claude SDK 延迟加载；用户仍需单独安装本机 CLI。真实 Codex、Claude 同 Agent 多轮及切回可恢复各自上下文，跨 Agent 不交接历史；真实 ACP 的会话初始化仍未通过。整应用强杀后可能遗留外部进程和活动标记，渲染进程崩溃不会自动重新加载，这些恢复限制尚未解决。

已有会话协作的新增自动测试覆盖 Pi 忙时 inbox、三种外部 Agent 的地址恢复与请求去重、MCP stdio 工具、空会话目录、只读历史保护、完成后的自动来源续跑、离线/重启恢复，以及真实本地认证 WebSocket → API → 桌面队列 → Codex JSON-RPC fixture 的双向链路；后者启动的是合成 app-server，不调用真实模型。独立真实验收另覆盖 Codex/Claude MCP 与原生恢复、Codex → Claude 自动回源、Codex ↔ 服务端 Pi，以及并排安装包的 Pi ↔ 本机服务端 Pi 双向 GUI：自然语言发现会话、模型实际发送、窗口待批准/批准/执行/结果及自动续跑。后台 Pi 任务在 Codex 视图选中时仍送入原 Pi 会话，不替换当前视图。证据见 `artifacts/peer-session-implementation-20261111/ACCEPTANCE.md`；真实 ACP 和远程目标仍未验收。
