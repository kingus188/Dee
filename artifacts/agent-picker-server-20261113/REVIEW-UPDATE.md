# b7a4be8 审查修复双端更新

已将本轮审查修复安装到 `/Applications/Dee.app`，并发布服务器 Web 镜像 `pi-durable-verify-web:agent-picker-native-20261113-04`。

- 桌面打包隔离检查、严格签名校验通过；安装包与候选包 ASAR SHA256 均为 `c955a6e4dbd6f69ca95eee55e307098ced90d945bf64dd1fe3aaed4cb4062c6c`。旧应用已保留在用户 Dee Backups 目录。
- 实际客户端自带页面 `dee://local/#chat/local` 加载 `/assets/app-QQMKAFCK.js`，搜索模型按 Enter 正确选择、权限从 read-only 设置后可清除覆盖、独立设置表单不存在。
- 关闭并重启客户端后自动连接 `https://192.168.31.5:3443/`，加载服务器 `/assets/app-3ANIWIP3.js`，重复上述实际交互验证通过。验证前的 Agent、模型、强度和 sandbox 覆盖已恢复。
- 权限选项通过新客户端主进程读取本机 Codex CLI 获得，未执行高权限模式、未发送模型消息。
- 公网与内网资源指纹、API 健康、匿名设备接口保护验证通过。API、PostgreSQL、微信桥未重启，环境及挂载未变。

详情：`review-update-local.json`、`review-update-server.json`、`review-update-deployment.json`。当前更新替代 REPORT.md 中“审查修复尚未重新部署”的旧状态。安装包包含此前已经安装的工作区凭据/连接等未提交改动，本轮没有额外修改这些源码。

服务器发布目录：`/home/zhf/pi-durable-verify-EvtOlEt6/updates/agent-picker-native-20261113-04/`，已保存对应回滚配置。
