# 内容页面浏览优先改造与真实验证

日期：2026-10-23。

技能、长期记忆、笔记与任务入口已改成默认浏览；用户明确选择新增或编辑后才打开表单。改动已部署到实际客户端连接的 https://192.168.31.5:3443，并在正式安装应用中核对。

## 页面行为

| 页面 | 默认状态 | 后续操作 |
| --- | --- | --- |
| 我的技能 | 技能列表、数量、用途、搜索及状态筛选；空库显示用途和创建入口 | 点击条目查看只读详情；详情中编辑、批准或撤回；新增显式进入编辑 |
| 长期记忆 | 记忆列表、来源与审批状态；空库显示用途 | 先阅读，再编辑或审批 |
| 笔记 | 笔记列表或空状态 | 条目先进入只读 Markdown 详情；新增与编辑按需打开编辑器 |
| 任务与提醒 | 已有安排、执行状态或空状态 | 明确新增或修改安排才显示表单；原有暂停、继续、取消、停止操作保留 |

保存成功后退出编辑；保存失败与版本冲突保留草稿。页面切换继续保留未提交编辑，放弃修改沿用既有确认逻辑。保留原有 base、revision、at、requestId 和防重复提交约定，审批状态保持原有语义。

## 本轮文件

| 文件 | 变更 |
| --- | --- |
| [PersonalPage.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/src/workspace/PersonalPage.tsx) | 浏览、只读详情、新增、编辑四种状态；列表与筛选 |
| [NotesPage.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/src/workspace/NotesPage.tsx) | 列表、只读详情与显式编辑 |
| [TasksPage.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/src/workspace/TasksPage.tsx) | 安排表单按需挂载 |
| [App.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/src/ui/App.tsx) | 分别说明技能、记忆、笔记和任务的用途 |
| [workspace.css](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/public/workspace.css) | 内容库、阅读、空状态与窄屏布局，沿用原有视觉令牌 |
| [personal-browsing.test.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/tests/personal-browsing.test.tsx) | 新增空库、详情、编辑冲突、搜索、筛选与审批测试 |
| [workspace-browsing.test.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/tests/workspace-browsing.test.tsx) | 新增笔记和任务的浏览、按需编辑、保存与草稿保护测试 |
| [workspace-editing.test.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/tests/workspace-editing.test.tsx) | 原有保存与冲突测试适配显式编辑入口 |
| [direct-chat.test.tsx](/Users/haifeng/project/projects/pi-durable-assistant/apps/web/tests/direct-chat.test.tsx) | 对话导航进入内容库时确认默认没有编辑器 |

无新增依赖，未修改清单、规格或协作规则，未提交或推送。工作区原有未提交内容保持。

## 验证结果

- `npm run check`：通过，7 个工作区、186 个源码模块，无循环依赖。
- `npm test`：313 项，264 项通过，49 项因本机缺少 `DATABASE_URL` 在 PostgreSQL 初始化阶段失败；本轮页面测试通过。
- `git diff --check`：通过。
- 隔离浏览器：技能列表、只读详情、显式编辑及取消、笔记只读详情、任务默认浏览、空技能库；1440 像素桌面与 375 像素窄屏均已检查，窄屏无横向溢出。
- 正式安装客户端：四类页面默认编辑器数量均为 0，读取无错误；点击新增技能后出现一个编辑器，未填写内容取消后回到技能库。验收没有保存技能、记忆或安排。
- 真实记录：技能 0、记忆 0、Daylight 项目 7、待办 22。有内容时的详情、审批、保存冲突与失败重试由固定数据浏览器和行为回归测试覆盖，本轮没有为此向真实库添加样例内容。

## 真实部署与启动

仅替换 Web 产物，镜像为 `pi-durable-verify-web:content-browse-20261023-01`，保留上一镜像 `pi-durable-verify-web:today-rea-20261023-04`。远端 232 个文件全部可读，SHA-256 与本地构建逐一相同。

```json
{
  "app.js": "b20e4c2ec2a6f156c6f12d85d760891defc13a0921e7a0cf448419bf8abbe34f",
  "workspace.css": "932169175e6643c6787e6f9cf58ad7422c825f53696bf665362ba2b09be093e3"
}
```

Web 容器为 `f0d47a8ff6942d540dde21e760f9826ce8dea12f2dbf8adc30a70ae4016f022d`，启动于 `2026-10-23T03:18:28.712470178Z`。API、PostgreSQL 和微信服务的容器标识与启动时间保持一致。桌面程序及连接配置未改，连接配置散列保持一致。

普通窗口的辅助功能点击未形成导航，因此正式页面通过安装应用本机渲染诊断核对，并保存原生窗口截图；期间发现的验收脚本字段和选择器错误均只修正脚本。没有据此修改产品代码。核对结束后以普通方式重新启动应用，进程为正式安装路径，无诊断参数，临时 9231 端口已关闭。最后原生截图显示已连接的长期记忆内容库；当时辅助功能树尚未完整生成，依据截图核对实际页面。

## 截图与运行记录

- [正式客户端：技能空库](/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-content-browse-l9vwc9d_/native-skills-final.png)
- [正式客户端：任务入口](/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-content-browse-l9vwc9d_/native-tasks.png)
- [375 像素技能库，固定数据](/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-content-browse-l9vwc9d_/skills-mobile.png)
- [真实页面核对结果](/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-content-browse-l9vwc9d_/native-verification.json)
- [普通启动核对结果](/var/folders/6l/tt66cfp15nzfx89d08w62rj00000gn/T/pi-content-browse-l9vwc9d_/normal-startup.json)
