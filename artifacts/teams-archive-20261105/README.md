# Teams 附件、截图与服务器长期归档

已发布 `teams-archive-20261105-01`，Dee 客户端已重新加载。聊天原文、附件记录和已获取的截图保存在服务器数据库；查询结果中的附件和截图独立于助手的文字摘要展示。

## 根因与修复

原聊天的抽样 137 条消息中，14 条含图片、11 条带附件。此前提醒缓存只保留文字预览，在线历史也没有保存到可持续查询的归档；截图需要带授权读取微软托管内容，不能把微软图片地址直接交给网页加载。回复界面原先只呈现文字摘要。

本次新增服务器长期归档，消息及文件关系按原聊天和原消息关联，完整保留正文、原始结构、发送人、时间和附件记录；截图通过本人账号读取并以二进制保存在同一数据库。前端使用带登录保护的本站图片地址，不暴露微软令牌，也不依赖模型在摘要中主动列出图片。

附件名称、原链接及保存状态进入数据库。普通共享文件仍通过 Microsoft 365 原链接打开，使用已有文件工具读取其正文；本次没有声称所有共享文件原件均已复制到服务器。无链接的卡片附件、超限或权限失败的媒体明确保留不可用/失败状态。

## 持久化与同步

数据库为现有服务器数据卷中的 `/data/agent.sqlite`，新增 `teams_archive_chats`、`teams_archive_messages`、`teams_archive_media`、`teams_archive_meta` 表。归档原文与已保存截图不按 90 天自动删除；既有提醒缓存保持原用途，不用历史回填触发旧消息提醒。

历史按聊天、按页补同步，已入库页才推进游标。同步器与微信提醒分开调度，每轮最多处理 20 个聊天页，记录失败与后续重试时间。完成历史基线后按修改时间增量读取，跨页保留原扫描下界。服务器重启继续已有进度，不重新生成整个归档。

Dee 新增 `teams_archive`、`teams_archive_status`、`teams_media_read`，可检索服务器原文、查看补同步进度和读取已保存截图。离线时仍可查询归档和已保存图片。账号发生变化时停止混入其他账号数据，不自动清空原归档。

全量历史补同步在后台继续；当前已保存数量与失败状态以工具或数据库实际查询为准，不能将发布成功当作所有历史均已补齐。

## 修改范围

- `apps/server/src/teams-archive-store.ts`：消息、聊天进度、媒体二进制和搜索。
- `apps/server/src/teams-archive-sync.ts`：历史补同步及增量进度。
- `apps/server/src/teams-media.ts`、`teams-download.ts`：截图获取、大小及类型校验、数据库图片读取。
- `apps/server/src/teams-reader.ts`、`teams-read-port.ts`：在线读取入库、归档及离线查询。
- `apps/server/src/teams-store.ts`、`teams-sync.ts`：接入归档，预览不再完全遗漏附件与截图标记。
- `apps/server/src/teams-auth.ts`、`integrations.ts`、`application/index.ts`：合并并发登录、独立后台调度及应用工具注入。
- `apps/server/src/teams-files.ts`：复用受限下载实现，保持现有文件解析能力。
- `apps/server/src/http/router.ts`：受既有登录保护的数据库媒体接口。
- `packages/features/src/teams/history.ts`、`index.ts`：归档工具、媒体列表和未完成状态。
- `apps/web/src/chat/TeamsMedia.tsx`、`ChatThread.tsx`：附件与图片独立呈现，复用现有附件样式。
- `apps/server/tests/teams-archive.test.ts`、`apps/web/tests/teams-media.test.tsx`、`tests/integration/teams-media-http.test.ts`：持久化、恢复、截图失败、安全展示及 HTTP 鉴权验证。

线上当前版本比本地工作区更新，发布基于现有 API/Web 镜像加入 16 个后端编译文件和 2 个网页资源，保留线上其他功能。应用入口、存储与路由采用精确插入；附件展示补充模块复用本次前端组件的解析逻辑，并在既有工具结果区域呈现附件。后续完整前端构建由 React 组件直接负责，避免重复展示。

## 验证与回滚

- `npm run check` 通过，248 个源码模块依赖边界无循环。
- `npm test` 全部 571 项通过，使用独立临时 PostgreSQL，测试后已清理。
- 候选镜像通过数据库归档、离线工具、模块导入及附件资源 HTTP 加载检查。
- 精确的前端补充资源通过 DOM 自检；Dee 刷新后，网关确认客户端首页与新增附件脚本均返回 200，没有 HTTP 错误。
- 真实账号已成功读取 PNG，验证新归档链路保存图片并读回；发布后的数据库与受保护公网图片接口验证见 `verification.json`。
- 截图对应的私聊已完整读取 16 页，保存 744 条消息、74 张截图、43 条有原链接的附件记录，另保留 16 条无链接的附件/卡片记录。独立重新连接数据库后可离线查询；已保存 PNG 经受保护公网接口返回 200，大小 76749 字节，模型也可读取。
- 验证快照中，全库已保存 2260 条消息、190 张截图，已发现 78 个聊天；仍在发现及补同步，其余历史不能表述为全部完成。
- 未发送真实 Teams/微信消息，未修改微软授权，未做 Git 提交或推送；未逐张人工核对全部历史媒体，也未把 DOM 与接口验证称为原生界面截图验收。

发布前在服务器创建了 SQLite 在线备份：`/data/teams-backups/teams-archive-20261105-01.sqlite`，文件权限 `0600`，没有下载到本地或放入发布包。

服务器发布目录：`/home/zhf/pi-durable-verify-EvtOlEt6/updates/teams-archive-20261105-01`。保留 `compose.rollback.yaml`、旧 API/Web 镜像标签和发布前指纹。回滚须使用记录的完整 Compose 文件列表，叠加回滚文件并同时重建 API、Web 和共享 API 网络的微信桥；不要恢复旧数据库覆盖新增归档。新表为增量添加，旧版本代码回滚时可保留归档数据。

频道权限仍需微软授权同意，本次未绕过该限制。
