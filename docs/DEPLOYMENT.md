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

## 7. 直接使用 cpolar 公网访问（2026-10-26）

当前公网入口：**<https://565784c1.r21.vip.cpolar.cn>**。直接使用 cpolar 的 HTTPS 域名，不需要自有域名或 DNS 配置。该地址为随机分配，重启或重新分配后可能变化，不应当作固定域名。

首次打开主页时，浏览器会要求登录：用户名为 `demo`，密码沿用现有服务器访问口令。本次没有更改口令，也没有关闭鉴权。需要新设备登录时使用原口令，不要把口令或会话 Cookie 发到聊天、URL 或仓库中。

### 接入方式与认证

新增的独立网关 `pi-durable-public-gateway` 只发布 `127.0.0.1:3301`，通过已有 `pi-durable-verify_default` 网络转发到原 Web；cpolar 在外部终止 HTTPS。原内网 `3300/3443` 入口继续保留，API、PostgreSQL 和微信桥未增加公网端口。

本次现场确认：cpolar `3.3.12` 能透传普通 HTTP 的 Authorization，但公网 WebSocket Upgrade 会丢失该头；Cookie 可以正常保留。因此网关在返回首页前通过 Nginx `auth_request` 请求 `/api/info`，验证已有 Basic 凭据。验证成功后，后端签发签名会话 Cookie，网关将它加入首页响应，浏览器随后自动用于同源 WSS。没有向所有请求注入固定凭据，也没有修改 Origin/Fetch Metadata 来绕过保护。

会话 Cookie 使用 `__Host-pi-durable-session`，设置 `Secure`、`HttpOnly`、`SameSite=Strict`、`Path=/`，不含口令，有效期一小时。签名密钥由后端每个 HTTP server 实例随机生成，重启后旧 Cookie 失效；刷新主页可使用浏览器缓存的 Basic 凭据重新建立会话，必要时重新输入口令。过期检查发生于 HTTP 请求及新 WS 握手，已有 WS 不会仅因 Cookie 到期被强制切断。非浏览器 API 与桌面客户端仍可使用现有 Basic Auth；显式错误 Authorization 不会被有效 Cookie 掩盖。微信入站仍使用原有独立 Bearer 令牌。

### 配置与运行版本

服务器部署根目录为 `/home/zhf/pi-durable-verify-EvtOlEt6`。仓库中的对应配置位于 [deploy/cpolar](../deploy/cpolar/)：

| 文件或服务 | 用途 |
| --- | --- |
| `compose.cpolar.yaml` | 独立 `pi-durable-public` 项目，只管理公网网关，不管理业务容器 |
| `nginx.cpolar.conf` | 首页认证、签名 Cookie 引导、Host/Origin 透传及 WebSocket/流式代理 |
| `cpolar-pi-durable.service` | 独立 cpolar 进程，不重启 ai-tutor 的 `cpolar.service` |
| `compose.auth.yaml` | 只覆盖原项目 `api` 镜像的认证补丁，不能独立运行 |
| `/usr/local/etc/cpolar/pi-durable.yml` | 服务器私有认证/隧道配置，root 所有、`0600`，不得提交 |
| `updates/cpolar-session-20261026-01/deployment.json` | 部署前的精确镜像、容器、挂载和 13 个 Compose 覆盖文件清单，不含环境值 |

cpolar 单元使用动态用户与 `LoadCredential`，通过 `%d/cpolar.yml` 读取管理器提供的只读凭据副本；仅在本机开放 `4041` 检查入口，隧道设置 `inspect: false`。管理页 `9200` 属于原 cpolar 进程，不代表此独立进程的在线隧道；新地址查看本服务日志或 cpolar 官网后台。原 ai-tutor 的进程和公网地址均未更换。

本次 API 由 `pi-durable-verify-api:notes-typora-20261023-01` 选择性更新为 `pi-durable-verify-api:cpolar-session-20261026-01`，只加入会话模块及 HTTP/WS 认证调用，不发布工作区其他未提交变化。构建输入保存在服务器上述更新目录。Web 保持 `pi-durable-verify-web:todo-notifications-20261026-01`，未重建；PostgreSQL 也未重建。API 原有环境值、模型配置和持久挂载均保持一致。由于微信桥使用 `network_mode: service:api`，API 和微信桥一起重建，并验证微信桥已指向新的 API 网络命名空间；未更换其镜像或状态卷。

### 运维与回滚

以下检查不打印口令或 Cookie：

```bash
ssh zhf@192.168.31.5
cd /home/zhf/pi-durable-verify-EvtOlEt6
docker compose -f compose.cpolar.yaml ps
docker compose -f compose.cpolar.yaml exec -T gateway nginx -t
systemctl is-active cpolar-pi-durable
systemctl is-enabled cpolar-pi-durable
sudo journalctl -u cpolar-pi-durable -g 'Tunnel established at' --no-pager -n 10
```

最后一项含历史地址，仍需实际访问确认。只重载公网网关时：

```bash
docker compose -f compose.cpolar.yaml up -d --no-deps --force-recreate --wait gateway
```

认证补丁必须叠加在 `deployment.json` 记录的原部署覆盖文件之后，再加更新目录中的 `compose.auth.yaml`。不要只用早期 `compose.verify.yaml` 重建整个项目，它与实际运行镜像和环境不一致。API 更新时须一并处理共享网络的微信桥，不能只替换 API 后留下旧命名空间。

需要回滚认证补丁时，先停止并禁用本次公网 cpolar 单元，再按清单恢复原 API 镜像及微信桥，保留所有数据卷；旧版本没有 Cookie WS 鉴权，不能在回滚后继续将此公网入口当作可用服务。禁止 `down -v`，也不要用旧 SQLite 文件覆盖当前 PostgreSQL 数据。本次保留了原镜像和回滚清单，未执行生产回滚或灾难恢复演练。

### 验证范围

本地使用新建、独立 PostgreSQL 与临时 SQLite 数据通过 26 项认证/会话/WebSocket/笔记边界检查；实际认证补丁镜像也用独立数据验证了 HTTP、Cookie 和 WS。测试没有使用生产数据库。

公网已验证：首页匿名 401 并带 Basic 挑战，正确原口令返回 200 并建立受保护会话；Cookie API 返回 200，篡改 Cookie 返回 401，跨源和缺少 Origin 的写请求均返回 403。真实 Chromium 在 HTTPS 安全上下文完成原口令登录、主页/接口读取与 WSS 只读 `/api/info` 请求，均返回 200，网页 JavaScript 无法读取 HttpOnly Cookie。验收没有发送模型问题、创建提醒或发送微信/Teams 消息，未通过首页执行应用 JS 自动创建对话。长时间连接和实际业务使用仍需正常运营观察。

额外的 WSS 检查在同一连接上间隔 33 秒发送两次只读 `/api/info` 请求，均返回 200，实际连接持续 34.675 秒；这验证了跨两个后端心跳周期后仍可交互，不依赖代理是否向浏览器暴露 ping 帧。公网 HTTP 地址返回 404 且无口令挑战，仅使用 HTTPS 登录。
