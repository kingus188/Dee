# 微信 iLink 接入（Pi Durable + wx-bot）

> 状态：当前隔离服务端实例已启用固定版本 wx-bot 并迁移现有登录状态，桌面端微信服务已关闭。已通过真实微信 `Hello` 入站、模型生成正常问候及发送接口接受回复的链路验证；长期稳定性与重启恢复尚未验收，详见[本轮部署记录](DEPLOYMENT.md#5-运行验收)。

## 架构

Compose 分别运行 Web、Node.js API 后端和可选 Go wx-bot。wx-bot（微信扫码、轮询、媒体协议）与后端使用 `network_mode: service:pi-durable-assistant` 共用网络命名空间，仅通过 `127.0.0.1` 内部 HTTP 通信，**不对公网开放 wx-bot 的 18790 端口**。桌面端只作为 API 客户端，不启动或管理微信桥接进程。

`wx-bot` 来自 [lawrencewzen/wx-bot](https://github.com/lawrencewzen/wx-bot) 的固定提交 `57ed5f56eedce782e378483f762c7565c45ade5d`。Docker 构建时执行 `deploy/wechat/patch_upstream.py`，修复“先推进游标、后投递 Webhook”导致的漏消息，并参考 [腾讯官方协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md) 更新二维码为 POST。若上游变更导致补丁不匹配，构建会失败而非静默忽略。其余 iLink 协议细节仍由 wx-bot 维护。

## 1. 配置密钥

```bash
cp .env.example .env
# 同时填写原有 DEMO_PASSWORD、LLM_API_KEY / 模型参数
# 设置 WECHAT_ENABLED=1
# 以下命令生成两个不同的随机密钥，分别填入 WECHAT_WEBHOOK_KEY 与 WECHAT_SEND_TOKEN
openssl rand -hex 32
openssl rand -hex 32
```

两个令牌不同，也不能和网页登录密码共用。不要把 `.env` 上传到 Git。推荐保持默认 `WECHAT_SEND_URL=http://127.0.0.1:18790/v1/send`。

默认仅允许 **扫码绑定微信账号自己** 给 ClawBot 发送消息，配置位于 `deploy/wechat/config.json`。需要多个账号时，添加不同 binding（账号），并逐个登录。现阶段微信图片/文件/视频会告知 Agent “尚不能读取附件”，不会让模型假装已经看过文件；语音支持微信提供的转写文字。

## 2. 启动与扫码

```bash
# 首次构建双服务，必须有 Go 官方依赖源与 GitHub 出站网络
docker compose --profile wechat build
# 先启动主服务
docker compose up -d pi-durable-assistant
# 前台扫码，最好在 SSH 终端或带二维码的交互终端执行
docker compose --profile wechat run --rm wx-bot --config /etc/wx-bot/config.json login primary
# 之后常驻启动
docker compose --profile wechat up -d
docker compose --profile wechat logs -f wx-bot
```

用扫码微信给 **ClawBot 会话** 发送一条文本。Pi Durable 会创建“微信：primary”会话并自动发回最终回答。网页、桌面端与微信共用同一服务端 Durable Runtime。扫码后 `bot_token`、消息游标、`context_token` 保存在 `wx-bot-state` Docker 持久卷；Agent SQLite 保存在 `pi-durable-assistant-data`。切勿 `docker compose down -v`。

## 3. 查看状态与排障

```bash
docker compose --profile wechat exec wx-bot wx-bot --config /etc/wx-bot/config.json status
docker compose --profile wechat logs --tail=150 wx-bot
# 带 HTTP Basic Auth，可查看会话数与待发送数量
curl -u demo:<DEMO_PASSWORD> https://YOUR_DOMAIN/api/wechat/status
```

- 无微信绑定：确认 `WECHAT_ENABLED=1`、已扫码、消息来自被授权账号。
- `-14`：iLink 登录过期，重新运行上面的 `login primary`，然后重启 wx-bot。
- `no context_token`：先从微信给 ClawBot 发消息，之后再测试回复。被阻止发送的旧消息目前留在 Outbox，**不会自动解封补发**，避免未经确认的大量补推；它们会算进未送达清单，桌面端会提醒「需要手动处理」。
- 网络或 5xx：出站 Outbox 使用退避重试；进程重启后恢复。微信成功发送但 Pi Durable 尚未标记为 sent 就崩溃，可能重复发送，**不是端到端 exactly-once**。
- 腾讯服务端存在主动回复窗口、限流或策略变化，定时任务结果可能无法送达微信；不要将它作为唯一告警手段。
- Go Dockerfile 固定上游版本且运行单测；若构建报补丁不匹配，需要复核当前腾讯协议后升级版本，不能随意取消补丁。

## 4. 消息一致性与安全边界

入站流程：iLink 长轮询 → wx-bot 白名单 → Bearer token Webhook → Durable 会话（稳定 requestId 幂等）→ 模型运行 → 观察已提交的助手 Entry → session-scoped Document Outbox → 本机发送 API。收到 HTTP 2xx 才推进上游游标，失败会重投批次；重投由 Durable 去重。出站是 **至少一次** 投递语义。对话绑定、回复游标、待发消息与重试信息写在 SQLite 中；重启不会凭空失去待发消息。

不通过微信暴露任意命令执行入口。只有已有 Agent 工具能被调用；强制使用白名单，保护密钥、SQLite 与微信 session volume。生产环境必须使用 HTTPS + Basic Auth 保护网页。强烈建议先用测试微信账号验证 iLink 登录及稳定性，不承诺所有账号均能使用该服务。

## 5. 从微信回复 Teams

Teams 发送需要后端启用发送口：`TEAMS_CONFIG_DIR` 指向包含 `teams-forward-config.json` 的目录，配置有效 account 或 ginaHome；离线模式不会发送。Teams 采集不依赖微信，微信转发另需启用微信通道及独立桥接服务。

- `回复 Haibo Sun：好的，周五前给你。`：姓名唯一且草稿与原文完全一致时，直接发送，不额外确认。
- 请助手拟稿或通过引用上下文推断目标：先展示 `草稿 N`、完整目标标签和全文。目标已明确且只有一份待发草稿时，`发吧` 即可；推断目标使用 `确认发送 Haibo Sun`，多份或同名目标使用 `确认发送 草稿 N`。复制成 `「确认发送 Haibo Sun」` 也支持。
- 确认只针对确认前已展示的具体版本。改变目标或正文需重新展示；同一聊天新版替代旧版，已发送或过期的新版不会让旧版重新变为待发。
- 草稿有效期仍为 30 分钟。升级前没有授权来源记录的旧草稿需重新起草。发送工具为不可自动重放，发送前原子占用；这不代表外部网络发送有端到端 exactly-once 保证。

当前微信桥接仅把 `ref_msg` 的标题和内容拼成 `[引用：…]`，未提供被引用消息的稳定 ID。引用摘要仅供理解上下文，不作为发送授权或确定收件人的依据；需要用户单独回复带姓名/草稿编号的确认，不反复要求同一次确认。可靠的微信引用消息 ID → Teams 聊天/消息 ID 关联尚未实现。

## 6. Teams 已回复状态与过时提醒

Teams 的「已回复」按聊天时间线计算：同一聊天里第一条晚于来信的本人消息会标记此前来信。它不等于工作事项已完成，群聊中尤其如此。入库顺序不影响结果；应用打开时也会用已有发出记录修复旧标记。通过本应用发送成功后，使用 Graph 返回的真实 ID 和时间保存回执；远端已接受但本地回执保存失败时，只等待同步补录，不放开草稿重发。

后端定时轮询、`teams_messages` 查询和自动提醒投递共用一个采集器。聊天及消息列表沿 `nextLink` 分页，某聊天所需页面失败时不推进该聊天水位。既有聊天在启动后首次同步会回看水位前 24 小时，并覆盖更早的本地未回复来信；后续保留 5 分钟重叠，按消息 ID 去重。新发现的聊天仍从本次启动时间开始，不回灌全部历史。查询先刷新并显示最后完整成功的同步时间；刷新失败时明确标为缓存。桌面退出不影响采集。

自动提醒走内部带来源的注入入口，把 Teams 消息 ID 绑定到 Durable 输入和最终回答，再写入 Outbox。公网入站 Webhook 不能通过自带 `source` 字段获得这一身份。这是内部投递来源记录，不是微信引用协议的稳定消息 ID，因此不改变第 5 节的引用授权限制。

- 首次发送和每次重试前都检查来源。已回复、超过 24 小时提醒窗口或已移出保留范围的来源不再投递；全部失效时持久记录 `cancelled`、时间和原因。
- 本地仍未回复时必须先成功同步；同步不可用则暂缓提醒。一个摘要混合多条来源而只有部分仍有效时，重新整理有效来源原文，不保留旧摘要中的失效建议。
- 普通用户问答不自动撤销；同轮回答混有普通用户输入时，也不把整个回答当成纯自动提醒撤销。微信永久拒收的提醒不会因此自动解封重发，但来源失效后可以撤销。
- 升级时只对能由旧 requestId、输入提交、回答 ID 和 Teams 来源记录共同证明的积压补关联。仅有「未回复」字样不能证明来源；无法关联的旧积压保留，需单独预览处理。不会清空发件箱。

同步检查与真正送达不是跨系统原子操作，检查之后刚发生的回复仍可能与投递交错；已经送达微信的旧消息不会被撤回，也不会重写历史问答。

## 7. 工作状态自动代回

需要的那天在对话里说一句「我今天出差，帮我自动回复找我的人」，助手调用 `set_away_reply` 保存状态和一句安抚语，并把全文展示给你确认。不说的日子不代回，按正常流程走。之后后端轮询到的 **Teams 私聊** 新来信会先代发这句安抚语，再把原文和「已按『出差中』自动代回一句」一起推给你。

- 必须由你本人的原话开启（含「自动回复 / 替我回 / 帮我回」等），模型不能自行开启；第三方消息里的同样要求无效。
- 默认只管当天：到当天结束自动失效，第二天你不再交代状态就按正常流程把消息转给你，不代回。给了明确时长（如「出差三天」）就按时长，也可以随时说「停止自动回复」。
- 只回私聊，群聊不回；同一个人在同一状态期内只代回一次；换状态后可以再代回一次。
- 代回**不算**你已处理：这些来信仍留在「未回复」清单和提醒里，`teams_messages` 的已回复标记会排除代发的安抚语。
- 依赖后端的 Teams 发送口（需要 `ChatMessage.Send`）和微信通道；离线模式或未登录 Teams 时不会代回。代回失败只写入 `teams-forward.log`，不阻塞给你的通知。
- 代回文本是你确认过的固定一句，不由模型按对方消息临时生成，避免对外发出未经你确认的内容。
