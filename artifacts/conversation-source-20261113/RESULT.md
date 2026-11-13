# 对话来源切换发布验收

服务器已发布 Web 镜像 pi-durable-verify-web:conversation-source-20261113-01。候选138个文件、保留1984个文件指纹通过；内外网资源、API健康及匿名设备接口拒绝检查通过。API、PostgreSQL、微信服务未重启，环境及挂载未变。

本机 /Applications/Dee.app 已安装前端定向更新，59个非Web文件内容保持一致，ASAR完整性及严格签名检查通过，分发目录已同步。原客户端备份 /Applications/.Dee-before-conversation-source-20261113.app。

已启动实际安装客户端，通过原生菜单键盘操作完成 Dee → Teams → Dee。Teams 时来源显示 Teams，实际 Teams 工作台可见；返回时来源显示小 D 助手，原对话及输入框恢复。已检查 teams.png、assistant.png。客户端保持运行并停留 Dee。

系统NSWorkspace启动及AX select操作失败后，使用清除ELECTRON_RUN_AS_NODE的可执行程序启动及原生键盘菜单操作完成验收。

未发送模型或Teams消息，未执行业务写入；本轮未覆盖窄屏、暗色主题及全部布局矩阵。前轮类型检查、构建及新增回归测试通过；全量测试受缺少DATABASE_URL阻塞。未提交或推送源码。

服务器回退文件 /home/zhf/pi-durable-verify-EvtOlEt6/updates/conversation-source-20261113-01/compose.rollback.yaml。
