# Teams 原消息展示交付记录

发布：`teams-records-20261105-02`，2026-11-05。服务器已发布，本机已安装 Dee 已重启并加载新展示脚本。

查询结果按聊天分组，按原消息时间排序，显示发送人、时间及原文；截图和文件归属到各自消息。合并重叠查询页时按聊天和消息标识去重。助手生成的说明可折叠查看，不替代原消息。

旧会话在读取视图时关联归档原文，不重写已保存的会话条目。旧版文字预览按原时间、发送人和预览匹配；只有全部记录能唯一关联到已归档原消息时才恢复，不猜测缺失或歧义记录。新查询直接携带结构化原消息。

## 修改范围

- `packages/features/src/teams/history.ts`、`index.ts`：原消息记录协议、查询输出及旧预览格式复用。
- `apps/server/src/teams-records.ts`：原消息可见文字、附件归属、旧会话视图恢复。
- `apps/server/src/teams-archive-store.ts`、`teams-store.ts`、`teams-read-port.ts`、`teams-reader.ts`：归档记录读取。
- `apps/server/src/application/index.ts`、`views.ts`：查询入口与视图接入。
- `apps/web/src/chat/TeamsRecords.tsx`、`TeamsMedia.tsx`、`ChatThread.tsx`、`apps/web/public/chat.css`：逐消息展示及折叠助手说明。
- 对应服务端、网页、工具测试，`docs/TEAMS.md` 及本目录发布脚本与验证记录。

本地源码含其他任务的既有改动，未提交或推送。当前线上及原生安装包比本地部分代码更新，发布只向实际运行镜像覆盖本次模块和页面增强脚本，保留较新的其他功能、登录信息及安装包。最终覆盖 9 个 API 文件和 2 个 Web 文件，基于前次 `teams-records-20261105-01`。

## 验证

- `npm run check` 通过：7 个工作区、250 个源码模块。
- `npm test` 通过：577 项，0 失败。使用独立临时 PostgreSQL，已清理。
- `git diff --check` 通过。
- 提交前排除桌面启动、日报等无关工作，将暂存内容导出到独立临时目录，再次通过 `npm run check`（249 个源码模块）和 `npm test`；临时数据库及目录已清理。上述 577 项为包含其他既有工作的完整工作区验证结果。
- 最终候选镜像原消息查询、离线归档、旧 JSON 会话与旧文字预览兼容检查通过；网页脚本、样式及 DOM 自检通过。
- 实际截图对应的已有会话：2 次旧查询均恢复，共 100 条原消息和 37 项附件关联；发送人、时间、原文、附件记录逐条匹配服务器归档。实际归档图片 HTTP 200。
- 本机 Dee 重启成功；网关记录确认首页及 `/assets/teams-records-4c29204a50c9.js` 返回 200，39 次原生客户端请求无 HTTP 错误。
- 登录保护保持有效；数据库、网关及 HTTPS 容器保持原身份，微信桥网络关联正确。未改变数据库结构或重写历史会话。

## 限制与回滚

未进行人工界面视觉验收，未宣称账号全部历史已同步完成。后台归档继续补齐；原文和已获取截图保存到服务器数据库，普通文件仍保存名称和原链接，未复制全部文件原件。频道授权同意问题仍存在。缺失来源的旧预览无法可靠恢复时保留原展示。

服务器发布目录：`/home/zhf/pi-durable-verify-EvtOlEt6/updates/teams-records-20261105-02`。

回滚覆盖文件：该目录下 `compose.rollback.yaml`，恢复本次发布前的 API/Web 镜像；恢复 API 时须同时重建共享网络的 `wx-bot` 并重新加载网关。归档数据库保留。

`verification.json` 为脱敏验证结果；`verify.mjs` 仅在服务器现有进程配置内使用认证信息，不输出聊天身份、正文或凭据。
