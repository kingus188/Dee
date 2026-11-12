# Open Markdown Lane 编辑器接入

共享 `MarkdownEditor` 已切换为 Open Markdown Lane。笔记、记忆、技能、任务说明、日报和 Daylight 备注沿用既有 React props、草稿、保存及冲突检测接口。只读 `MarkdownDocument` 继续使用现有 Tiptap 阅读器；旧 Tiptap 专用测试直接测试原组件，新的共享入口由 Lane 测试覆盖。

## 源码来源与构建

- 仓库：https://github.com/kingus188/open-markdown-lane
- 版本：0.24.4
- 固定提交：`3dd6fe408ab9cbf0d08cd47f9f5a14404bac9eb8`
- 原始 TypeScript 模块、MIT 许可证及本地适配记录：[`apps/web/vendor/open-markdown-lane`](../apps/web/vendor/open-markdown-lane/UPSTREAM.md)
- React 适配器：[`LaneMarkdownEditor.tsx`](../apps/web/src/editor/lane/LaneMarkdownEditor.tsx)
- 构建脚本：[`scripts/build.ts`](../scripts/build.ts)，同时生成浏览器 bundle 和供 Node 测试使用的内核模块。

吸收 RichEditor、Markdown 原文模型、解析、选区、表格、剪贴板、代码块、虚拟化及相关模块，未引入上游 Electron、文件系统、AI、应用外壳或 Vite 构建链。公式复用已有 KaTeX 和离线字体资源。新增依赖固定在 Web 工作区及 pnpm lockfile。

## 接入契约

- 打开或切换源码/文档模式不触发原文重写。富文本修改通过行映射保留未改动行的混合换行符；撤销使用原文快照恢复原始 Markdown。
- 普通段落、CodeMirror 代码块和源码模式均在组合输入结束后发布正文；组合输入期间的外部更新排队，结束后优先应用外部新值。
- 外部替换正文前释放活跃 CodeMirror 视图，避免旧代码块写回新文档。
- 只读状态同时约束正文、任务复选框、表情建议和工具栏。图片读取期间禁用编辑和重复插入，并通过 `onPendingChange` 通知保存方。
- 异步图片插入校验原文、模型、外部值、模式及禁用状态；超限、失败或状态过期时不插入，明确显示错误。
- Office HTML 表格优先于剪贴板附带的图片 fallback。支持纯文本/HTML 粘贴、TSV 表格以及已有图片读取接口。
- Web 渲染过滤脚本、事件属性、内联样式、iframe、桌面文件协议及非 HTTPS 媒体；图片允许 HTTPS 和 PNG/JPEG/GIF/WebP base64 数据。公式关闭 KaTeX trust，Mermaid 使用 strict 安全级别。过滤只影响渲染，不静默改写源文档。
- 后端静态白名单和前端构建均包含 Lane 样式及许可证。

## 验证记录（2026-11-07）

- `npm run check`：通过，7 个工作区、294 个源码模块，无循环依赖。
- `npm test`：在隔离的本地 PostgreSQL 数据库下通过 **939/939**；命令包含完整生产构建。
- 独立只读复核：最终定向测试 41/41 通过，无剩余 Critical/Important 问题。
- 新增回归覆盖原文/混合换行、撤销重做、长文档、只读、富文本与源码组合输入、真实 CodeMirror 组合输入、外部更新、媒体过滤、图片 pending/失败/过期、Office 表格、公式、脚注及插入面板键盘行为。
- Chromium 实际页面：确认加载 `open-markdown-lane` 内核及全部样式；输入中文、嵌套列表、任务、表格、代码、公式与脚注；通过真实键盘修改标题并保存日报，刷新后源码逐项一致；表格 Tab 切格、任务勾选与撤销通过。

验证附件：[全量测试日志](../artifacts/lane-editor-20261107/tests.log)、[类型与边界检查日志](../artifacts/lane-editor-20261107/check.log)、[桌面截图](../artifacts/lane-editor-20261107/desktop.png)、[390px 窄屏截图](../artifacts/lane-editor-20261107/mobile.jpg)。链接面板的 Enter 插入与撤销也通过了真实浏览器操作。

浏览器验证使用独立 API、临时数据目录及临时数据库，未修改现有用户数据；验证后已关闭测试服务并删除临时资源。未验证真实系统输入法、Safari/WebKit 或生产部署；IME 回归使用 JSDOM 的真实编辑器、CodeMirror 事务及键盘事件。代码未提交、推送或发布。
