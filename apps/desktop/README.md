# 小 D 桌面程序

Electron 包装现有网页并在应用进程内启动本地服务，无需另开服务端。开发需要仓库要求的 Node.js 版本；打包后的应用自带运行时。

在仓库根目录执行：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run desktop
```

没有设置 `LLM_API` 和 `LLM_MODEL` 时使用 `faux` 模拟剧本，界面会显示模型信息。这不能理解任意自然语言。真实模型沿用服务端的 `LLM_API`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 环境变量；模块不自动读取 `.env`。macOS 从 Finder 启动不会继承终端设置的环境变量；当前真实模型需从已配置环境的终端启动应用，尚无桌面设置页。

桌面版数据固定放在 Electron `userData/data` 下，macOS 默认是 `~/Library/Application Support/Pi Durable Assistant/data`。它不读取或迁移仓库的 `data/`，也不使用 `DATA_DIR`、`PORT` 或 `DEMO_PASSWORD`。只允许一个桌面实例使用该目录。

服务仅监听 `127.0.0.1` 的随机端口，每次启动生成临时口令，由主进程给同源请求添加认证。网页没有 Node.js 权限，没有 preload/IPC 接口；HTTP(S) 外链交给系统浏览器，其他协议和跨源导航被拒绝。桌面服务禁用模拟崩溃和微信入口。

macOS 关闭窗口后应用与任务继续运行，点击 Dock 可恢复窗口；使用 Cmd+Q 完全退出后，本地服务和后台任务停止。Windows/Linux 关闭最后一个窗口即退出。再次打开应用时由现有持久化运行时恢复可恢复的任务。

## 打包

```bash
pnpm run desktop:package
```

生成当前操作系统和 CPU 架构的应用，输出在 `dist/desktop/`，macOS 为 `Pi Durable Assistant.app`。打包只复制编译产物、包清单、许可证和生产依赖，不复制源码、`.env` 或用户数据库。临时目录在成功或失败后清理。

开发安装使用 pnpm 默认的依赖隔离；打包临时目录使用 pnpm 的 `hoisted` 布局。桌面入口显式指定网页资源目录，避免内部模块的打包位置影响资源定位。每次打包会使用包内运行时，按桌面入口解析并启动服务，检查页面、脚本、样式和信息接口；检查失败则打包命令失败。

当前不包含分发签名、公证、安装器、自动更新或跨平台交叉打包。发布给其他机器前需单独完成对应平台的签名和验证。

## 验证

```bash
pnpm run check
pnpm test
```

包括 URL 权限边界、本地服务鉴权、端口冲突清理、重复关闭和数据重开测试。原生窗口、真实模型、文件选择/下载和各平台安装行为需要单独验收。
