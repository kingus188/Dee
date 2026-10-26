# 本机技能管理

2026-10-23。技能入口改为浏览和管理当前桌面电脑上的 `SKILL.md`，文件是内容的事实源。远程小 D 原有的技能记录保留在独立入口，不迁移或删除已有记录。

## 已应用的设计

- 默认展示名称、用途和来源，可搜索或按目录筛选；点击后读取只读详情，支持在系统文件夹中显示。
- 按真实技能目录去重，同一文件夹经过多个软件的链接出现时合并来源；同名但实际目录不同的技能分别保留。
- 支持添加扫描目录、移除自定义扫描配置、通过系统目录选择器导入一个本地技能包。
- 导入复制至共享 Agents 目录；其他软件是否加载由各软件自身配置决定。远程服务的模型不会因为列表中出现一个本机路径而自动获得该文件。
- 浏览器版本说明本机能力需要更新后的桌面客户端。远程历史记录仍可访问，切回本机页面时保留其中未保存的草稿。

默认扫描目录：

```text
~/.agents/skills
~/.claude/skills
~/.codex/skills
~/.dsh/skills
~/.pi/agent/skills
~/.config/opencode/skills
```

目录可以包含分类层级。扫描发现一个普通 `SKILL.md` 后，将其所在目录作为完整技能包，不再把其附属内容递归视为独立技能。分类目录的符号链接若没有普通 `SKILL.md` 会跳过；可通过“添加目录”明确加入其真实目录。

## 搜索和源码核实

| 实现 | 已核实的行为 | 本项目采用的部分 |
| --- | --- | --- |
| [Agent Skills 规范](https://agentskills.io/specification.md)与[客户端集成指南](https://agentskills.io/client-implementation/adding-skills-support.md) | 文件包含 YAML 元数据和 Markdown；发现时先读取名称、描述、位置，内容按需读取；规范没有规定唯一安装根 | 文件事实源、摘要与正文分开读取、明确目录约定 |
| [Vercel Skills 发现](https://github.com/vercel-labs/skills/blob/a80e4c9d12d607631249d4d7d059f835d4b2f13a/src/skills.ts)与[安装器](https://github.com/vercel-labs/skills/blob/a80e4c9d12d607631249d4d7d059f835d4b2f13a/src/installer.ts) | 仓库发现与已安装列表采用不同扫描策略；共享副本向工具目录链接，失败时复制；名字相同不证明内容相同 | 有界发现、来源信息、真实目录去重；导入只复制显式选中的包 |
| [CC Switch 技能服务](https://github.com/farion1231/cc-switch/blob/79ba7982aa3980b001c0b68efde05505884c1f8b/src-tauri/src/services/skill.rs) | 中心目录和各工具目录独立；启停会创建或移除链接/副本，影响其他软件 | 展示来源与目录；目录存在状态如实展示，不将其包装成跨软件统一启用开关 |
| [Skills Desktop 扫描](https://github.com/laststance/skills-desktop/blob/00b8ba107eee6c37c8eeada11cd74f4a69e2935b/apps/desktop/src/main/services/skillScanner.ts)、[预加载 API](https://github.com/laststance/skills-desktop/blob/00b8ba107eee6c37c8eeada11cd74f4a69e2935b/apps/desktop/src/preload/index.ts)与[路径校验](https://github.com/laststance/skills-desktop/blob/00b8ba107eee6c37c8eeada11cd74f4a69e2935b/apps/desktop/src/main/services/pathValidation.ts) | Electron 原生服务扫描目录，通过窄 IPC 暴露操作；区分损坏和不可读状态 | 本机服务与远程 Web 分工、只读详情、刷新、目录选择；另加窗口、主 frame 和当前服务来源校验 |

以上核实的是固定提交源码及官方文档；没有安装或运行这些第三方管理器。

## 实现位置

- 桌面文件服务：[catalog.ts](../apps/desktop/src/skills/catalog.ts)、[scanner.ts](../apps/desktop/src/skills/scanner.ts)、[metadata.ts](../apps/desktop/src/skills/metadata.ts)、[filesystem.ts](../apps/desktop/src/skills/filesystem.ts)、[state.ts](../apps/desktop/src/skills/state.ts)、[importer.ts](../apps/desktop/src/skills/importer.ts)、[model.ts](../apps/desktop/src/skills/model.ts)。
- 桌面桥：[skills-ipc.ts](../apps/desktop/src/skills-ipc.ts)、[skills-preload.cts](../apps/desktop/src/skills-preload.cts)、[main.ts](../apps/desktop/src/main.ts)。业务窗口继续保持沙箱、上下文隔离和关闭 Node 集成，设置窗口使用原有独立预加载。
- 页面及接线：[LocalSkillsPage.tsx](../apps/web/src/workspace/LocalSkillsPage.tsx)、[useLocalSkills.ts](../apps/web/src/workspace/useLocalSkills.ts)、[WorkspaceData.tsx](../apps/web/src/workspace/WorkspaceData.tsx)、[App.tsx](../apps/web/src/ui/App.tsx)、[WorkspaceNavigation.tsx](../apps/web/src/ui/WorkspaceNavigation.tsx)、[workspace.css](../apps/web/public/workspace.css)。
- 前端协议：[local-skills.ts](../packages/contracts/src/local-skills.ts)与[契约导出](../packages/contracts/src/index.ts)。桌面实现使用结构兼容类型，保持现有包依赖边界。
- 测试：[桌面目录行为](../apps/desktop/tests/local-skills.test.ts)、[IPC 边界](../apps/desktop/tests/local-skills-ipc.test.ts)、[预加载暴露](../apps/desktop/tests/local-skills-preload.test.ts)、[启动兼容](../apps/desktop/tests/startup.test.ts)、[页面行为](../apps/web/tests/local-skills.test.tsx)、[原有内容导航](../apps/web/tests/direct-chat.test.tsx)。

## 文件和调用边界

渲染页面只持有六个明确操作，不获得通用 IPC、任意路径读写或命令执行能力。读取和显示使用已发现的稳定技能 ID；添加目录和导入的路径由主进程系统选择器提供。每次调用核对当前业务窗口、主 frame 和已配置服务的来源，选择器返回时再次核对。

| 项目 | 限制 |
| --- | ---: |
| 元数据摘要 / 正文文件 | 16 KiB / 1 MiB |
| 扫描深度 / 全局条目 | 4 / 10,000 |
| 自定义目录 / 配置文件 | 64 / 64 KiB |
| 导入深度 / 条目 | 16 / 2,000 |
| 导入单文件 / 总大小 | 10 MiB / 50 MiB |

元数据仅提取名称和描述，支持常见标量、引号、折叠/字面块。复杂或重复字段、缺失字段、未支持语法和超限均提供提示，原文件保持原样。无元数据头的普通文档可以按文件夹名称查看；导入要求有效名称和描述。文本读取校验 UTF-8，固定 `SKILL.md` 使用 `O_NOFOLLOW` 与文件身份校验。

导入排除 `.git`、`node_modules`、`.DS_Store`、`.env` 和 `.env.*`；遍历遇到符号链接报错。先复制到隐藏暂存目录，验证完整内容，再独占保留目标目录，最后发布 `SKILL.md` 标记。已有目标包括空目录和链接均报冲突。进程中断可能留下隐藏暂存或没有标记的保留目录；同实例写入串行，跨进程没有配置锁，Node 路径接口也不提供 `openat` 级祖先目录原子保证。

## 验证

- `npm run check`：7 个工作区、197 个源码模块，类型与依赖边界通过。
- `npm test`：最终 346 项，297 项通过；49 项在缺少 PostgreSQL `DATABASE_URL` 的初始化阶段失败。此前一次运行的两条 Teams 断言在最终运行通过，本轮没有修改 Teams 实现。
- 本轮四个核心测试文件单独执行：33 项全部通过，覆盖真实临时目录、链接与身份校验、导入冲突与大小限制、窗口调用边界、选择器取消、只读详情、来源过滤、迟到响应和历史草稿保留。
- 隔离浏览器：1440 像素桌面列表与只读详情，375 像素宽度下页面宽度和文档宽度均为 375；没有默认编辑器或横向溢出。
- 本机只读目录预检：153 项技能，其中 30 项具有多个来源，扫描约 46 毫秒。数量反映验收时的目录内容。
- 正式客户端已安装到 `/Applications/Pi Durable Assistant.app`，严格签名检查通过；安装产物 `app.asar` SHA-256 为 `83ce046dd762d35841396adbdc015153dbddef0db2063828040b3e5fdce0f010`。
- macOS 普通入口冷启动后，实际进程 PID 35037 无诊断参数，窗口显示“已连接”；临时端口 9231 已关闭，原有连接配置校验值保持一致。
- 实际窗口发现 153 项技能，其中 30 项具有多个来源；打开 `accessibility` 后读取本机正文，详情没有编辑器。普通窗口再次核对列表和系统目录选择器：点击“导入本地技能”后原生选择器出现，点击其“取消”按钮后回到 153 项列表，操作恢复可用。现场没有导入或修改用户技能文件。
- 诊断过程中，旧渲染器出现过 `net::ERR_ADDRESS_UNREACHABLE`，同期主机访问服务返回 HTTP 200；普通冷启动后恢复连接。本轮没有据此修改网络实现，也未将一次恢复认定为根因已解决。
- 真实 Web 镜像为 `pi-durable-verify-web:local-skills-20261023-01`；部署的 238 个资源逐文件 SHA-256 与本地一致。Web 容器为 `52a127142e4d79ff441cb77221cb0f0fc9e1473f4bba3b4e04dda417ab6b28ed`，启动于 `2026-10-23T04:24:08.405868551Z`；API、PostgreSQL 和微信容器身份与启动时间保持一致。
- 真实待办数据仍为 7 个项目、22 条待办，完整快照 SHA-256 保持 `50444b916b564fb94a7e29d220dd6ac2f40649c6638d60f8c68fdaac5660285d`。
- [正式客户端实际窗口](</var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-local-skills-q6px_xyn/installed-local-skills-final.png>)为普通启动、选择器取消后留证。

本轮没有新增依赖，没有修改包清单、项目规则或设计规格，没有提交或推送。运行时使用远程服务；本地文件管理由桌面主进程完成。跨平台、第三方软件实际加载新导入技能、在线市场安装以及远程模型执行本机技能不在本轮验证记录内。
