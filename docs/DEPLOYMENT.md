# Docker / VPS 部署与数据保护

面向已经完成 [本机配置与运行](GETTING_STARTED.md)、准备在自己的 VPS 上长期运行的用户。当前是单用户 Agent，部署默认以 **Docker Compose + PostgreSQL/pgvector 业务数据卷 + SQLite 会话数据卷 + HTTPS 反向代理** 为基础。待办与日报使用 PostgreSQL；Durable 会话、设置和消息等继续使用 SQLite。请勿把一次模拟进程恢复测试等同于灾难恢复。

## 1. 前置检查

- Docker Engine 和 Docker Compose v2（命令是 `docker compose`，不是旧版 `docker-compose`）。
- 服务器可拉取 Node、Go 及（启用微信时）固定上游源码依赖；微信镜像构建需要额外的下载时间和网络。
- HTTPS 域名、Nginx/Caddy/其他反向代理，以及不与其他服务冲突的宿主机端口。
- 已在模型服务商设置 API 预算和额度限制；本项目不会替你阻止高额调用。

```bash
git clone https://github.com/kingus188/pi-durable-assistant.git
cd pi-durable-assistant
cp .env.example .env
```

编辑 `.env`，至少设置 `DEMO_PASSWORD`、`DATABASE_URL`、`POSTGRES_PASSWORD`、`POSTGRES_APP_PASSWORD`、`LLM_API`、`LLM_BASE_URL`、`LLM_API_KEY` 和 `LLM_MODEL`。详见 [全部配置项](CONFIGURATION.md)。**生产模式不允许空密码。** Compose 首次初始化数据库时启用 `vector` 扩展并建立非超级用户 `assistant_app`；`DATABASE_URL` 应使用该业务账号、容器主机名 `postgres` 和数据库 `assistant`。应用会建立 `assistant` schema，账号需要该数据库的 `CREATE` 权限；不要给业务账号超级用户权限。已有 PostgreSQL 数据卷不会重新运行初始化脚本，修改环境变量也不会自动轮换数据库密码。

## 2. 部署核心服务

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 pi-durable-assistant
```

Compose 分开运行 `pi-durable-assistant` API 后端、`web` 页面/代理与 `postgres` 数据库容器。默认 `HOST_PORT=3300`，只发布 Web 的 `127.0.0.1:3300:8080`；后端 3000 与数据库 5432 仅在容器网络访问。Web 镜像不包含后端依赖，不挂载数据卷、不读取账号文件。验证（例：已经设置了口令）：

```bash
curl -u demo:YOUR_PASSWORD http://127.0.0.1:3300/api/info
```

示例 `YOUR_PASSWORD` 必须换成自己的密码；避免在共享机器的 Shell 历史里保留明文凭据。可直接使用 `curl -u demo` 交互输入密码。

API 使用 HTTP Basic Auth，静态页面可加载但不含账户数据；数据请求未登录返回 401。**不要开放 3000、3300 或微信桥 18790 给公网访问**。

### Nginx 反向代理示例

先由现有 TLS 配置提供 `https://assistant.example.com`（证书、域名均为占位符），再在其 HTTPS server 内配置：

```nginx
location /api/socket {
    proxy_pass http://127.0.0.1:3300;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:3300;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;      # SSE / streaming
    proxy_read_timeout 1h;
}
```

反向代理应保留 `Authorization` 请求头。Basic Auth 必须配合 TLS，不能让公网明文传输口令。某些 CDN、企业代理有连接超时或缓存策略，WebSocket 断线自动重连可用，但不能代替真正的请求稳定性。

## 3. 可选：启动微信

按照 [微信 iLink 手册](WECHAT.md) 配置两个不同的随机 token、`WECHAT_ENABLED=1`，再：

```bash
docker compose --profile wechat build
docker compose up -d pi-durable-assistant
docker compose --profile wechat run --rm wx-bot --config /etc/wx-bot/config.json login primary
docker compose --profile wechat up -d
```

`wx-bot` 与 Node 共用 Docker 网络命名空间，18790 仅在内部 loopback 使用。主分支支持微信**文字和语音转写文字**；不代表可以解析微信图片、文件和视频。扫码、消息窗口与微信平台限制需要真实账号验证。

### 迁移 Teams 自动转发到微信

微信收发正常不代表 Teams 自动采集已经启动。API 需要设置 `TEAMS_CONFIG_DIR`（本次服务器为 `/data/teams`），且该目录必须包含已有的 `teams-forward-config.json`；离线模式、目录未设置或配置文件缺失时，现有代码会跳过 Teams 集成。

从桌面迁移时，同时迁入 `teams-forward.json` 同步水位，以及 `agent.sqlite` 中的 `teams_messages`、`teams_auto_replies` 数据，保留 `pushed_at`、`replied_at` 等去重标记。先为目标数据库制作一致性备份，再按相同表结构在事务内合并；不要用桌面数据库覆盖服务端已有的会话、模型设置或业务数据。账号配置、微信状态及数据库备份留在权限受限的持久存储中，不提交到 Git。

转发器从 `TEAMS_CONFIG_DIR/state/primary/context_tokens.json` 的收件人键读取目标。API 因此需要只读访问微信桥的实时状态卷：使用仓库命名卷时，挂载 `wx-bot-state:/data/teams/state:ro`；使用服务器现有目录时，挂载对应的微信状态目录。核对两个容器的实际 UID/GID，并让状态文件所有者与读取进程兼容。本次实例将微信桥运行账号与 API 对齐为 `1000:1000`，同时调整微信桥状态和媒体目录的所有权，保留目录 `0700`、状态文件 `0600`；其他部署应先检查实际身份，不要直接套用 UID。

配置持久化到实际使用的 Compose 文件后，一起重建 API 和微信桥，因为两者共享网络命名空间。验收需依次确认：Teams 同步时间持续更新、新消息进入数据库、符合提醒规则的消息进入微信队列、最终发件箱记录为 `sent`，以及 `/api/wechat/status` 的 `pending`、`blocked` 数量。Teams 的 `pushed_at` 只表示已交给通知链路，不能单独作为微信发送成功的证据；状态文件时间较旧也不能单独证明令牌过期。

## 4. 安全升级与备份

**禁止以 `docker compose down -v` 升级。** `-v` 会删除项目命名卷，可能永久丢失 PostgreSQL 业务数据、SQLite 会话与微信登录状态。

项目现阶段没有内置自动化、已演练的 SQLite 在线备份任务。建议：

1. 停止写入后再备份（最简单的一致性策略）。执行 `docker compose --profile wechat stop`；若没启用微信，仅停止主服务即可。
2. 备份前检查 `docker volume ls` 和 `docker compose ps -a`，识别本项目数据卷，并保证外部备份介质有剩余空间。
3. 以下命令演示**在服务停止后备份主应用数据**；它使用现有应用容器已挂载的数据卷，避免猜测 Compose 自动生成的卷名称：

```bash
mkdir -p backups
docker compose stop pi-durable-assistant
docker run --rm --volumes-from pi-durable-assistant \
  -v "$PWD/backups:/backup" alpine:3.21 \
  sh -c 'cd /data && tar -czf /backup/pi-durable-data.tar.gz .'
ls -lh backups/pi-durable-data.tar.gz
docker compose up -d pi-durable-assistant
```

`backups/` 在执行本例时位于仓库内，**切勿将备份压缩包提交到 Git**；应尽快安全地移到仓库以外（最好离开这台 VPS），并限制访问权限。恢复演练应在**单独的测试环境和新数据卷**进行，不能直接覆盖现有生产数据。

**如果已经启用微信**，只备份 `/data` **不够**：还需要额外备份 `wx-bot-state` 对应的 `/state`（登录凭证、游标）和需要保留的 `wx-bot-media` `/media`；先停止微信服务，再根据 `docker volume ls` 和容器挂载检查实际卷名。这些备份和任何包含对话内容的 SQLite 文件都属于敏感数据。

**启用 PostgreSQL 后，还必须备份业务数据库。** `/data` 不包含 PostgreSQL 中的新待办和日报，保留旧 SQLite 文件不能代替业务库备份。以下示例在权限受限的目录生成自定义格式归档；若同时备份会话和业务库，先停止 API 与已启用的微信服务，避免跨存储写入：

```bash
umask 077
mkdir -p backups
docker compose exec -T postgres pg_dump -U assistant_admin -d assistant -Fc > backups/business-postgres.dump
docker compose exec -T postgres pg_dumpall -U assistant_admin --globals-only > backups/postgres-roles.sql
```

角色备份含密码哈希，同样不得提交或公开。将归档、角色备份与 `/data` 备份一起移到服务器之外；恢复演练使用独立 PostgreSQL 实例和新数据卷，先准备相同角色与 `vector` 扩展，再用 `pg_restore` 恢复业务库，并验证应用读写。不要复制运行中的 PostgreSQL 数据目录充当一致性备份。

完成备份后再升级：

```bash
git pull --ff-only
docker compose up -d --build
docker compose ps
```

涉及功能分支合并、数据库格式或外部通道变化时，必须核对本次版本说明与 GitHub CI，再升级。**F6 自动备份与灾难恢复尚未在主分支实现**，当前只能采取上述运营流程。

## 5. 运行验收

部署完至少执行：

- `docker compose ps` 中服务为运行状态，`/api/info` 在提供凭据后可以返回信息。
- 浏览器创建一轮真实模型对话，确认 WebSocket 对话、工具调用、任务中心正常。
- 创建 1 个提醒、1 个后台任务，重启主服务后查看它们的持久状态；**不要通过 `down -v` 验证恢复**。
- 需要手机推送时用真实目标检查 `NOTIFY_MODE=all`；Webhook 已有持久队列与有限重试，仍须现场验证目标响应和去重，并按[通知队列说明](CONFIGURATION.md#通知队列与失败记录)检查失败记录。
- 至少在隔离环境验证一次备份可以恢复。没有这一步，不能把它视为生产级数据可靠性。

本轮隔离验收（2026-10-21）：在独立 Docker Compose 实例中使用新数据卷和 `no-new-privileges` 运行 API/Web；外层 Nginx 提供自签名 HTTPS（验证入口 `https://192.168.31.5:3443`，HTTP `:3300` 仅 301 跳转）。已实测 Basic Auth、`/api/info`、日报写入与容器重启后的 SQLite 数据保留；HTTPS 浏览器安全上下文可正常打开日报并读取已保存内容。随后在同一隔离实例启用服务端微信通道：固定版本 wx-bot 的 44 项 Go 测试通过，使用本机交叉编译的 Linux amd64 二进制构建容器，迁移现有 `primary` 登录状态，并通过服务端 Webhook 收到测试消息；桌面端微信开关已持久关闭，本机 18790 端口已释放。生产 VPS 仍需真实微信消息和长时间稳定性验收。

出站首轮测试曾被上游 `/ilink/bot/sendmessage: ret=-2` 拒绝，原因未确定。随后真实微信发来 `Hello`，此前排队的迁移测试回复及新生成的正常问候“Hello！有什么我可以帮你的吗？”均已标记 `sent`，状态接口确认 `pending=0`、`blocked=0`。迁移文案来自此前注入的测试请求，不是固定回复。至此已验证真实入站、模型生成及微信发送接口接受回复；长期稳定性与重启恢复仍需单独验收。

模型连接复用本机 Pi `~/.pi/agent/models.json` 中已有的 `cpa/gpt-6.1-sol` 配置和对应 Key，协议为 `openai-responses`；不是直接复制 Pi 默认的 `magpie/auto/gpt-6.1-sol`，因为该地址仅监听 Mac 的 `127.0.0.1:3425`。远端直连已有 CPA 服务，不依赖 Mac 持续在线。通过受验证的 HTTPS 设置接口将连接保存到权限为 `0600` 的私有 SQLite；Compose 仅设置非秘密参数 `LLM_CONTEXT_WINDOW=128000`、`LLM_MAX_TOKENS=16384`，不包含模型 Key。已通过实际网页请求收到“模型连接正常。”，容器重建后模型连接和该轮对话均保留；未验证模型工具调用、长上下文和外部渠道。网页访问密码另行轮换，旧密码返回 `401`。本次是一次性配置复制，本机 Pi 后续修改不会自动同步到远端。

PostgreSQL 迁移验收（2026-10-21）：上述服务器实例已切换到独立 `pgvector` PostgreSQL 16 容器，`vector` 扩展版本为 `0.8.3`，应用使用非超级用户 `assistant_app`。桌面 Daylight 的一致性快照已导入：7 个项目、30 条任务记录（22 条未删除）、13 条动作幂等记录；逐字段比对源 SQLite，包含排序、清单和删除标记，均保留。服务器原有 1 篇日报已迁入，日期、正文和原版本在首次迁移时保留。本机两份 `agent.sqlite` 均无日报记录；仓库 Daylight 的 5 个项目、23 条任务是桌面来源的完全一致子集，因此未重复导入。

已通过真实 HTTPS API 创建、移动和删除验收待办，通过浏览器编辑并保存日报；停止并重新启动 PostgreSQL、API 和微信容器后，待办状态与日报内容、版本均保留。验收待办及其删除标记已清除，日报正文恢复为验收前内容，正常保存产生的版本号仍递增。`npm run check` 通过；连接真实 PostgreSQL 的 `npm test` 为 255 项通过、0 失败、0 跳过。`pgvector` 扩展可用不代表已实现向量检索；此次未验证向量检索、数据库备份恢复、长期稳定性或生产 VPS。

本次服务器保留 `/data/backups/pre-postgres-20261021/` 下的迁移前 SQLite 在线备份、`/data/imports/desktop-daylight-20261021.sqlite` 导入快照，以及 `pi-durable-verify-api:pre-postgres-20261021` 旧 API 镜像。需要回滚时先停止业务写入并备份当前 PostgreSQL 与 SQLite，再用旧镜像和隔离恢复卷验证；**迁移后写入 PostgreSQL 的内容不会自动回写旧 SQLite**，不能只换旧镜像便视为无损回滚。

## 6. 故障与限制

2026-10-22 微信漏推修复验收：确认前一天迁移遗漏 Teams 配置目录，服务端没有启动 Teams 采集与转发。补齐配置与微信状态只读挂载、迁移 2020 条 Teams 历史记录及同步水位、对齐容器账号后，真实采集恢复，补采当天 37 条消息；其中 2 条重要提醒分别在北京时间 15:27:55、15:29:34 标记 `sent`，每条发送尝试 1 次，最终 `pending=0`、`blocked=0`。3 个无读取权限的 Teams 会议聊天仍返回 Graph 403，按原有逻辑跳过。修复前数据库与 Compose 配置均已备份；这次验收证明采集及发送接口成功，不代表微信用户已读，也不替代长期稳定性验收。

配置、模型、SSE、微信、权限和附件问题见 [故障排查](TROUBLESHOOTING.md)。此项目不包含多用户账户、细粒度权限、自动升级回滚或统一成本上限。公网使用前需自行评估隐私和供应商 API 账单风险。
