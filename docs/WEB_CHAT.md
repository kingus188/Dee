# React Web 对话

网页入口是 `apps/web/src/main.tsx`。`ui/App.tsx` 保留现有首页、导航与助手形象；`chat/ChatThread.tsx` 使用 Gina 的 UserMessageBubble、TurnCard、ResponseCard 结构，把用户消息、可折叠工具过程和回复分别呈现。`chat/Composer.tsx` 负责输入、中文 IME、附件与停止。任务和个人资料卡使用原有的纯数据构建函数，由 React 渲染。

本次参考本机 Gina 源码：

- `apps/webui/src/renderer/components/app-shell/chat-message-bubble.tsx`
- `packages/ui/src/components/chat/TurnCard.tsx`、`ResponseCard.tsx`
- `packages/server-core/src/transport/client.ts`

这是按本项目协议移植的对话实现，未引入 Gina 的注释、编辑器、文件预览和多工作区依赖。

## 构建

`pnpm run build` 先执行 TypeScript 检查和编译，再由 esbuild 生成 `apps/web/dist/app.js`。React 与 React DOM 已打包，无 CDN 或浏览器裸 npm 导入。CSS 和现有静态图片继续由后端同源提供。

## 通信

浏览器通过同源 `/api/socket` 建立 WebSocket；HTTPS 页面自动使用 WSS。握手沿用 Basic Auth 和 Origin 校验。JSON 请求使用共享协议类型 `packages/contracts/src/socket.ts`：

```json
{"type":"request","id":"1","method":"POST","path":"/api/conversations/direct","body":{}}
```

响应携带同一 `id`、HTTP 语义的 `status`，以及 `data` 或 `error`。订阅 `GET /api/conversations/:id/events` 后，同一连接推送 `event: "view"` 的完整会话快照。聊天、任务、记忆、技能和知识检索的 JSON 操作均使用这条连接。静态图片与 Markdown 下载继续使用 HTTP。

服务端 `application/api.ts` 是 WebSocket 与原有 HTTP API 共用的用例入口；`application/view-stream.ts` 是 WebSocket 与兼容 SSE 共用的快照订阅实现。现有持久化格式和 Pi Durable 任务语义不变。

## 断线和限制

连接超时 15 秒，请求超时 30 秒；自动重连间隔从 1 秒退避至最多 30 秒。重连后重新订阅当前会话并取得最新持久化快照，不自动重放写请求。发送结果未确认时保留草稿及附件，重试相同消息使用原 `requestId`，由现有提交逻辑去重。

WebSocket 帧上限 14 MiB，兼容单次最多 10 MiB 附件的 Base64 消息。非聊天请求仍限制 100,000 字节。每条连接最多并行处理 16 个请求，有心跳、慢客户端保护和关闭时的订阅清理。

反向代理需转发 `Upgrade`、`Connection`、`Host` 和 `Authorization`，示例见 [部署文档](DEPLOYMENT.md)。未配置 WebSocket 转发时，HTTP 健康接口可用也不能说明网页对话可用。

## 本次文件清单

React 页面与对话：新增 `apps/web/src/main.tsx`、`ui/App.tsx`、`ui/Welcome.tsx`、`ui/Icon.tsx`、`chat/ChatThread.tsx`、`chat/Composer.tsx`、`chat/turns.ts`、`chat/useConversation.ts` 和 `tasks/CardPanel.tsx`。调整 `chat/attachments.ts`、`chat/cards.ts`、`chat/live.ts`、`tasks/layout.ts`、`ui/elements.ts` 和 `ui/mascot.ts`，复用附件处理、卡片数据和助手状态。

通信：新增 `apps/web/src/api/socket.ts`、`apps/server/src/http/socket.ts`、`apps/server/src/application/api.ts`、`apps/server/src/application/view-stream.ts`、`packages/contracts/src/socket.ts`。调整网页 `api/chat.ts`、`api/request.ts`、`api/server.ts`，服务端 `http/events.ts`、`http/router.ts`、`http/server.ts`、`http/static.ts`、`lifecycle.ts`，以及协议包 `src/index.ts`。

桌面兼容：调整 `apps/desktop/src/main.ts`、`src/policy.ts`、`tests/policy.test.ts` 的 WebSocket 凭据和 CSP 范围；保留已有桌面图标工作。

构建与资源：调整 `package.json`、`apps/server/package.json`、`apps/web/package.json`、`pnpm-lock.yaml`、`apps/web/tsconfig.json`、`apps/web/tsconfig.test.json`、`scripts/build.ts`、`scripts/check-boundaries.ts`、`apps/web/public/index.html`。新增 `apps/web/public/chat.css`，保留已有首页样式和图片。

测试：调整 `apps/web/tests/build.test.ts`、`cards.test.ts`；将 `direct-chat.test.ts` 迁至 `direct-chat.test.tsx`，覆盖旧导航测试和卡片竞态测试；新增 `apps/web/tests/dom.ts`、`socket.test.ts` 及 `apps/server/tests/socket.test.ts`。

删除被替代的实现：`apps/web/src/main.ts`、`state.ts`、`api/events.ts`、`conversations/controller.ts`、`chat/composer.ts`、`chat/messages.ts`、`chat/tool-cards.ts`、`tasks/center.ts`、`ui/render.ts`、`ui/status.ts`、`ui/workspace.ts`，以及已被 React 测试覆盖的 `apps/web/tests/workspace.test.ts`。原服务端 `http/routes/conversations.ts`、`personal.ts` 和 `tasks.ts` 的逻辑集中到共用 API 入口。

文档：调整 `README.md`、`README.en.md`、`docs/ARCHITECTURE.md`、`docs/DEPLOYMENT.md`，新增本文件。未修改 `AGENTS.md`、`SPEC.md`、持久化定义及远程服务。

## 对话样式调整（2026-10-13）

本次进一步取用 Gina `UserMessageBubble.tsx`、`ResponseCard.tsx` 和 `index.css` 的实际样式：用户消息采用 16px 圆角、80% 最大宽度及前景色 5% 透明背景；普通回复采用无外框正文与轻量复制按钮。对话页面改为中性背景，原首页保留。

`chat/activities.ts` 将工具调用与结果按 callId 合并，折叠摘要的计数代表实际工具步骤；Pi Durable 1.1.0 的 pending、running、done 状态与成功结果分别处理，不把缺少结果的 done 显示为成功。待办和笔记卡默认收起，展开后仍可查看完整记录并执行原动作。

本轮修改文件：`apps/web/src/chat/ChatThread.tsx`、`apps/web/src/chat/activities.ts`、`apps/web/src/tasks/CardPanel.tsx`、`apps/web/public/chat.css`、`apps/web/tests/direct-chat.test.tsx` 和本文件。未改模型配置、历史记录或后端业务逻辑，未新增依赖。

验证：`npm run check`、全量 `npm test` 57 项通过。Ego 浏览器使用独立界面测试数据，确认回复无背景框、用户气泡尺寸、工具及待办键盘展开、Shift+Enter 换行和 Enter 发送后清空草稿；375px 宽度没有横向溢出且输入区可见。深色模式确认背景和正文分别切换到 Gina 对应的 0.145 / 0.95 OKLCH 明度。

浏览器截图通道两次超时，未取得可信截图，不能据此声明逐像素验收。未验证真实模型语义或打包后的 Electron 窗口；已打包旧应用需要重新打包，源码构建不会更新其内置资源。
