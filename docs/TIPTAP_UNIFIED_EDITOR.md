# 全入口 Tiptap 文档编辑

日期：2026-10-23。按用户明确选择，采用 Tiptap 3.32.0 统一现有八类正文入口，并发布到实际 Web 服务。

## 接入范围

| 入口 | 编辑与保存约定 |
| --- | --- |
| 笔记 | 文档目录、大纲、正文内编辑、快捷保存；保留 `{notes, base}` 整体快照 CAS，只替换选中笔记 |
| 长期记忆 | 使用统一编辑器；仍受 280 字、审批状态、来源与冲突检查约束 |
| 远程技能记录 | 使用统一编辑器；保留名称、描述、4000 字正文及审批流程；从本机技能页的独立入口进入 |
| 提醒 | 使用统一编辑器；保留时间、重试标识与修改调度语义 |
| 计划 | 使用统一编辑器；保留 revision、暂停状态和替换旧调度的语义 |
| 后台任务说明 | 使用统一编辑器；运行中保持只读，原停止操作保持有效 |
| 日报 | 编辑与只读预览使用同一扩展；切换预览保留编辑实例、历史和草稿；保留日期与 revision CAS |
| Daylight 备注 | 通过薄包装接入统一编辑器；保留文件解码、2 MiB 单图与 8 MiB 正文限制，以及异步图片处理期间的保存/关闭锁 |

本机技能文件详情、聊天渲染和聊天输入没有被转换为可写的业务文档。

## 文档编辑能力

- 标题、粗体、斜体、删除线、引用、链接、有序/无序嵌套列表及任务清单支持直接键入 Markdown 和结构化编辑。
- 表格支持单元格输入、Tab 移动，以及工具菜单中的行列操作。
- 代码围栏支持语言设置和 lowlight 高亮；行内与块级公式使用本地 KaTeX。
- 图片支持属性编辑。Daylight 支持本地文件选择、粘贴和拖入，异步成功前不写回，失败或取消保留原文。
- 脚注按引用顺序编号，支持定位、查看与编辑定义。
- 当前块可进入原位 Markdown 语法编辑，完成后回到文档；也可切换全文源码。
- 中文组合输入、撤销/重做、只读状态、选区及快捷保存均有实际交互回归。
- 工具栏改为紧凑图标与菜单；旧的大段按钮、说明条及黑色焦点框已移除。

扩展采用同版本官方 TableKit、TaskList/TaskItem、Mathematics、CodeBlockLowlight，另声明 KaTeX 0.16.22、lowlight 3.3.0。公式样式和字体随 Web 包本地发布。

## 原文与历史

打开、阅读和切换模式不触发写回。原文账本根据 ProseMirror 事务映射和官方 lexer 的 `token.raw` 识别顶层块；未改变的块、块间空白、CRLF、尾空格及定义间隙保持原文。发生结构修改的块按 Markdown 序列化；修改过的表格等整个块可能采用规范化写法。

源码与原位块编辑使用独立的精确源码事务，保留空白修改；撤销可以回到最初原文。普通富文本输入不再修改文档修订属性，避免干扰 Tiptap 的两阶段输入规则。切换来源文档会重置历史，避免撤销进入其它文档。

原文范围测试包含 800 组常见块配对、Setext 标题与分隔线相邻、混合换行、定义间隙及大 data URI。任务 token 吸收前置换行导致的空行翻倍已经修复。

原始 HTML 和不识别的扩展语法作为可编辑字面内容保留。外部图片默认显示占位，由用户主动加载；图片地址改变后重新确认。原文账本保留初始快照，另缓存最近 32 个快照、约 16 MiB；超出缓存窗口的旧编辑块可能恢复为规范化的等价 Markdown 写法。

## 主要实现

- [统一编辑入口](../apps/web/src/editor/MarkdownEditor.tsx) 与 [只读文档](../apps/web/src/editor/MarkdownDocument.tsx)。
- [Tiptap 组件与适配模块](../apps/web/src/editor/tiptap/)：结构扩展、输入规则、工具栏、块源码、公式/图片属性、脚注、原文账本及 token 范围映射分别组织。
- [Daylight 包装](../apps/web/src/daylight/components/MarkdownEditor.tsx) 与 [任务编辑器](../apps/web/src/daylight/features/tasks/TaskEditor.tsx)：复用同一内核与原有图片 pending 约定。
- [笔记页](../apps/web/src/workspace/NotesPage.tsx)、[个人内容页](../apps/web/src/workspace/PersonalPage.tsx)、[日报](../apps/web/src/daily-reports/DailyReports.tsx) 的正文和预览接入。
- [编辑样式](../apps/web/public/editor.css)、[资源入口](../apps/web/public/index.html)、[构建脚本](../scripts/build.ts) 和 [依赖边界检查](../scripts/check-boundaries.ts)。
- [Web 依赖声明](../apps/web/package.json) 与锁文件更新。先前有限行级编辑引擎及无调用的配套文件已退役。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 7 个工作区、213 个源码模块通过，无循环依赖 |
| 编辑与业务定向测试 | 82/82 通过 |
| `npm test` | 435 项，386 通过，49 项在缺少 PostgreSQL `DATABASE_URL` 的初始化阶段失败 |
| `git diff --check` | 通过 |
| 实际构建浏览器 | 标题、三级列表、任务勾选、表格直接输入/Tab、代码高亮、公式、脚注及 WebSocket 快捷保存通过 |
| 正式客户端 | 同一安装应用中完成结构文档、表格键入、Tab、勾选、中文组合输入、Cmd+S 保存，以及长期记忆页面检查 |
| 本轮 375 px 复验 | 验证浏览器空间已结束并归还用户，按工具明确要求停止，没有重新接管或换工具继续该浏览器任务 |

定向回归命令：

```bash
node --experimental-vm-modules --test \
  apps/web/dist-tests/tiptap-*.test.js \
  apps/web/dist-tests/notes-document.test.js \
  apps/web/dist-tests/workspace-browsing.test.js \
  apps/web/dist-tests/workspace-editing.test.js \
  apps/web/dist-tests/daily-reports.test.js \
  apps/web/dist-tests/personal-browsing.test.js
```

全套测试的 49 项数据库前置失败没有报告为通过；本轮未读取 `.env`、修改数据库配置或迁移业务数据。

## 实际发布与数据保护

实际服务：`https://192.168.31.5:3443`。只替换 Web 容器，镜像为 `pi-durable-verify-web:tiptap-complete-20261023-01`。350 个可读资源的 SHA-256 与本地构建逐一一致。主脚本 SHA-256：`ed3cc30005524bba88212175b87b2b9c2328ad450047da571edc2a04940992bf`。

Web 容器：`d393bbed449d911dd63d1863684edcb5d6d32edd6baa28c501aac71e8a6fb48a`，启动于 `2026-10-23T10:02:48.6229797Z`。API、PostgreSQL、微信和 HTTPS 代理的容器身份及启动时间均与发布前一致。旧镜像和先前 override 保留，可撤去本次 Web override 回滚。

真实客户端只建立一条带唯一标识的临时笔记，用实际输入修改表格并完成 Cmd+S 保存；保存后的 Markdown 与编辑器提供的原文完全一致，其它笔记保持不变。随后使用新鲜 CAS 基准删除该唯一临时笔记。长期记忆仅作未保存预览，截图后清空并取消。

最终完整快照 SHA-256 与验收前相同：

- 会话 138 笔记：`c31b19e7039997b04cf17c39aee8144013dd0b0546f5806ec4d521e52d7a5e90`，0 条恢复为 0 条。
- Daylight：`50444b916b564fb94a7e29d220dd6ac2f40649c6638d60f8c68fdaac5660285d`，仍为 7 个项目、22 条待办。
- 个人内容：`adb13f456821c01071ef65927f7a0f6ec1e684ad9dbbad03fdd1b1506305d9c6`。

验收完成后恢复正式安装应用的无诊断参数启动，诊断端口 9231 已关闭，签名验证和连接配置散列保持一致。本轮有一次系统启动停在钥匙串读取阶段；直接启动同一安装程序后完成了全部实际编辑验收。没有调整钥匙串、证书信任或桌面代码；最后的普通启动连接状态另以实际窗口图像核对。

证据目录：`/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-typora-complete-m9u48b2m`，包含完整测试日志、构建/远端散列、容器身份对照、`installed-tiptap-qa.json`、普通启动记录及实际窗口截图。
