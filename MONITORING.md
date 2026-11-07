# Aster Pulse — 监控告警（Uptime Kuma，自建免费）

目标：首页挂了、接口挂了能第一时间知道；状态页公开可看；不花钱、不动应用代码。

## 架构

- Uptime Kuma 与 aster-pulse 跑在同一台香港服务器上，都是 Docker 容器。
- Kuma 只绑 `127.0.0.1:3001`，**不直接暴露公网**；公网经 Nginx 看状态页。
- Nginx 只新增了三个 `location`（`/status/`、`/assets/`、`/socket.io/`），证书相关配置没动
  （仓库里的 `nginx.conf` 是模板，服务器上那份是 Certbot 改过的，同步时见下文“服务器同步步骤”第 3 步，
  千万不要直接 `cp nginx.conf` 覆盖服务器上的文件）。
- 应用代码一行没动（`server.js`、`app/worker.js`、`reference/client.js` 均未改）。

## 镜像版本（已核实）

- 镜像：`louislam/uptime-kuma:2.5.9`（钉死小版本，不用浮动标签）
- 核实时间：2026-11-07，来源 Docker Hub 官方仓库 API：
  最新 2.x 为 `2.5.9`，2026-10-31 发布，digest
  `sha256:e88415a90dd2f7efecdbc18de0490aff292764a3ac471531bf1d0481725591bd`，
  `2` 标签指向同一 digest。
- 为什么不用任务原定的 `:1`：`:1` / `:latest` 仍指向 1.23.17，而 1.x 已不再更新
  （2.5.4 修过安全问题 CVE-2026-77415，2.5.5 修过内存泄漏），新部署直接用 2.x。
- 升级镜像时改 `docker-compose.yml` 里的 tag 后 `docker compose pull uptime-kuma && docker compose up -d uptime-kuma`
  即可，数据在 `./data/uptime-kuma` 卷里，不会丢。

## 监控项清单（在 Kuma 管理界面里建，见“首次启动”）

Kuma 跑在容器里，它的 `127.0.0.1` 是容器自己的回环网，不是宿主机，
所以监控 URL **不要填 `http://127.0.0.1:3000/...`**，一律用公网地址
`https://buildaster.xyz/...`——顺带把 Nginx 这一层也测进去，测的就是用户真实访问路径。

| # | 监控项 | URL | 类型 | 检查间隔 | 超时 | 备注 |
|---|---|---|---|---|---|---|
| 1 | 首页 | `https://buildaster.xyz/` | HTTP(S)，关键词 `Aster` | 60 秒 | 30 秒 | 只看 200 不够，关键词能发现“200 但页面被换掉”的情况 |
| 2 | 健康检查 | `https://buildaster.xyz/api/health` | HTTP(S)，关键词 `aster-pulse` | 60 秒 | 10 秒 | 健康接口本身不调上游，应该最快；慢了就说明 Node 有问题 |
| 3 | 行情接口 | `https://buildaster.xyz/api/markets` | HTTP(S)，只看状态码 200 | 60 秒 | 30 秒 | 上游失败时有 stale 缓存回退，仍应返回 200 |
| 4 | 代币数据接口 | `https://buildaster.xyz/api/token-stats` | HTTP(S)，只看状态码 200 | 60 秒 | 30 秒 | 价格/质押/销毁三个指标的来源接口 |
| 5 | 回购接口 | `https://buildaster.xyz/api/buyback` | HTTP(S)，只看状态码 200 | 300 秒 | 120 秒 | **重点**：冷启动要 8–10 秒，偶发几十秒（7 天分段查成交），间隔拉到 5 分钟、超时放宽到 120 秒，避免误报 DOWN；后台每 300 秒自动刷新，平时命中缓存很快 |

状态页：slug 定为 `aster-pulse`，地址 `https://buildaster.xyz/status/aster-pulse`，
5 个监控项全加进去，设为公开（Published，不设密码），任何人不用登录就能看。

## 告警通知渠道（未接通，只留了入口）

需要用户提供信息才能接，目前只做到“留好配置入口”：

- `.env.example` 里留了占位变量（`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`、
  `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD`），
  全部是空的注释行，**没有任何真实 token、聊天 ID 或密码**。
- 注意：Kuma 的通知不是读 `.env`，而是在管理界面里配
  （Settings → Notifications → Setup Notification），`.env.example` 只是清单，
  提醒用户要准备什么。

用户要提供什么（二选一，Telegram 推荐）：

| 渠道 | 用户提供 | 怎么拿 | 配在哪里 |
|---|---|---|---|
| Telegram（推荐） | Bot Token、自己的 Chat ID | Telegram 里找 `@BotFather` 新建 bot 拿 token；找 `@userinfobot` 查自己的 chat id | Kuma → Settings → Notifications → Telegram |
| 邮件 SMTP（备选） | SMTP 服务器、端口、发件账号、应用专用密码 | 发件邮箱的设置里开 SMTP，用应用专用密码，不要用登录密码 | Kuma → Settings → Notifications → SMTP |

配好后在通知设置里点 Test 测试，收到测试消息才算接通；再把通知挂到上面 5 个监控项上
（建监控项时 Notification 栏勾选，或在通知设置里选 Apply to existing monitors）。

## 服务器同步步骤（在服务器 `/opt/aster-pulse` 上执行）

前置：本分支 `feat/monitoring` 已推到 GitHub，服务器上按下面步骤同步。
**不要在服务器上重跑 `bash deploy.sh`**——它第 5 步会 `cp nginx.conf` 覆盖
Certbot 改过的 Nginx 配置（证书配置会丢），且第 3 步会重建全部容器。

```bash
cd /opt/aster-pulse
git fetch origin
git checkout feat/monitoring
git log --oneline -1          # 确认是本分支的提交号

# 1. 只拉起 Kuma（不动正在跑的 aster-pulse 容器）
docker compose pull uptime-kuma
docker compose up -d uptime-kuma
docker compose ps             # uptime-kuma 应为 running
curl -s http://127.0.0.1:3001/ | head -c 200   # 本机能拿到 Kuma 首页 HTML

# 2. Nginx：不要 cp 覆盖！把仓库 nginx.conf 里新增的三段 location
#    （/status/、/assets/、/socket.io/，带注释的那一大段）手工加到
#    服务器 /etc/nginx/sites-available/buildaster.xyz 的 server 块里，
#    放在 location / 之前；证书相关（ssl_certificate 等）一行都不要动。
sudo nginx -t && sudo systemctl reload nginx

# 3. 本机验收应用没受影响
bash scripts/check-local.sh

# 4. 公网验收
curl -s -o /dev/null -w "%{http_code}\n" https://buildaster.xyz/status/aster-pulse
```

## Kuma 首次打开（建管理员账号）

Kuma 没有默认账号，第一次打开必须建管理员：

1. Kuma 只绑了 `127.0.0.1`，公网打不开管理后台（这是故意的），
   用 SSH 隧道：本机执行 `ssh -L 3001:127.0.0.1:3001 <用户>@<服务器IP>`，
   然后浏览器打开 `http://localhost:3001`。
2. 首次打开是创建管理员页面：设用户名 + 密码（强密码，只记在自己手里，**不要写进仓库**），
   语言选 English 或中文均可。
3. 按上面“监控项清单”建 5 个监控项（Add New Monitor → Monitor Type 选 HTTP(s)，
   URL、Interval、Timeout 按表填；1、2 号加 Keyword；5 号 Interval 300、Timeout 120）。
4. 建状态页：Status Pages → New Status Page，Slug 填 `aster-pulse`，
   把 5 个监控项全加进去，Published 打开，不设密码，保存。
5. 打开 `https://buildaster.xyz/status/aster-pulse`，确认 5 个监控项都显示 UP，
   再等一两个检查周期，看状态页实时数据能刷出来（socket.io 通了才有实时更新）。
6. 接通知：按上面“告警通知渠道”配 Telegram 或 SMTP，点 Test 收到消息后挂到监控项上。

## 日常运维

```bash
docker compose ps                  # 看 kuma 和 aster-pulse 是否 running
docker compose logs -f uptime-kuma # 看 Kuma 日志
docker compose restart uptime-kuma # 重启 Kuma（数据在卷里，不会丢）
docker compose up -d uptime-kuma   # 改了 compose 文件后应用
```

- 数据备份：`./data/uptime-kuma/kuma.db` 是 SQLite 单文件，拷走就是备份；
  升级/重建前先拷一份。
- 不要删 `./data/uptime-kuma/`，删了监控历史、账号、状态页配置全丢。
- `.gitignore` 已加 `data/uptime-kuma/`，数据库不会被误提交进仓库。

## 已知限制

- 管理后台不走公网，只能 SSH 隧道访问；换电脑管理要重新开隧道。
- `location /assets/` 会接管站内所有 `/assets/*` 请求（Kuma 前端资源用），
  目前站内只有精确匹配的 `/assets/aster-logo.svg`（Nginx 精确匹配优先，仍走 Node），
  今后不要再往 `/assets/` 下加别的站内文件，否则会被 Kuma 抢走返回 404。
- 状态页 favicon 可能 404（Kuma 的 `/icon.svg` 没单独反代），不影响使用，纯外观问题。
- Kuma 监控的是公网链路（含 Cloudflare DNS 与 Nginx），如果服务器本机正常但公网链路断了，
  也会报 DOWN——这是想要的行为，不是误报。
- 本地沙箱无 Docker、无 Nginx，`docker compose config` 与 Kuma 实际启动未在本地实测，
  以服务器上同步时的实测为准（见“服务器同步步骤”）。

## 改动文件

| 文件 | 改动 |
|---|---|
| `docker-compose.yml` | 新增 `uptime-kuma` 服务（镜像 `louislam/uptime-kuma:2.5.9`，`127.0.0.1:3001`，卷 `./data/uptime-kuma:/app/data`，`restart: unless-stopped`） |
| `nginx.conf` | 新增三个 `location`：`/status/`、`/assets/`、`/socket.io/`（WebSocket 头 + Host 头，证书配置未动） |
| `.env.example` | 新增通知渠道占位变量（全是空注释，无真实值） |
| `.gitignore` | 加 `data/uptime-kuma/`，防止 Kuma 数据库被误提交 |
| `MONITORING.md` | 本文档 |
| `DEPLOY.md` | 文件清单里补 MONITORING.md 一行 |
