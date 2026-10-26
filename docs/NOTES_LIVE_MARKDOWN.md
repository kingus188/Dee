# 笔记 Markdown 即时编辑纠正与验收

> 本文记录前轮笔记专用实现。当前全入口编辑器及真实发布验收参见 [全入口 Tiptap 文档编辑](TIPTAP_UNIFIED_EDITOR.md)。

日期：2026-10-23。此次对应“没有实现 Typora 一样的 Markdown 编辑”的纠正要求。此前的目录、纸面排版和富文本/源码切换属于布局与展示交付；本次补上正文直接输入 Markdown、光标返回语法标记继续修改的编辑行为。

## 已实现的操作

进入笔记并点击“编辑笔记”，即可在正文直接键入 Markdown：

- `#` 至 `######` 标题在当前位置排版；光标回到该行时显示原始标记，可将 `#` 直接改成 `##`。
- `**粗体**`、`*斜体*`、`~~删除线~~`、行内代码和链接文字按语法呈现；当前行保留可编辑标记。
- 无序列表、有序列表、任务清单和引用支持 Enter 延续，空标记再次 Enter 退出。
- 反引号或波浪围栏中的代码保持原文及缩进；光标进入代码块时显示围栏，离开后呈现代码正文。
- 保留撤销、重做、中文组合输入、纯文本粘贴、原文复制和剪切、`Cmd/Ctrl+S` 保存以及大纲定位。
- “Markdown 源码”是主动选择的另一种视图；打开包含原始 HTML、CRLF、CR 或尾随空格的文档时，默认仍提供正文即时编辑。

这是面向当前笔记功能的行级即时编辑器。复杂表格、数学公式、图表、Setext 标题、跨行行内语法及引用式链接等继续保留原文显示；没有声明完整复刻 Typora 或完整 CommonMark。

## 实现方式与原文保护

仅 `MarkdownEditor` 的 `document` 变体采用新编辑器；日报、记忆和远程技能记录沿用原有富文本转换及保护规则。复用已安装的 `@tiptap/pm`，没有新增依赖。

编辑模型为纯文本行节点，每行单独保存原始换行符。视觉格式与标记隐藏通过 ProseMirror decorations 实现，格式呈现本身不改写文本。输入、光标移动、切换视图与复制均围绕同一份 Markdown 原文。

审查复现并修复了四个边界：跨行原生文本替换继承错误的行尾；源码文本框编辑改写未触及的换行；空选区剪切清除重做；整段替换命令把无关修改合并进同一次撤销。新增回归覆盖实际 ProseMirror 事务及受控 React 文本框事件，而非只验证字符串解析。

笔记仍使用原有会话归属、`{ notes, base }` 完整快照比较与交换；保存只替换目标笔记，冲突保留草稿。页面隐藏保持挂载，默认打开或切换视图没有保存副作用。

## 修改文件

- `apps/web/src/editor/LiveMarkdownEditor.tsx`：文档编辑视图、原文剪贴板、中文输入、源码视图与历史保留。
- `apps/web/src/editor/live-markdown-model.ts`：原文行模型、UTF-16 坐标映射、换行保护及事务边界。
- `apps/web/src/editor/live-markdown-commands.ts`：Enter、跨行删除、原文格式命令与快捷键。
- `apps/web/src/editor/live-markdown-decorations.ts`：当前行/代码块、格式装饰、标记显示。
- `apps/web/src/editor/live-markdown-syntax.ts`：有界行级语法分析与范围计算。
- `apps/web/src/editor/live-markdown-source-input.ts`：把源码文本框的实际编辑范围映射回原始换行。
- `apps/web/src/editor/MarkdownEditor.tsx`：按文档变体接入新编辑器。
- `apps/web/src/workspace/NotesPage.tsx`：大纲定位即时编辑行。
- `apps/web/public/notes.css`：即时编辑的笔记专用样式。
- `apps/web/tests/live-markdown-editor.test.tsx`、`live-markdown-model.test.ts`、`live-markdown-source-input.test.ts`、`live-markdown-syntax.test.ts`：新增行为回归。
- `apps/web/tests/notes-document.test.tsx`：更新文档默认即时编辑的预期，保留原保存与草稿回归。
- `README.md` 与本文：实际功能和验证记录。

## 验证结果

- `npm run check`：7 个工作区、204 个源码模块，类型与依赖边界通过。
- 本次五个定向测试文件：33/33 通过，包含语法、坐标、混合换行、原生事务、源码编辑、历史、文档保存及冲突。
- `npm test` 已执行。一次运行有原有 Teams 时钟相关测试波动；该文件随后独立 6/6 通过，同一构建的完整重跑为 399 项、350 项通过、49 项失败。剩余 49 项均在缺少 PostgreSQL `DATABASE_URL` 的初始化阶段失败，未宣称完整数据库测试通过，也未修改 Teams 代码。
- 实际构建的浏览器验证：直接键入标题、行内格式、列表、引用和代码围栏；回到标题修改标记；撤销/重做；中文组合输入；WebSocket 快捷保存。强制重新加载构建后再次验证跨行替换、空剪切保留重做、切视图保留历史及混合换行保存。
- 正式客户端验证：通过真实文字输入和 Enter 生成九行 Markdown；实际点击标题显示标记，再键入 `#` 将 H1 改成 H2；中文组合输入与 `Cmd+S` 保存后，服务端字符串和实际键入的完整 Markdown 逐字一致。
- 原生自动化首轮发生前台窗口与键盘焦点问题，失败轮次没有当作验收成功；恢复并核对实际原生窗口后，上述客户端操作才通过。

复现定向测试：

```sh
node --experimental-vm-modules --test apps/web/dist-tests/live-markdown-*.test.js apps/web/dist-tests/notes-document.test.js
```

## 真实部署与数据核对

实际服务：`https://192.168.31.5:3443`。本次只更新 Web，未改变桌面原生代码或重启 API、PostgreSQL、微信及 HTTPS 代理。

- Web 镜像：`pi-durable-verify-web:notes-live-20261023-01`。
- 容器：`d12c2124c194a31068c06b7ae0687f08b58de88a18867ebaa6f1b686855c6b45`，启动于 `2026-10-23T06:45:07.530681522Z`。
- 260 个远端 Web 资源与本地构建逐一匹配 SHA-256，运行用户可读。
- `app.js` SHA-256：`23e189cdd980c981ae417e5945aa2c6e387e5f3bb33c4915fff870cdd88b9a08`。
- `notes.css` SHA-256：`671c450f80740917c79b49b244e1f54b00c81b49d246aa22a3c50051cd32834d`。
- 其他四个容器的 ID、启动时间和镜像均与部署前一致。
- 唯一临时笔记保存后已用新鲜 `base` 清理，笔记数量 `0 → 0`，完整快照 SHA-256 恢复为 `c31b19e7039997b04cf17c39aee8144013dd0b0546f5806ec4d521e52d7a5e90`。
- Daylight 仍为 7 个项目、22 条待办，完整快照 SHA-256 保持 `50444b916b564fb94a7e29d220dd6ac2f40649c6638d60f8c68fdaac5660285d`。

现场原生编辑截图、浏览器记录、测试日志、资源清单与原生验收记录位于 `/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-markdown-live-biqymkfa`。截图中的笔记是已经清理的唯一临时验收文档。

最终普通启动为 PID `71804`，命令为正式安装应用的可执行文件且没有诊断参数，原生窗口显示“已连接”，9231 端口已关闭；连接配置散列保持一致，严格签名校验通过。375 像素宽度下已核对正文即时编辑，页面滚动宽度 375、编辑区宽度 327，没有横向溢出，也没有退回源码文本框。

旧 Web 镜像 `pi-durable-verify-web:notes-typora-20261023-01` 保留，可将本次 Web override 的 image 指回旧镜像并仅重建 Web 回退。
