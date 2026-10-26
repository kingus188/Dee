# Typora 参考笔记工作区：实现与验收

> 后续纠正：本文记录最初的布局与富文本方案。正文直接输入 Markdown、当前行标记回显及原文保存的实现与真实验收，见 [笔记 Markdown 即时编辑纠正](NOTES_LIVE_MARKDOWN.md)。

日期：2026-10-23。目标：把笔记从逐页切换的列表、详情和表单，调整为连续的文档工作区，保留会话归属、Markdown 原文、版本冲突和草稿保护。

## 参考证据

本机参考版本为 Typora 1.13.8（7712），bundle ID `abnerworks.Typora`。使用 REA 6.4.0 分析其 TypeMark JavaScript 资源，并在 Typora 中打开本次创建的临时示例文档，观察文件侧栏、正文留白和工具栏。操作没有修改用户原有文档。

- 静态分析 Evidence：`ev_7bc2229ad3db74741db0a3bacea4a14e2c9f388447e70ab24025bbf201ab9bc8`。
- 摘要 Evidence：`ev_238ef4a40e8a90701177020293553105b9ce6c03221ac4ae03836519ace31e0b`。
- 聚焦目录 SHA256：`13b60cee4e04582bc9bdf9b7da0c7d66caba2c1bc4dccd873138f0d55e386d6d`。
- 解析 2 个 JavaScript 文件、1,660,764 字节，访问 479,594 个 AST 节点，0 个解析失败。应用和语义覆盖均为 partial，主脚本的语义图受到资源预算限制；没有进行完整原生程序恢复。
- 随包 GitHub 主题提供了正文 `16px`、行高 `1.6`、居中限制行宽、侧栏弱对比等静态排版参考。这些是主题定义，不能据此认定为用户当前主题设置。

复用了文档布局、内容优先与导航连续性的思路。大纲由项目已有 Markdown 渲染链生成，未复制 Typora 的编辑器、素材或源码。没有把未确认的 Typora 大纲快捷键操作计为成功观察。

## 已实现体验

- 左侧笔记列表与文档大纲可切换；列表搜索包含正文，切换文档时目录保持存在。
- 正文使用限制行宽的纸面排版、分级标题、较充足的段落间距；支持收起目录和专注阅读。
- 默认打开只读文档，点击“编辑笔记”后在相同位置编辑。格式按钮收进菜单；支持 `Cmd+S` / `Ctrl+S`。
- 大纲保留 H1–H6 原级别，排除代码围栏里的伪标题；可定位阅读、富文本或源码中的对应段落。
- 底部明确显示保存状态、字符数与阅读时间。375 像素宽度下目录和文档可以切换，没有横向溢出。
- 不支持无损往返的 Markdown 继续使用源码模式；阅读、进入编辑或切换显示方式都不会自动保存、改写正文。

笔记仍归当前会话所有。保存沿用 `{ notes, base }` 全快照比较；没有新增笔记业务 requestId。切页保持挂载，冲突和失败保留草稿及原始 base，保存使用同步 pending 防重复。每篇 16,000 字符、总计 128,000 字符与 1,000 篇的既有约束保留。

## 修改位置

```text
apps/web/src/workspace/NotesPage.tsx
apps/web/src/workspace/notes/useNotesDocument.ts
apps/web/src/editor/MarkdownEditor.tsx
apps/web/src/chat/markdown.ts
apps/web/public/notes.css
apps/web/public/index.html
scripts/build.ts
apps/server/src/http/socket.ts
apps/web/tests/notes-document.test.tsx
apps/web/tests/workspace-browsing.test.tsx
apps/web/tests/workspace-editing.test.tsx
apps/server/tests/notes-socket-limit.test.ts
```

文档标题渲染独立于聊天标题层级；共享编辑器的 document 变体集中处理笔记样式和工具栏，其他内容页继续使用原模式。未新增依赖，未修改包清单、SPEC 或 AGENTS，未执行提交或推送。

## 长文档传输修复

实际 WebSocket 测试先复现合法 192,161-byte 笔记请求返回 413。修复只将 `POST` 且 pathname 精确匹配 `/api/conversations/<数字ID>/notes` 的 JSON 整帧上限提高到 2,000,000 bytes，与现有 HTTP 容量一致。

普通请求仍为 100,000 bytes；相似路径、GET、无效 ID、后缀与子路径未放大。原有 messages、Daylight save 例外、鉴权、schema、并发和底层 WebSocket 上限保持原实现。超限返回 413 后连接可继续使用。

## 本地验证

- `npm run check`：7 个工作区、198 个模块，类型与依赖边界通过。
- `npm test`：373 项，324 通过、49 失败。49 项均因缺少 PostgreSQL `DATABASE_URL` 停在初始化阶段；没有将它们记为通过。
- 聚焦运行文档、旧笔记保存、浏览行为与真实 WebSocket 容量边界：37/37 通过。
- 新增 7 条文档行为测试，包括多笔记精确替换、兄弟正文及 CRLF/尾空格保留、搜索/大纲、快捷键/IME/防重复、冲突及 active 切换、无损显示切换和真实 contenteditable 粘贴保存。
- WebSocket 真实连接测试共 20 项，覆盖 2M/+1、100K/+1、精确路由、旧例外与非法消息。
- 浏览器以真实构建产物及隔离 API/WebSocket 验证桌面、375px 列表与文档、正文直接输入及 Ctrl+S。固定数据测试与真实服务验收分开记录。

## 真实部署与客户端验收

真实端点为 `https://192.168.31.5:3443`。Web 镜像 `pi-durable-verify-web:notes-typora-20261023-01`；API 镜像 `pi-durable-verify-api:notes-typora-20261023-01`。

- Web 的 242 个文件 SHA256 与本地构建逐一一致。
- API 仅替换编译后的 WebSocket 模块及对应 source map；模块 SHA256 为 `c976b0572a16c8bc578cc13eb8fb29efd9b8f4c437ecacdff5f5f9eb775fbdf6`。
- API 容器 `83b9efbc4024bc85a0536622de38c9423abfb6761398760ecf0e199ee4126b05`；Web 容器 `82177f832f49f98226662f9309b2bd2f33a41161391f26f81345cfe1b2c77d8c`。数据库、微信和 HTTPS 容器的 ID、启动时间均未变化；持久卷保留。
- 正式安装应用中的实际渲染器已验证只读纸面、大纲及 H1/H2 原层级；在富文本正文直接输入，使用 Cmd+S，经真实 WebSocket 保存成功。
- 144,127-byte 的笔记测试体携带故意不匹配的 base，已进入 API 并返回预期 409，证明真实服务接受超过旧上限的笔记帧；该长文请求没有写入数据。
- 唯一临时验收笔记已按身份和版本比较删除。会话 138 的笔记由 0 篇恢复到 0 篇，完整快照 SHA256 前后均为 `c31b19e7039997b04cf17c39aee8144013dd0b0546f5806ec4d521e52d7a5e90`。
- Daylight 的 7 个项目、22 条待办保持，完整快照 SHA256 前后均为 `50444b916b564fb94a7e29d220dd6ac2f40649c6638d60f8c68fdaac5660285d`。

当前验收已恢复普通系统启动。最终进程为 PID 18848，命令只有正式安装的可执行文件，没有诊断参数；现场窗口显示“已连接”。9231 临时诊断端口关闭，严格签名通过，原有连接配置散列保持一致。笔记阅读、编辑及保存的验收使用了上文记录的正式客户端实际渲染器。

连接排查中曾观察到 `net::ERR_CERT_AUTHORITY_INVALID`；公开证书的指纹、主机名、有效期与原固定配置全部匹配，既有信任函数返回 true。系统入口的诊断启动随后连接并完成上述验收，未调整证书或关闭校验。该现象的根因尚未确认，不列为本次已修复事项。

旧 Web/API 镜像保留。回滚时去掉本次 notes Compose override，使用既有 local-skills Web 与 today API 镜像执行 `up -d --no-deps --no-build api web`；不删除持久卷。

## 证据目录

```text
/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-notes-typora-wruk96ii/
```

包含完整 REA Evidence、静态源哈希、测试日志、桌面/窄屏截图、真实窗口截图、逐资源部署哈希及不含凭据的验收摘要。真实窗口截图中的文档是已清理的临时验收内容。
