# Today REA 分析与设计复用

分析日期：2026-10-23。目标项目：pi-durable-assistant。

已使用本机 REA 6.4.0 分析 Today 1.22.5（build 2001121）的安装产物，并在项目现有 Today 页面基础上补齐三个交互环节：失败可见性、具体任务入口和导航状态保留。首页、导航及工作区聚合 API 在本次任务开始时已有未提交实现，本次保留并扩展这些内容。

## 证据与边界

安装目标为 `/Applications/Today.app`，bundle id 为 `ai.today.macos.app`。

| 分析对象 | 作用 | 证据 |
| --- | --- | --- |
| `Contents/Resources/app.asar` | Electron 桌面宿主 | REA 完整解析成功；SHA-256 `142203e2fca47dbeac28fa07800abbdc2f32f90b1868e733f0df9c307b61bdca` |
| `Contents/Resources/web-runtimes/manifest.json` | 定位实际产品 Web 运行时 | 默认环境 prod，归档 prod.asar，schemaVersion 2，buildId `WTqJqdAnbEHusksWmRcW6tTgrQMscjxd` |
| `prod.asar.unpacked/apps/web/.next/static/chunks/` | 实际页面逻辑 | 对四个相关 chunk 运行第二次 REA，4 个文件均解析成功，230,877 字节、49,820 个 AST 节点，27 个 findings |

REA Evidence ID：

- 桌面：`ev_0b9b532026d0aacff08d1cf71882c27a7b986433469d578ac844e91211684f18`
- 聚焦前端：`ev_2384c4ea6e924ad41727e05af69670fd48cfa628012b2202767a13e123e3d6f4`
- 前端摘要投影：`ev_6136e03da598b4aa005ccf151afc630520d9f1cba5ee7b510d2d5e3a69dc59e0`

上述为安装产物静态证据。未启动 Today 观察运行行为，未把 mock 数据或文案视作后端行为证明。前端语义图为 partial coverage，其中 `2gjrw3-b5naqc.js` 的语义图超过父结果剩余预算，模块和静态语法事实仍保留。动态 IPC、服务端授权和请求结果未通过本次静态分析验证。

完整 Evidence JSON、聚焦摘录、摘要、测试日志和截图保存在本机临时证据目录：

`/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-today-rea-20261023-ja0dburo`

该目录属于本次本机分析产物，不是应用运行依赖。报告保留版本、散列和命令以便重新取证。

## 值得复用的设计

### 1. 今日视图按注意力组织内容，并保留来源

`2gjrw3-b5naqc.js` 中有 “Today finds the plans that need your attention today in your connected services and conversations.” 的来源说明，相关模块保留事件时间、状态和来源导航。由此提炼的是“摘要指出需要关注的事，并让用户回到具体上下文”的产品原则。

当前项目服务端已将失败排在进行中之后，但首页只保留 pending/running，导致失败被过滤。补齐方式：

- 首页进展按 failed → running → pending 展示，失败项进入前四条摘要。
- 显示失败数量与来源会话入口；接口返回截断列表时，文案明确数量仅统计已读取记录。
- 统一进展新增“执行失败”筛选；失败仍属于“已结束”阶段，筛选和计数共用同一谓词。
- 沿用现有色彩、圆角和卡片体系，仅增加一条失败提示样式。

这属于对项目自身缺口的修复，没有把上述文案扩展解释为 Today 实际使用相同排序算法。

### 2. 卡片转入详情时携带稳定身份，并衔接真实状态

`38qorz0wfnppp.js` 的任务创建路径构建 `{kind:"task",taskId:t.taskId,conversationId:t.conversationId}`；详情查询使用 `getV1TasksByTaskId` 和具体 taskId，缓存 staleTime 为 30,000ms，并从返回详情协调标题、状态和 startedAt。这支持“卡片携带实体身份进入详情”的判断。

项目原来的待办行仅进入统一待办首页。现在点击具体行会：

1. 生成 `#tasks/<encodeURIComponent(taskId)>`，刷新或复制链接仍保留目标身份。
2. 等待 Daylight 数据加载成功，选择任务所属项目，清除阻碍定位的搜索/优先级筛选。
3. 复用现有 TaskEditor 打开对应任务。
4. 已有任务草稿、项目编辑或设置窗口时等待其关闭，避免替换当前编辑内容。
5. 任务已删除或当前快照未找到时显示明确提示。

入口仅影响前端导航。打开任务没有创建、保存或删除数据。URI 解析拒绝空值、超长值、控制字符、坏转义和额外路径，异常时回退到普通待办页面；既有会话路由保持原语义。

### 3. 来源往返保留阅读上下文

在“摘要 → 来源会话 → 返回”路径中，阅读位置、筛选和成功快照应保持连续。保留挂载是根据当前项目 active 生命周期做出的工程选择，没有把它描述为已恢复的 Today 内部实现。

TodayPage、ActivityPage 持续挂载，以 active 控制数据读取。离开页面或文档隐藏时停用相应资源轮询；返回后重新读取，刷新失败仍展示上次成功数据和错误提示。动态筛选、展开结果也能在浏览器返回后保留。

原有 usePageResource 的独立失败处理、旧请求隔离和隐藏页轮询控制已满足要求，继续复用，没有新增缓存层或状态库。

## 本次修改范围

| 文件 | 本次改动 |
| --- | --- |
| [apps/web/src/today/TodaySections.tsx](../apps/web/src/today/TodaySections.tsx) | 具体待办回调、失败优先摘要及截断数量文案 |
| [apps/web/src/today/TodayPage.tsx](../apps/web/src/today/TodayPage.tsx) | 任务入口回调携带可选 taskId |
| [apps/web/src/today/model.ts](../apps/web/src/today/model.ts) | failed 筛选与共享匹配谓词，保留阶段语义 |
| [apps/web/src/today/ActivityPage.tsx](../apps/web/src/today/ActivityPage.tsx) | 筛选和计数使用共享谓词 |
| [apps/web/public/today.css](../apps/web/public/today.css) | 失败提示的局部样式 |
| [apps/web/src/ui/navigation.ts](../apps/web/src/ui/navigation.ts) | taskId 路由编解码和输入校验 |
| [apps/web/src/ui/App.tsx](../apps/web/src/ui/App.tsx) | taskId 传递与 Today/Activity 保留挂载 |
| [apps/web/src/daylight/DaylightPage.tsx](../apps/web/src/daylight/DaylightPage.tsx) | 按目标选项目、打开任务、保护编辑草稿与失效提示 |
| [apps/web/tests/today.test.tsx](../apps/web/tests/today.test.tsx) | 任务回调、失败优先、截断计数、失败筛选及仅失败场景 |
| [apps/web/tests/navigation.test.tsx](../apps/web/tests/navigation.test.tsx) | 不透明任务 ID 编解码与异常路由回退 |
| [apps/web/tests/workspace-retention.test.tsx](../apps/web/tests/workspace-retention.test.tsx) | 新增真实 App、hashchange、popstate、visibility 和受控 interval 回归测试 |
| 本报告 | 安装产物证据、设计选择、实现与验证记录 |

新增实现没有引入依赖，没有修改 API、数据库格式或服务端聚合规则。SPEC.md、AGENTS.md、package.json 保持原状；没有执行 commit 或 push。

## 验证结果

- `npm run check`：通过。7 个工作区、186 个源码模块，依赖边界通过，无循环依赖。
- `npm test`：完成构建并执行 302 项；253 项通过，49 项在缺少 PostgreSQL `DATABASE_URL` 的初始化阶段失败。未读取 `.env` 或其他数据库秘密。
- 本次聚焦回归：`today.test.js`、`navigation.test.js`、`workspace-retention.test.js` 共 14 项，14 项通过。
- `git diff --check`：通过。
- ego-browser 对实际 Web 构建产物使用隔离的固定数据 API 验证；不是生产数据或生产部署验证。
- 桌面 1440×1100 与窄屏 375×1000 截图已检查。窄屏 document.scrollWidth=375，底部导航完整，失败提示可见。
- 浏览器确认：从首页打开第二个项目的具体待办；跨目标导航保留未保存草稿，关闭后打开新目标；删除链接提示；失败筛选 → 来源会话 → 浏览器返回后筛选、展开结果和成功快照保留，刷新失败提示同时显示。
- 固定数据服务记录的业务写入为 0。验证结束关闭临时浏览器页和服务。

上述为第一阶段验证记录。随后已完成 Electron 重打包、正式安装、真实 Web 服务部署以及真实 PostgreSQL 待办流程验收，详见 [真实安装与现场验收](TODAY_INSTALL_VERIFICATION.md)。完整 PostgreSQL 集成测试套件与 Outlook 同步仍未验证；现场流程通过不等同于完整测试套件通过。

## 复现命令

```bash
rea analyze-javascript-application /Applications/Today.app/Contents/Resources/app.asar \
  --max-heap-mb 4096 --analysis-timeout-ms 120000 --format json > today-evidence.json

# 将下述四个文件复制到独立 web-focused 目录后执行：
rea analyze-javascript-application web-focused \
  --max-heap-mb 4096 --analysis-timeout-ms 90000 --format json > web-evidence.json

# 请求文件结构：{ "source": { "kind": "inline", "evidence": <完整 Evidence> }, "view": { "kind": "summary" } }
rea inspect-analysis-view inspect-web-summary.input.json --format json > web-summary.json

npm run check
npm test
node --experimental-vm-modules --test \
  apps/web/dist-tests/today.test.js \
  apps/web/dist-tests/navigation.test.js \
  apps/web/dist-tests/workspace-retention.test.js
```

聚焦文件和 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `0k5v-lma7japl.js` | `e7ed228fa0a408dde7c5a42b7acc1c4a413bed0d543cc7342df259d3d76d8b40` |
| `19mx_ihn9hp14.js` | `647742d15f664a4abf2074a2a11faea015ae39d34668828018a17659f902be6d` |
| `38qorz0wfnppp.js` | `06156dbe53eeb64939cb73e523403e9cc22c6ac999cb4016ab3f1e807ddc8d8a` |
| `2gjrw3-b5naqc.js` | `3742085f002efbb16824596db091403986b3c253be89e6719510c8723061fab0` |
