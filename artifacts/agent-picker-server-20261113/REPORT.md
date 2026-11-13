# 服务器选择器发布

已发布 Web 镜像 `pi-durable-verify-web:agent-picker-native-20261113-03`。以内网当前资源为基底重建选择器入口及依赖的当前 Composer，保留 1907 个其他资源文件的内容指纹。只重建 Web；API、PostgreSQL、微信桥未重启，容器环境和挂载未变。公网与内网资源指纹验证通过，API 健康、匿名设备接口仍拒绝访问。

客户端重新启动后实际连接 `https://192.168.31.5:3443/`，验证新版 Agent 选择器存在、Claude 独立设置入口不存在，原生 permissionMode 选项为 acceptEdits、auto、bypassPermissions、dontAsk、plan。未发送模型消息，未执行高权限操作。

发布中发现 macOS 元数据污染和 Composer.js/composer.js 大小写冲突。最终包以服务器真实文件指纹为准，精确读取 Composer.js 后通过客户端现场验收。完整部署结果见 result.json。

最终客户端验证：实际点击权限区域和全部 Agent、切回原 Pi，全部成功。再次关闭并启动客户端后，自动连接服务器并加载 `/assets/app-T3RDT6SX.js`，新版选择器可见，独立设置对话框数量为零。

提交前复核另修复：搜索回车误重置模型、Finder 精简 PATH 下的权限查询、权限覆盖无法撤销，以及切换 Agent 后加载状态残留。检查通过，62 项相关测试通过；全量测试 1064 项通过、59 项失败，主要涉及数据库配置和日报工具链。这些审查修复仅在源码中验证，尚未重新部署到服务器或已安装客户端。

服务器发布目录：`/home/zhf/pi-durable-verify-EvtOlEt6/updates/agent-picker-native-20261113-03/`。前一原始 Web 镜像 `pi-durable-verify-web:agent-settings-ui-20261112-01` 保留，可用于人工回退；前两候选版本曾出现控件缺失或位置错误，已被最终版本替代。
