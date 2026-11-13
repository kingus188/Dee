Teams 自聊 AI 自动回复测试

入口：`TEAMS_SELF_CHAT_ID='48:notes' node scripts/teams-self-chat-test.mjs haifeng.zhang --seed`。先构建项目并设置已有的 `TEAMS_CONFIG_DIR`。

复用已有 `TEAMS_CONFIG_DIR` 内的委托账号；模型使用现有 LLM 环境配置、`LLM_MODELS_FILE` 或本机 Pi 的默认模型，不输出凭据。模型目录在临时目录加载，不更改业务数据库。脚本不加载 .env。

账号必须匹配指定用户名。Teams 原生“与你自己聊天”使用账号范围内的 `48:notes`，不出现在 `/me/chats`，会话详情和成员接口返回 400，但消息接口可读写。本机 Teams 无障碍树中该自聊的 `title-chat-list-item_48:notes` 和 `message-preview-chat-list-item_48:notes` 已确认目标；Graph 最近十条消息均来自当前账号，`chatId` 均为 `48:notes`。脚本对这一精确目标直接读取消息，并在发送前检查历史目标与发送人；其余目标仍要求只有当前账号一个成员的 oneOnOne，多候选时必须显式指定目标，不按成员数量猜测。

`--seed` 发送一条合成问题，接收模型回答并回读核验后退出。不带该参数时，仅处理启动之后的新消息，最多运行两分钟、回复三条。每条回复带 `[Dee AI 测试回复]` 前缀，不触发下一轮。模型无工具权限；不读取其他会话正文。发送前复查原文，发送失败或结果未知立即停止，不自动重发。

以上入口仍是按需运行的有限测试脚本；常驻实现见下方。未新增客户端开关。

2026-11-13 真实验证完成：在 haifeng.zhang 的 `48:notes` 自聊中，09:05:34.756 UTC 发送合成问题（消息 ID `1794560734756`），09:05:40.108 UTC 收到模型回答并发送为测试回复（消息 ID `1794560740108`），脚本按 ID 回读与后续列表回读均确认正文一致。回复为：「[Dee AI 测试回复] 我可以帮你归纳工作消息、提取待办事项和截止时间，并按优先级整理成清晰的清单。」仅发送这两条测试消息；脚本完成一次回复后退出，没有开启常驻自动回复，也未向其他会话发送。

本次 `node --check scripts/teams-self-chat-test.mjs`、`node --test scripts/teams-self-chat-test.test.mjs`（8/8）、`npm run check` 与 `git diff --check` 通过。新增自聊用例先在旧实现上失败，再在修复后通过。重新运行 `npm test` 未通过，数据库相关测试报告缺少 `DATABASE_URL`；未改数据库配置或部署服务。

## 常驻自聊测试（2026-11-13）

核心实现：`apps/server/src/teams-self-chat.ts`；仅访问当前账号 `/me` 和 `48:notes/messages`，生成器无工具权限，回复始终带 `[Dee AI 测试回复]` 前缀。首次成功读取建立历史基线，之后处理新短文本；不处理附件、截图、超过 8000 字符的原始正文和超过一天的消息。消息文本沿用现有 Teams 提取器（最多 2000 字符），每次仅把这一条新消息交给模型，不带历史上下文。

每条消息在模型调用前以源 ID 原子占用，发送前写入 `sending`，回读一致后写入 `sent`；源 ID 和回复 ID 均去重。模型失败或发送前原文变化会记为 `failed`，不自动重试该条。发送开始后失败记为 `unknown`，或中断留下 `sending`，均暂停整个自聊发送，必须人工核实；没有自动清除未知状态的接口。状态库只保存账号绑定、起始时间、源 ID、发送状态及回执 ID，不保存正文或凭据。5 秒串行轮询，失败指数退避到 5 分钟，并遵循 Graph Retry-After。

后端已接入 `startServerIntegrations` 生命周期；默认关闭。后端显式设置 `TEAMS_SELF_CHAT_ENABLED=1`、`TEAMS_SELF_CHAT_USERNAME=haifeng.zhang`，并配置已有 Teams 目录和模型才开启，`PI_OFFLINE=1` 强制关闭。状态库位于后端 `DATA_DIR/teams-self-chat.sqlite`。不改变原有离开回复、其他私聊、群聊或微信转发。

当前实际运行在本机独立 launchd 测试服务中，复用同一核心实现和已验证的 Teams/Pi 模型配置，不依赖后端 PostgreSQL，也不启动其他 Teams 集成：

- 服务：`com.dee.teams-self-chat`，入口 `scripts/teams-self-chat-service.mjs`。
- LaunchAgent：`~/Library/LaunchAgents/com.dee.teams-self-chat.plist`，登录自动启动，退出后自动恢复；Mac 需要在线且账号保持登录。不是系统级开机服务。
- 私有状态和日志：`~/Library/Application Support/Dee/teams-self-chat/`，目录 0700、数据库 0600。账号与模型凭据仍从既有私有配置加载，不写入 plist。
- 停止：`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.dee.teams-self-chat.plist`。
- 重新启用：`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dee.teams-self-chat.plist`。
- 查询：`launchctl list com.dee.teams-self-chat`。不要在另一数据目录同时开启后端自聊，否则两套独立状态不能相互去重；切换宿主须先停本机服务并保留该状态库。

真实常驻验收：09:21:54 UTC 发送测试问题，源 ID `1794561714391`；09:22:09 UTC 常驻服务发送模型回复，ID `1794561729177`，状态为 `sent` 且 Graph 按 ID 回读一致。回复：「[Dee AI 测试回复] 把工作消息按紧急度和截止时间分类，提取每项的任务、负责人和截止日期，整理成可跟踪的待办清单。」随后 SIGTERM 重启，launchd 已拉起新进程；状态保留，同一验收问题后只有一条 AI 回复，没有重发或自回复循环。服务保持运行，等待用户继续在 Teams 自聊发消息。

本轮验证：`npm run check`、脚本语法检查、相关 21 项测试、`git diff --check` 均通过。`npm test` 实际结果：1152 项，1090 通过、60 失败、2 跳过；大量数据库/服务启动失败报告缺少 `DATABASE_URL`，另有日报工具链验证失败，不能视为全量通过。未部署远端后端、未重装桌面客户端、未做多日稳定性或真实关机重启验收。没有提交或推送。
