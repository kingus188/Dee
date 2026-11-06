# Teams 个人账号接入发布记录

服务器已更新至 `teams-20261105-01`，本机 `/Applications/Dee.app` 已启动并连接原有服务。客户端的 Teams 工具由后端提供，本次保留已安装的较新原生版本及其后台任务能力，没有用本地较旧源码重打安装包，也没有修改客户端登录配置。

## 发布范围

基于当前线上 `context-20261104-01` 镜像叠加以下 8 个编译文件；保留线上已有上下文处理、后台任务和其他模块：

- `apps/server/dist/application/index.js`：只向现有 Teams 扩展注入在线读取入口。
- `apps/server/dist/integrations.js`：只接入读取器、分开申请文件/频道权限、停机时清理入口。
- `apps/server/dist/teams-auth.js`：只增加读取权限常量。
- `apps/server/dist/teams-reader.js`、`teams-graph.js`、`teams-files.js`：在线历史、分页、搜索及文件读取。
- `packages/features/dist/teams/index.js`、`history.js`：注册新工具并说明缓存边界。

本次未发布工作区其他未提交改动，未迁移数据库，未修改账号、模型或租户授权配置，未提交或推送 Git。发布是在线上已部署基线叠加明确文件，并非声明整个服务器由当前工作区 HEAD 重建。

## 结果与验证

- API 已切换到 `pi-durable-verify-api:teams-20261105-01`，8 个发布文件指纹与候选包一致。
- API 与共享其网络的微信桥一起重建，微信桥绑定新 API 网络已核对；微信状态接口成功，保留 1 个绑定。未发送真实微信消息。
- Web、PostgreSQL、公网网关及 HTTPS 容器的身份与启动时间未变。
- 本地类型及依赖边界检查通过；全量 561 项测试通过。线上基线候选镜像另外通过模块导入、工具注册、离线禁用和分页安全检查。
- 已部署模块通过真实账号验证：聊天工具可用；连续两页消息各 50 条，含正文；一个共享文件成功提取 2357 字符并保留原链接。账号、聊天名称和正文没有写入发布记录。
- 公网未登录首页及 API 仍返回 401，使用既有登录的公网 API 返回 200。
- 已安装 Dee 签名有效，应用持续运行并有 TLS 连接；公网网关观察到 Electron 客户端首页 200 及前端资源成功加载。该证据不是截图验收，也未声称已在模型对话中完成 Teams 问答。

详细机器可读结果见同目录 `release-result.json`。候选清单与文件指纹见 `candidate.json`；发布前编译文件保存在 `baseline/`，候选文件在 `context/overlay/`。

## 仍有的限制

频道权限仍返回 `AADSTS65001`，需要账号/应用管理方完成授权同意。私聊、群聊、会议聊天和文件读取不依赖频道授权。未绕过租户限制。

本次确认在线分页和文件读取可用，不等同于导出了账号全部历史；微软已删除、保留策略已清除或账号无权访问的内容不可恢复。文件类型及大小限制见 [接入说明](../../docs/TEAMS.md)。

## 回滚

服务器发布目录：`/home/zhf/pi-durable-verify-EvtOlEt6/updates/teams-20261105-01`。

该目录保留 `compose.rollback.yaml` 和原镜像标签 `pi-durable-verify-api:before-teams-20261105-01`。回滚时使用 `candidate.json` 中记录的完整 Compose 文件列表，再叠加回滚覆盖文件，重建 `api` 与 `wx-bot` 并核对微信桥网络。不要单独使用历史基础 Compose 文件，不要删除数据卷。

本次无需原生安装包回滚，客户端安装文件和用户数据均保持原样。启动进程时仅移除了当前执行环境继承的 `ELECTRON_RUN_AS_NODE`，使 Dee 以正常桌面模式运行；未更改系统环境或全局设置。
