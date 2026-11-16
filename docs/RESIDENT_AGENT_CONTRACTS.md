# 常驻 Agent 执行契约

这份文档区分现有可验证保证与尚未提供的能力。它不授予任何工具权限，也不把设计目标当作已实现功能。

## 权限与来源

- 用户输入、模型生成的委派、外部事件和历史摘要必须保留不同来源。`requireUserInstruction` 验证具体工具调用之前的持久输入及本地委派父链，不使用后来到达的用户消息补授权。
- 来源检查只证明请求来自用户，不证明任意操作、资源、收件人或金额都已获授权。Teams 草稿确认、goal 只读工具名单等具体业务 Gate 仍必须独立执行。
- 跨节点认证证明节点身份，不等于该节点生成的任务获得用户写权限。没有可验证授权记录的 peer 输入不得变为新用户授权。恢复和重放不能扩大权限。
- 未来可继承的 Decision Scope 必须由宿主保存并绑定原始输入/调用、操作、资源、参数摘要、有效期及撤销版本。子权限只能是父权限、请求权限和目标策略的交集。不存在 scope 的旧数据不能推定为全部授权。本次不引入尚无产品定义的四级 ACL。
- Pi peer 的目标宿主现在保存只读 scope，绑定任务正文及 node/session/workspace 地址摘要、策略版本与工具白名单；每次实际工具执行入口（包括 nested/deferred 与 safe execute checkpoint 恢复）重读 scope。宿主注册工具及工具 wrapper 产物均有不可依赖可选扩展选择的执行入口保护；`beforeTool` 只用于提前拒绝，不能作为恢复执行的唯一 Gate。当前策略与已保存名单只能取交集。取消、撤销、变更或未知旧数据拒绝执行。独立 `peer-access` 扩展排在现有宿主审批 hooks 后；实际 execute 包装还会在异步审批结束后再次核对，不随委派工具的移除而失效。
- 本地 delegate 子会话按具体工具调用的 durable assistant/input 锚点和 owner/request 链回溯父 scope；每个祖先仍是工具、资源与撤销上限，恢复执行重新检查。后来到达的用户输入只属于新回合，不为旧调用补授权。Goal/Background 等非工具任务 owner 由宿主按已有业务记录、当前状态、真实 owner task、子会话和稳定 submission entry 验证独立准入，不以祖先会话曾收到 peer 判断授权；未知协议默认拒绝。这不是新的用户授权或跨节点 grant。peer 再委派仍被来源 Gate 拒绝，不声称已经实现跨节点父 grant 的签名验证或任意资源继承。无法逐工具落实该 scope 的非 Pi peer 目标明确拒绝；用户直接使用原生 Agent 不受影响。桌面 `read` 另做批准工作区 canonical 路径校验，拒绝绝对路径越界、父目录与静态 symlink 逃逸（含 Windows 路径）；它不是对并发本机恶意文件系统改写的 OS 沙箱。URL/任意资源的授权不能从 node/workspace 摘要推导。
- 新增有限单向源证明：仅 server Pi 经持久用户来源链验证的 `delegate_to_peer`，在同一事务保存任务与私有源授权。授权固定 15 分钟，不续期；绑定任务摘要、目标、资源请求和只读工具上限，原始用户锚点不传出服务器。桌面仅在新隔离 Pi 会话执行，仍需本地批准、目标 cap 和资源校验；批准工作区及现有受管技能目录是边界，不是任意文件能力。每次实际工具执行和恢复都向原绑定 canonical HTTPS/loopback 服务器在线核验，不走 LAN/HTTP 远端、重定向、缓存或离线降级。源取消与撤销同事务，过期/缺失/错误/无连接停止新工具。旧 server→desktop 无源证明、共享目标会话任务明确拒绝，不回填授权。
- 源证明是受信服务器的在线宿主证明，不是独立设备密码学身份，也不保证跨节点原子撤销：源回复后到目标实际执行仍有时间窗口，已完成的读取无法撤回。反向 desktop→server、原生源、离线授权及跨节点父 grant 继承未新增保证。
- SDK `deferred` 是工具定义的渐进加载，不是审批等待，也不能绕过执行 Gate。

## 状态轴与验收

执行、交付、验收是三个不同状态轴：

| 事实 | 可以说明什么 | 不能说明什么 |
| --- | --- | --- |
| 模型执行成功 | 已取得执行输出 | 内容正确、外发成功或用户认可 |
| 外部服务接收 | 服务返回了与本次操作匹配的接收证据 | 对方已读或用户验收 |
| 用户接受指定 revision | 该版本成果已被明确验收 | 新版成果也被验收、权限扩大 |
| unknown | 发生过不可判定结果的执行尝试 | 确定失败、可以安全重发 |

`UnifiedRun` 保留执行、delivery、review 三轴。`RunReviews` 保存指定成果指纹、accepted/rejected、备注和时间，并拒绝把旧指纹评价应用到新成果。指纹排除 Daylight/通知交付进度，后台交付变化不清掉验收。旧指纹只有能按当前 legacy 字段精确验证时兼容读取及迁移，不能证明对应同一成果时不猜测恢复。这是结构化反馈，不是自动学习奖励。Goal 的模型 complete 进入 review，用户 accept 才完成。证据文本是可核对线索，不代表系统已验证所有引用。

## Source、Projection 与认领

原始 source revision/tombstone 是失效依据，通知、摘要及待处理候选是可重建 projection。`source-lifecycle` 与 episode 的 revision/cursor 检查不能用更晚的同步快照绕过撤回。

对真实并发消费者，认领与预算占用必须在同一存储事务提交；认领身份独立于可重置的重试次数。旧请求返回时只能结算自己持有的 epoch；超限失效及人工重试也推进 epoch，不能在下一次认领之前覆盖刚排队的重试。跨 Pi Durable、SQLite 和 PostgreSQL 不存在此项目提供的全局事务。

租约或 epoch 只栅栏本地状态写入，不会取消已发出的外部请求。不得通过超时自动换一个执行者重做未知的非幂等写操作。

Teams 同步在网络读取前以单条查询取得 source revision、access generation 和独立 sync epoch；全部分页完成后，在同一 SQLite 事务校验三者并接纳整批 projection/tombstone。每次成功受理推进 sync epoch，连首次插入或无变化刷新也能栅栏更早的读取，但不因此改变来源失效版本或撤销有效通知。批中失败全部回滚；被拒绝的旧快照不推进水位。SQLite 提交与水位文件仍非同一事务，提交后崩溃会按稳定消息 ID 重放，不声称全局 exactly-once。

Teams batch 也用独立 epoch；异步 review 后执行前重查当前 claim 与 source。raw fallback 在 POST 前持久化 sending，异常或崩溃保留 unknown/sending，不自动重发；durable 注入沿用稳定 requestId。访问撤销的 source revision 与访问 generation/availability 在同一 SAVEPOINT 提交。

## 外部副作用恢复

- 本地写：事务与稳定 requestId。
- 下游支持幂等：复用同一操作 ID，按渠道协议重试。
- 下游不保证幂等：发送前记录 intent，异常保留 unknown；只有足以关联到本次操作的回读证据才能判定成功。证据不足时停止重发并显式展示未知。
- Webhook 目前为 at-least-once；稳定 `x-pi-event-id` 只有在接收端实现去重时才能减少重复业务动作，不能声称 exactly-once。
- 取消、撤销和后续证据都不能抹去已实际发生的副作用。
- 计划模型结果与独立 `ScheduleResultTask` 在同一事务保存；正常完成和旧观察任务恢复复用这一条交付路径。Daylight 使用既有 `execution-review:<runId>` 幂等动作，通知使用 `<runId>:result` 入队。阶段使用持久失败轮次预算，耗尽一轮后复用既有两次恢复额度继续当前阶段，单次计划也不依赖下一个 tick；后续 tick 重建与任务内恢复共享额度。最终耗尽 checkpoint 在终止前持久保存，进程恢复不能续期；明确 unknown 不自动重做。预算限制已确认失败及恢复轮次，不是外部调用次数硬上限：发出请求后、落库前崩溃仍可能按同一幂等 ID 重放。结果处理状态、阶段、失败轮次、恢复次数和错误进入管理 API 与现有执行详情。通知回执区分 queued、skipped、unknown；queued 只表示持久入队，不代表外部送达。全部失败及恢复额度耗尽后停止自动处理，保留错误供检查。
- 管理、工作空间与执行列表查询只读，不在 GET 中恢复 Daylight 写入。计划和 background 的交付统一经持久结果任务；background 原有报告与通知仍独立，不重复发计划通知。启动只为有效索引会话接纳历史已知失败，排除归档、归档中与已移除会话；completed、unknown 和已耗尽预算不重新受理。旧结果文档/task 身份保留，代码实现位于 `tasks/result-delivery.ts`。Delegate 没有原 Daylight 关联，未添加未定义的补偿。
- Teams 原文提醒异常列表只返回操作 ID、状态、时间与来源有效性，不返回冻结正文。“核对来源”仅重新读取原消息，始终不代表送达、不会解除 unknown 或重新发送。无接收端回执的原文提醒仍需在接收端核实，未提供凭猜测标为成功的按钮。

## Timers 与分层预算

硬截止提醒不应被“用户不空闲”无限延期。重复计划的重叠轮次、可延后主动检查、真实来源变更是不同事件。同一重复计划已有 queued/running 执行时，先按稳定请求 ID 读取实际 submission 对账；只有真实终态才能释放占用，观察任务结束本身不算证据。仍在运行或无法核实时，跳过重叠周期并推进下一次到期时间，不补跑，也不阻塞单次提醒或其他计划。无法核实的记录保留可见原因。

优先用持久状态和时间做确定性调度，不调用模型判断“没有变化”。Goal 已按轮数、截止时间、并发数和累计 provider token 限制执行；在途请求可能超出软 token 上限。通知 attention 限制用户打扰，不等于模型成本或来源 API 限流。不能把这些预算合并成一个含义模糊的 quota。

Goal 单轮五分钟上限从持久 roundStartedAt 计算，重启不重新获得五分钟；旧记录缺失该字段时仅首次恢复持久补齐，无法推测过去已用时间。Goal 在调用模型前复查已加载的 revision、取消、Token、截止时间和已有 checkpoint，避免 Promise.race 急切执行工作导致无效轮次仍发起请求。重复计划使用 SDK 的原子 whenBusy=reject，忙时记录未入队并跳过当前周期，不堆自动 followUp，也不发失败警报；单次提醒不使用此门控。

## Context Delivery 与压缩

当前有效记忆必须按 ID/revision 识别，撤回后不能继续把历史提示或压缩摘要当成有效记忆。需要更多来源时按需读取当前记录及其 provenance，而不是不断增大常驻提示。

模型摘要有损，不能称为“无损 Delta”。原始持久 entry、稳定边界和 source revision 才能用于重读或验证；摘要只作索引和背景，不能成为授权来源。SDK compaction 与应用跨渠道 episode 是不同存储/生命周期，不能用一个未经实现的全局游标覆盖两者。

## 验证边界

故障测试应覆盖旧认领迟到、重试 ABA、重叠调度、unknown 回读、peer 来源隔离、记忆撤回和结果 revision 失效。单元/集成通过不等于真实模型、渠道服务、生产恢复或桌面 UI 已验证。完整跨节点可继承 scope、跨存储统一 Event Inbox 与通用无损上下文同步不是本文件承诺的现有能力。

### 已发布基线验证（2026-11-16）

基线 dev `f7f15fc094aeaa965074b1d66c69aa28d92f8ca8`。`npm run check` 通过（7 个工作区、385 个源码模块，无循环依赖）。`npm test` 共 1362 项，1296 通过、64 失败、2 跳过；63 项失败因缺少 PostgreSQL `DATABASE_URL`，1 项因缺少 `xsltproc`。没有声称全量通过。未运行真实模型、Graph/webhook、生产部署或桌面验收；执行详情增加了结果交付状态；组件/API测试覆盖，但 cloud browser 无法访问执行环境本地预览（ERR_CONNECTION_REFUSED），宽窄屏和明暗视觉验收尚未完成。

### 后续架构补强验证（2026-11-16）

基线 dev `8d66d7884818404baa9d1b5c5efc973a2c6e77f5`，本轮未提交或推送。`npm run check` 通过（7 个工作区、386 个源码模块，无循环依赖）。最终固定代码树 `npm test` 共 1382 项，1316 通过、64 失败、2 跳过；逐项核对仍为缺少 PostgreSQL `DATABASE_URL` 的 63 项与缺少 `xsltproc` 的 1 项。专项覆盖同步三栅栏及批次回滚、持久时间/失败轮次预算、local delegate 多层继承、派生输入不切断父链、撤销后 checkpoint 恢复、历史 peer 后的新用户 Goal 及独立任务证据失效。独立只读复核未发现剩余明确阻塞。未执行真实模型、Graph/webhook、部署或跨节点源 grant 协议验证。

### 完整环境与恢复收口验证（2026-11-16）

在同一 dev 基线的未提交工作树继续实施。使用官方 Debian 包在用户目录隔离准备 PostgreSQL 17.11、pgvector 0.8.0 和 xsltproc 1.1.35，不连接生产库、不修改系统服务。最终 `npm run check` 通过（7 个工作区、391 个源码模块，无循环）；`npm test` 1403 项全部通过，0 失败、0 跳过。原数据库/xsltproc 环境阻塞已在本地消除；CI 使用 PostgreSQL 16，本结果不是 CI 或容器构建结果。

真实 HTTP 进程重启验证发现并修复 SDK 表读写顺序错误：background 读取答案、批次恢复读取旧 task/submission/entry 均先于结果任务创建，并新增三个回归。真实 application 重开覆盖归档/归档中/移除会话不恢复；源 grant 实际关闭重开验证 revision/expiry 不重置，过期或撤销后目标零执行。独立复核未发现剩余已知阻塞。

Teams 异常面板组件/API与关闭重开测试通过，但 CUA 浏览器无法访问执行环境的 localhost 预览（ERR_CONNECTION_REFUSED）；临时预览已清理，未声称真实视觉验收完成。仍未进行真实跨设备账户、模型、Graph/webhook、生产部署验证；不提供反向源 grant、设备独立身份、离线授权或分布式原子撤销保证。

### 本地提交与真实传输补验（2026-11-16）

上述 48 文件已本地提交为 `79fb20428401a851202534e12ca436b2476e3aa5`，未推送。后续补验使用合成数据和 loopback，不连接外部账号或发送真实消息。

- peer 使用源 runtime 子进程、真实 HTTP/WS 路由和实际 desktop agent，贯通签发、投递、本机确认、在线来源核验、文件读取与单次结果回报。确认等待期间源撤销后，工具明确拒绝，内容未进入模型。源进程不是完整生产应用，未验证真实设备、TLS、真实模型或设备独立身份。
- Graph 使用真实 reader 与 SQLite，网络响应由测试注入；覆盖正文编辑、删除、403 和无效响应。核对显式禁用媒体下载，避免额外处理媒体队列；请求白名单回归在旧实现失败、修复后通过。403 只证明读取失败时保留 unknown，不声称已完成远端权限撤销。
- 异常接口经真实 HTTP 服务器验证鉴权、Origin、非法输入、离线拒绝及冻结正文不泄漏。真实 TCP 接收完整请求后断开回执：webhook 重开队列后以相同 ID/正文重放，只有接收端去重才产生单次业务效果；原文 Teams 保持 unknown，重开后不重发。存储关闭重开不是 SIGKILL 崩溃验证。

本轮最终 `npm run check` 通过（391 源码模块）；隔离 PostgreSQL 17/pgvector/xsltproc 环境中全量 `npm test` 为 1413 项通过、0 失败、0 跳过，测试数据库已关闭。独立复核完成。视觉验收仍受 cloud browser 与执行器 localhost 隔离限制；未执行真实外部账号/设备、生产 TLS、CI 或部署验证。
