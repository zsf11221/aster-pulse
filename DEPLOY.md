# Aster Pulse — 香港服务器部署包

目标：把 `buildaster.xyz`（Aster Pulse）从 Codex 托管迁到香港 Linux 服务器，
国内用户不用翻墙打开，数据照常更新。免备案，DNS 不动线上之前先在服务器本机验完。

来源：用户提供的源码 zip（`workspace/user/files/Aster-Pulse-.zip`，导出 2026-11-07，
对应源码版本 966d219200e4aa0163be0137aaad276f23073ee7）。
`app/worker.js` 是原站入口 `original-site/worker/index.js` 的复制，
原始 SHA256 `c5f4a56ba88b57fa6945bb41eceefd6a08869abc16a99da00821d40e81d0b9d9`。
2026-11-07 起已改动：新增 `GET /api/token-stats`（价格 + 全网质押 + 累计销毁）与回购卡片前端指标、
右上角“打开 Aster”按钮改为邀请链接；当前 SHA256 `71263f993638b9b0f4801488111ec1fa40ac97c593b36991394c33e90b76fa23`。

## 原站结构（已读完源码确认）

原站不是纯静态站，是 Worker 运行时应用：HTML/CSS/前端 JS/Logo 全内嵌在
`worker/index.js` 里，后端接口用 `env.BUCKET`（对象存储）做缓存。
**不要只把 dist 丢给 Nginx 当静态站，否则动态接口不工作**（原包 README 原话）。

| 路由 | 说明 | 缓存 TTL | 缓存文件 |
|---|---|---|---|
| `GET /` | 首页 HTML | — | — |
| `GET /client.js` | 前端 JS | — | — |
| `GET /assets/aster-logo.svg` | Logo | — | — |
| `GET /api/markets` | 全部 USDT 合约行情（606 个，实测） | 30s | `market-v3.json` + `symbols.json` |
| `GET /api/announcements` | 上新公告 NEW_LISTING | 60s | `announcements.json` |
| `GET /api/activities` | 活动公告 ACTIVITY | 60s | `activities.json` |
| `GET /api/buyback` | 近 7 日回购成交统计 | 300s | `buyback.json` |
| `GET /api/token-stats` | ASTER 当前价（永续）+ 全网质押（DefiLlama TVL ÷ 现价换算）+ 累计销毁（CoinGecko 总量反推，80亿-总量） | 价格 30s / 质押 300s / 销毁 300s | `token-price.json` + `token-staked.json` + `token-burned.json` |
| `GET /api/market-detail?symbol=` | 单币行情 + 未平仓量 | 30s | `market-detail-<symbol>.json` |
| `GET /api/detail?symbol=` | 单币开盘价/最高价/涨幅（日 K） | 300s | `detail-v2-<symbol>.json` |
| `POST /api/refresh` | 原站公开刷新；本包默认禁用，见下 | — | — |
| `GET /api/health` | 本包新增（Cloudflare 版同名接口的平替） | — | — |

上游：`fapi.asterdex.com`（行情/K 线）、`www.asterdex.com`（公告）、
`tapi.asterdex.com`（回购钱包 `0xa0edBaBcb48034e368de286b49F9603C7AfA1b60` 的成交）。
回购钱包、口径、缓存 TTL 全部沿用原站，未改业务逻辑。

## 本包相对原站改了什么（只改适配层，不改业务）

1. **`server.js`（Node 适配层，零依赖，Node >= 20）**：把 `env.BUCKET` 换成磁盘文件
   缓存 `data/cache/*.json`（原子写：临时文件 + rename），保留原站 `cached()` 的
   stale 回退逻辑——上游失败时返回旧缓存并标 `stale:true`，无旧缓存才 502。
   另加：后台定时刷新（每 60s 刷 markets/announcements/activities，每 300s 刷
   buyback，代替 Cloudflare Cron）、同接口并发去重（buyback 一次计算要调 7 天
   成交，多个并发只算一次）、`/api/health`。
2. **Google Fonts 已去掉**：原 HTML 有 `@import url('https://fonts.googleapis.com/...DM+Sans...')`，
   国内打不开会阻塞首屏。`server.js` 在返回首页时删掉这行，并把字体栈换成
   `system-ui,-apple-system,"Segoe UI",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`。
   首页不再发任何境外字体请求（已实测验证）。
3. **`POST /api/refresh` 默认关闭公开调用**：原站是公开的，任何人都能触发一次全量
   上游拉取（含最贵的 buyback）。本包没配 `REFRESH_TOKEN` 时一律返回 405，
   刷新由服务器后台定时任务做。配了 token 后：
   `curl -X POST -H "x-refresh-token: <token>" http://127.0.0.1:3000/api/refresh`。
4. **守护二选一**：Docker（`Dockerfile` + `docker-compose.yml`，推荐）或
   systemd（`aster-pulse.service`，不用 Docker 时用）。

## 文件清单

| 文件 | 用途 |
|---|---|
| `server.js` | Node 适配层（入口，`node server.js`） |
| `app/worker.js` | 原站入口，原样复制，未改动 |
| `app/backend.js` | 原站拆分版后端源码，仅参考 |
| `package.json` | `npm start` / `npm run check`（零依赖） |
| `Dockerfile` | Node 20 Alpine 镜像 |
| `docker-compose.yml` | 容器 + `127.0.0.1:3000` + `./data` 挂载 + 健康检查 |
| `nginx.conf` | Nginx：`/` 与 `/api/` 反代到 Node，`/api/` 超时 180s |
| `aster-pulse.service` | systemd 单元（不用 Docker 时用） |
| `deploy.sh` | 服务器一键部署脚本（Docker 或 `MODE=systemd`） |
| `scripts/check-local.sh` | 服务器本机验收脚本 |
| `.env.example` | 环境变量模板（`PORT` / `CACHE_DIR` / `REFRESH_TOKEN`） |
| `data/cache/` | 磁盘缓存目录（空目录，运行时自动生成 `.json`） |
| `VERIFICATION.md` | 本地实测记录 |

## 在香港服务器上部署（服务器买好后执行）

前置：Ubuntu 22.04/24.04，香港轻量服务器（2 核 2G 起步即可，本站很轻）。
把本目录传到服务器，例如 `/opt/aster-pulse`：

```bash
# 1. 传包（本地执行，把 <服务器IP> 换成实际 IP）
scp -r . ubuntu@<服务器IP>:/opt/aster-pulse
```

```bash
# 2. 服务器上一键部署（Docker 方式，推荐；脚本会装 Nginx + Docker、构建启动、配 Nginx）
cd /opt/aster-pulse && bash deploy.sh

# 不用 Docker 的话：MODE=systemd bash deploy.sh
```

```bash
# 3. 本机验收（不经过公网 DNS）
bash scripts/check-local.sh
```

```bash
# 4. 上 HTTPS
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d buildaster.xyz -d www.buildaster.xyz
```

```bash
# 5. 验收全部通过后，再切 DNS：把 buildaster.xyz 的 A 记录改到本机 IP
#    改之前先把 TTL 调到 300 秒；Codex 侧先别关，出问题能马上切回去。
#    切完后电信/联通/移动各测一次打开和数据加载。
```

日常运维：

```bash
sudo docker compose logs -f            # Docker 方式看日志
sudo docker compose restart            # 重启
sudo docker compose ps                 # 健康检查状态
# systemd 方式：sudo journalctl -u aster-pulse -f / sudo systemctl restart aster-pulse
curl -s http://127.0.0.1:3000/api/health   # 看缓存文件数和最近一次后台刷新
```

## 已知行为（原站逻辑，非部署问题）

- `/api/detail?symbol=BTCUSDT` 返回 502 `上线首日K线缺失，无法确认完整历史涨幅`：
  原站要求首日 K 线必须等于上线日，BTC 等老币种 K 线起点晚于上线日，线上站同样 502。
  新上币如 `XTENUSDT` 正常返回 200。前端点老币种详情会显示该报错，是原站行为。
- `/api/buyback` 首次计算约 8–10 秒（7 天分段查成交），之后命中缓存 < 20ms。
  后台每 300 秒自动刷新，正常用户基本不会撞上冷启动；3 个并发冷请求只算一次。
- 上游 Aster 接口若不可用，接口返回旧缓存 + `stale:true`，前端会显示“缓存 · 更新延迟”，
  不会直接挂掉；没有任何缓存时才 502。

## 本地实测

见 `VERIFICATION.md`。结论：除 Docker 镜像构建与 Nginx 配置语法未在本地验
（本机无 Docker/Nginx，由服务器上的 `deploy.sh` 构建时验证，脚本内含
`docker compose up --build` 与 `nginx -t`），其余接口已全部在本地用真实上游跑通。
