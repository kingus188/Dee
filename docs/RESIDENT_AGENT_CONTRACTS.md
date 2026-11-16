# 常驻 Agent 执行契约

这份文档区分现有可验证保证与尚未提供的能力。它不授予任何工具权限，也不把设计目标当作已实现功能。

## 权限与来源

- 用户输入、模型生成的委派、外部事件和历史摘要必须保留不同来源。`requireUserInstruction` 验证具体工具调用之前的持久输入及本地委派父链，不使用后来到达的用户消息补授权。
- 来源检查只证明请求来自用户，不证明任意操作、资源、收件人或金额都已获授权。Teams 草稿确认、goal 只读工具名单等具体业务 Gate 仍必须独立执行。
- 跨节点认证证明节点身份，不等于该节点生成的任务获得用户写权限。没有可验证授权记录的 peer 输入不得变为新用户授权。恢复和重放不能扩大权限。
- 未来可继承的 Decision Scope 必须由宿主保存并绑定原始输入/调用、操作、资源、参数摘要、有效期及撤销版本。子权限只能是父权限、请求权限和目标策略的交集。不存在 scope 的旧数据不能推定为全部授权。本次不引入尚无产品定义的四级 ACL。
- Pi peer 的目标宿主现在保存只读 scope，绑定任务正文及 node/session/workspace 地址摘要、策略版本与工具白名单；每次实际工具执行入口（包括 nested/deferred 与 safe execute checkpoint 恢复）重读 scope。宿主注册工具及工具 wrapper 产物均有不可依赖可选扩展选择的执行入口保护；`beforeTool` 只用于提前拒绝，不能作为恢复执行的唯一 Gate。当前策略与已保存名单只能取交集。取消、撤销、变更或未知旧数据拒绝执行。独立 `peer-access` 扩展排在现有宿主审批 hooks 后；实际 execute 包装还会在异步审批结束后再次核对，不随委派工具的移除而失效。
- peer 再委派仍被来源 Gate 拒绝，不声称已经实现跨节点父 grant 的签名验证或任意资源继承。无法逐工具落实该 scope 的非 Pi peer 目标明确拒绝；用户直接使用原生 Agent 不受影响。桌面 `read` 另做批准工作区 canonical 路径校验，拒绝绝对路径越界、父目录与静态 symlink 逃逸（含 Windows 路径）；它不是对并发本机恶意文件系统改写的 OS 沙箱。URL/任意资源的授权不能从 node/workspace 摘要推导。
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

Teams batch 也用独立 epoch；异步 review 后执行前重查当前 claim 与 source。raw fallback 在 POST 前持久化 sending，异常或崩溃保留 unknown/sending，不自动重发；durable 注入沿用稳定 requestId。访问撤销的 source revision 与访问 generation/availability 在同一 SAVEPOINT 提交。

## 外部副作用恢复

- 本地写：事务与稳定 requestId。
- 下游支持幂等：复用同一操作 ID，按渠道协议重试。
- 下游不保证幂等：发送前记录 intent，异常保留 unknown；只有足以关联到本次操作的回读证据才能判定成功。证据不足时停止重发并显式展示未知。
- Webhook 目前为 at-least-once；稳定 `x-pi-event-id` 只有在接收端实现去重时才能减少重复业务动作，不能声称 exactly-once。
- 取消、撤销和后续证据都不能抹去已实际发生的副作用。
- 计划模型结果与独立 `ScheduleResultTask` 在同一事务保存；正常完成和旧观察任务恢复复用这一条交付路径。Daylight 使用既有 `execution-review:<runId>` 幂等动作，通知使用 `<runId>:result` 入队。阶段有界重试，后续计划 tick 可重建故障结果任务，最多两次；明确 unknown 不自动重做。结果处理状态、阶段、失败轮次、恢复次数和错误进入管理 API 与现有执行详情。通知回执区分 queued、skipped、unknown；queued 只表示持久入队，不代表外部送达。单次计划在超限故障后没有后续 tick 自动重建。

## Timers 与分层预算

硬截止提醒不应被“用户不空闲”无限延期。重复计划的重叠轮次、可延后主动检查、真实来源变更是不同事件。同一重复计划已有 queued/running 执行时，先按稳定请求 ID 读取实际 submission 对账；只有真实终态才能释放占用，观察任务结束本身不算证据。仍在运行或无法核实时，跳过重叠周期并推进下一次到期时间，不补跑，也不阻塞单次提醒或其他计划。无法核实的记录保留可见原因。

优先用持久状态和时间做确定性调度，不调用模型判断“没有变化”。Goal 已按轮数、截止时间、并发数和累计 provider token 限制执行；在途请求可能超出软 token 上限。通知 attention 限制用户打扰，不等于模型成本或来源 API 限流。不能把这些预算合并成一个含义模糊的 quota。

Goal 在调用模型前复查已加载的 revision、取消、Token、截止时间和已有 checkpoint，避免 Promise.race 急切执行工作导致无效轮次仍发起请求。重复计划使用 SDK 的原子 whenBusy=reject，忙时记录未入队并跳过当前周期，不堆自动 followUp，也不发失败警报；单次提醒不使用此门控。

## Context Delivery 与压缩

当前有效记忆必须按 ID/revision 识别，撤回后不能继续把历史提示或压缩摘要当成有效记忆。需要更多来源时按需读取当前记录及其 provenance，而不是不断增大常驻提示。

模型摘要有损，不能称为“无损 Delta”。原始持久 entry、稳定边界和 source revision 才能用于重读或验证；摘要只作索引和背景，不能成为授权来源。SDK compaction 与应用跨渠道 episode 是不同存储/生命周期，不能用一个未经实现的全局游标覆盖两者。

## 验证边界

故障测试应覆盖旧认领迟到、重试 ABA、重叠调度、unknown 回读、peer 来源隔离、记忆撤回和结果 revision 失效。单元/集成通过不等于真实模型、渠道服务、生产恢复或桌面 UI 已验证。完整跨节点可继承 scope、跨存储统一 Event Inbox 与通用无损上下文同步不是本文件承诺的现有能力。

### 本次验证（2026-11-16）

基线 dev `f7f15fc094aeaa965074b1d66c69aa28d92f8ca8`。`npm run check` 通过（7 个工作区、385 个源码模块，无循环依赖）。`npm test` 共 1362 项，1296 通过、64 失败、2 跳过；63 项失败因缺少 PostgreSQL `DATABASE_URL`，1 项因缺少 `xsltproc`。没有声称全量通过。未运行真实模型、Graph/webhook、生产部署或桌面验收；执行详情增加了结果交付状态；组件/API测试覆盖，但 cloud browser 无法访问执行环境本地预览（ERR_CONNECTION_REFUSED），宽窄屏和明暗视觉验收尚未完成。
