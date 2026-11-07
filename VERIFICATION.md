# 本地实测记录（2026-11-07，Node v24.22.1）

测试方式：`PORT=3000 HOST=127.0.0.1 CACHE_DIR=/tmp/aster-test-cache node server.js`，
全部请求走真实 Aster 上游（fapi/www/tapi.asterdex.com），非 mock。
原站自带检查另跑：`node scripts/check.mjs`、`node scripts/rank-check.mjs`。

## 接口实测（冷/热均已测）

| 接口 | 状态 | 耗时 | 备注 |
|---|---|---|---|
| `GET /` | 200 | 2–3ms（缓存后） | 20,268 字节；已无 `fonts.googleapis.com`，字体栈为系统字体 |
| `GET /client.js` | 200 | 1–15ms | 17,957 字节，与线上一致 |
| `GET /assets/aster-logo.svg` | 200 | 1–15ms | 4,803 字节 |
| `GET /api/health` | 200 | <1ms | 新增接口；返回缓存文件数、最近刷新状态 |
| `GET /api/markets` | 200 | 冷 1.4s / 热 3–20ms | 606 行，`stale:false`；后台预热 1,404ms |
| `GET /api/announcements` | 200 | 冷 4.4s / 热 2ms | 15 条内，第一条 XTEN 上新 |
| `GET /api/activities` | 200 | 冷 0.2s / 热 2ms | 活动公告正常 |
| `GET /api/market-detail?symbol=BTCUSDT` | 200 | 冷 0.59s / 热 — | price 76053.7，未平仓量正常 |
| `GET /api/detail?symbol=XTENUSDT` | 200 | 0.92s | peak 11.69%、now -12.82%，与线上站逐字段一致（仅 updatedAt 不同） |
| `GET /api/detail?symbol=BTCUSDT` | 502 | 1.1–1.3s | 原站逻辑，见下 |
| `GET /api/detail?symbol=BAD!SYM` | 502 | 2ms | `币种参数无效`，原站校验 |
| `GET /api/buyback` 首次（后台预热） | 200 | 7,950ms | 7 天，2026-11-01 至 11-07 |
| `GET /api/buyback` 冷启动（删缓存后） | 200 | 9,751ms | 3 个并发同时请求，共享一次计算，各 9.75s 全部 200 |
| `GET /api/buyback` 命中缓存 | 200 | 1–18ms | 7 天数据完整，钱包 0xa0ed…1b60 |
| `POST /api/refresh`（无 token） | 405 | 1ms | 公开入口已关闭，符合设计 |
| `GET /no-such-page` | 404 | 1ms | 原站行为 |

## 专项验证

- **stale 回退**（mock 上游断网 + 磁盘旧缓存）：过期 `market-v3.json`（updatedAt=1）
  返回 200 `stale:true` + 旧数据；无缓存 + 断网返回 502。PASS。
- **并发去重**：3 个并发冷 buyback 只触发一次上游计算（日志中一次 9,750ms），
  其余两个共享结果。PASS。
- **字体**：首页 `grep fonts.googleapis.com` 为 0 处，系统字体栈已生效。PASS。
- **原站检查脚本**：`check.mjs` PASS（买入排除卖出、7 天聚合、stale 回退）；
  `rank-check.mjs` PASS（100k 阈值、6 月 1 日截断等）。原站逻辑未动。
- **验收脚本**：`bash scripts/check-local.sh` 最终输出“全部通过”。
- **磁盘缓存**：`data/cache` 落盘 7 个文件（market-v3、symbols、announcements、
  activities、buyback、market-detail-BTCUSDT、detail-v2-XTENUSDT），原子写无损坏。
- **原站入口完整性**：`app/worker.js` SHA256 与原 zip 的 `worker/index.js` 一致
  （`c5f4a56b…09d9`）。

## `/api/detail?symbol=BTCUSDT` 502 的说明（不是部署问题）

原站 `detail()` 要求首日 K 线时间必须等于合约上线日，BTC 等老币种 K 线起点晚于
上线日，校验失败抛错。已对照线上站：`https://buildaster.xyz/api/detail?symbol=BTCUSDT`
同样返回 502、同一条错误信息、同样约 1.3s；`XTENUSDT` 线上与本地逐字段一致。
前端点老币种详情会显示该报错，是原站行为，本包未改。

## 未验证（需在香港服务器上验证）

1. **Docker 镜像构建**：本机无 Docker，`Dockerfile` / `docker-compose.yml` 未构建过；
   由服务器上 `deploy.sh` 的 `docker compose up -d --build` 验证。
2. **Nginx 配置语法与反代**：本机无 Nginx，`nginx.conf` 未跑过 `nginx -t`；
   由服务器上 `deploy.sh` 的 `nginx -t` 验证；`/api/` 180s 超时、HTTPS 待 Certbot 后验证。
3. **systemd 方式**：本机未跑 `aster-pulse.service`，只写了单元文件；用 Docker 方式
   可不验证此项。
4. **国内三网访问**：本地是海外出口，只能验证“服务器能拉到上游、接口正常”；
   国内打开速度、是否还需翻墙，必须等 DNS 切到香港服务器后实测。
5. **长时间运行**：后台刷新只观察了约 2 分钟（markets/announcements/activities 各刷
   2 次成功，buyback 1 次成功）；24 小时稳定性、缓存文件增长、磁盘占用待上线后观察。
6. **Certbot HTTPS**：需真实域名解析到服务器后才能签发，本地无法验证。
