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

## 2026-11-07 补充：/api/token-stats + 邀请链接（commit 待填）

- 新增 `GET /api/token-stats`：价格取 fapi `ticker/24hr?symbol=ASTERUSDT`（永续价，TTL 30s）；质押取 DefiLlama `api.llama.fi/protocol/aster` 的 staking 系列最新点美元值 ÷ 现价换算（TTL 300s）。实测 2026-11-07 16:24 CST：冷启动 4.37s，价格 0.6801 USDT、24h -0.57%，质押 512,064,280 ASTER（约 $348.25M，DefiLlama 快照时间 2026-11-07）；命中缓存 17ms。价格与同分钟直接 curl fapi（0.67990 / -0.556%）一致（价差为分钟内波动）。
- 质押口径说明：官方质押页 https://www.asterdex.com/zh-CN/staking 是 JS 单页，页面本身公开、无需登录，显示各验证者质押量之和；但其质押路由 JS 在本机直接拉取返回 403，官方 tapi 也无全局查询方法（实测 `aster_getValidators` → -32601 Method not found，`aster_getBalance` 的 totalStakedAmount 是按地址的个人质押）。因此质押数用 DefiLlama 换算值，接口和页面小字都写明了来源，未冒充官方数。veASTER 总量未接入（veASTER 是锁仓量×时间权重，不是代币总量，官方未公布）。
- 前端：回购卡片内新增两指标（ASTER 当前价格、 全网质押），每 30s 刷新；失败时显示旧缓存并标“缓存·更新延迟”，无缓存才显示“暂未接入”。
- 右上角“打开 Aster”按钮 href 改为 https://www.aster.finance/zh-CN/referral/6e1d28（target=_blank、rel=noopener 保留）；本地首页实测：该链接恰好 1 处，旧交易链接 0 处，其余 9 处官方链接、公告链接、官方机制链接均未动；首页 0 处 fonts.googleapis.com。
- `bash scripts/check-local.sh`（BASE=http://127.0.0.1:3100）全部通过；/api/detail?symbol=BTCUSDT 502 为原站已知行为。
- 未验证：新接口的断网 stale 回退未单独实测（与原有接口共用同一 cached()，此前已验证）；服务器上尚未同步、DNS 未切、国内访问未测。

## 2026-11-07 补充：/api/token-stats 增加累计销毁

- `GET /api/token-stats` 新增 `burned` 字段：取 CoinGecko `api/v3/coins/aster-2` 的 `market_data.total_supply`，累计销毁 = 80 亿 - 总量（TTL 300s，缓存键 `token-burned.json`，沿用 `cached()` stale 回退；失败显示旧缓存并标“缓存 · 更新延迟”，无缓存才显示“暂未接入”）。浏览器不直调 CoinGecko（免费接口有频率限制，服务端缓存 300s）。
- 实测 2026-11-07 16:54 CST（本地，冷启动 1.23s、命中缓存 11ms）：`burned` 212,693,589.36 ASTER，`totalSupply` 7,787,306,410.64，与 16:49 直接查 CoinGecko 的数一致；价格 0.6805、质押 511,763,287 同接口返回正常。页面小字写明“CoinGecko 总量反推（80亿-总量）”，`burnedSource` 注明销毁地址 0x000000000000000000000000000000000000dEaD（BNB 链）。
- 前端：回购卡片 token-stats 区由 2 指标改为 3 指标（价格 / 全网质押 / 累计销毁，显示 2.13 亿 ASTER）；回购脚注（#buy-note）与分享图片里的“累计销毁：尚未接入”占位已替换为真实数；失败回退与旧缓存逻辑与价格/质押一致。首页仅剩的一处“尚未接入”是社区热度区“尚未接入 X 搜索 API”，与销毁无关，未动。
- 口径：只显示“全部项目累计销毁”一个主数。升级后（6/17 起）累计 34,912,404.82 与最新周期 10/19–11/02 回购+销毁各 2,604,529.88 只写在注释/文档里，不在页面并列，避免混淆。
- `bash scripts/check-local.sh`（BASE=http://127.0.0.1:3101）全部通过；/api/detail?symbol=BTCUSDT 502 为原站已知行为。

## 2026-11-07 补充：/api/community 社区热度（X API v2，真密钥联调）

测试方式：Node v24.22.1，`PORT=3105/3106 HOST=127.0.0.1`，独立 CACHE_DIR。
真实搜索调用共 2 次（helper 1 次 + 本站接口上游 1 次，按次计费约 $0.005/条，
19 条 ≈ $0.10；其余全部命中缓存或走无密钥路径，未产生 X 费用）。
密钥未以任何形式打印、记录或写入仓库：本站联调用的凭证是连接器 `custom.x`
的 `hsurr:` 替身，由本机 Sentinel 在出口到已注册主机 `api.x.com` 时替换，
只通过子进程环境变量传给 `node server.js`，测完即删启动脚本，进程已停。

### 功课：端点与限额（查于 2026-11-07）

- 端点 `GET https://api.x.com/2/tweets/search/recent`，`Authorization: Bearer <token>`；
  `query`（必填）、`max_results` 只能 10–100、默认只返回 `id`/`text`，
  作者名/时间/互动数靠 `tweet.fields=created_at,author_id,public_metrics` +
  `expansions=author_id` + `user.fields=username,name` 另外要来；只返回最近 7 天。
  以上除限额数字外，均经本次真机调用证实。
- 限额数字未能在官方文档页直读核对：`docs.x.com` / `developer.x.com`
  在本沙箱打不开（域名被拦截），以下来自 2026 年多家公开资料交叉核对，
  各来源说法不一，以开发者后台实际显示为准：
  - 2026 年 2 月 6 日起新开发者默认按次计费（Pay Per Use）：读约 $0.005/条，
    月上限 200 万条（另有 2026 年 10 月的公开资料称已提到 300 万条）；
    旧包月档 Basic $200/月、Pro $5,000/月已不对新用户开放，仅老用户保留。
  - 各来源对旧 Basic 档 recent search 的 15 分钟限额说法不一（15–450 次），
    月度上限约 10,000–15,000（按请求计还是按返回条数计，说法也不一致）。
- TTL 定为 1800s（30 分钟，比任务示例的 15 分钟更保守）：上游请求上限为
  每小时 2 次、每天 48 次、每月约 1,440 次，每次最多返回 10 条，
  即每月最多约 14,400 条，理论费用上限约 $72/月（14,400 × $0.005，
  实际按返回条数计）；即使按最严的旧 Basic 月度 10,000 条口径，
  也只在每次都满 10 条的忙月才可能接近，需看开发者后台用量。
  想调频率只改 `app/worker.js` 里 `community.json` 的 TTL（1800000 毫秒）
  与 `server.js`、`reference/client.js` 里的 1800s 刷新间隔，不要低于 300s。

### 接口实测

| 检查 | 状态 | 耗时 | 备注 |
|---|---|---|---|
| helper 搜 `ASTER` 10 条（`x_search.py ASTER 10`） | 200 | 684ms | `returned` 10，`meta.result_count` 10，`next_token` 有；最新一条 2026-11-07T15:16:49Z，id 2119086676538753213 |
| `GET /api/community`（无密钥） | 200 | <20ms | `available:false`，`tweets:[]`，不调上游、不写缓存 |
| `GET /api/community`（真密钥，首次，上游） | 200 | <1s | `available:true`，`stale:false`，返回 9 条（X 只给了 9 条，`max_results=10` 是上限不是保证）；首条 @dokkjya 2026-11-07T15:15:19Z，末条 @Panoramafm_do 15:09:19Z；9 条全部有 `https://x.com/<用户>/status/<id>` 链接；`query` 为 `($ASTER OR ASTER) -is:retweet`，`windowDays` 7 |
| `GET /api/community`（第二次，缓存命中） | 200 | 2ms | `updatedAt` 与首次完全相同（1794064657287），未产生新的上游调用；`community.json` 落盘 3,552 字节 |
| stale 回退（缓存 `updatedAt` 手动改旧 3600s + 上游地址改死 `http://127.0.0.1:9`） | 200 | 8ms | `stale:true`，同样 9 条旧推文（首条 id 与 live 一致），`error: fetch failed`；后台刷新日志 `community 200 stale=true 3ms` |
| `GET /`（无密钥服务） | 200 | 26ms | 21,654 字节，含 `#community-list` 与 `#community-status` 新容器；首页 0 处 `fonts.googleapis.com` |
| `GET /client.js`（无密钥服务） | 200 | 18ms | 22,035 字节，含 `loadCommunity`/`renderCommunity`；内嵌 CLIENT 与 `reference/client.js` 用 Node 求值 + diff 核对，逐字节一致 |
| `bash scripts/check-local.sh`（BASE=http://127.0.0.1:3105，无密钥） | 全部通过 | 约 16s | `GET /api/community` 200、18ms、169 字节（`available:false`）；其余接口同前：markets 21ms、buyback 首次 10,238ms、缓存后 17ms；`/api/detail?symbol=BTCUSDT` 502 为原站已知行为；404 预期 |

### 已知口径问题（不是 bug，是查询本身的口径）

- 裸关键词 `ASTER` 也会命中紫苑花、导演 Ari Aster 等无关推文，本次 9 条里
  就有 2 条园艺问答（“a late-planted aster”）和 1 条 “What is Ari Aster cooking???”；
  `$ASTER` 的推文（如 “$ASTER ran 3.7x”）在主题内。任务定的关键词就是
  `$ASTER / ASTER`，本站按此实现、不做内容筛选、不编推文；想收紧可在
  `app/worker.js` 的 `community()` 查询里改（例如只留 `$ASTER`），改完重测。

### 未验证

1. **浏览器内渲染**：子代理无 live browser，只验了服务端 HTML/JS 下发内容
   （新容器、`loadCommunity` 存在）与 `node --check`；推文列表在真实浏览器里
   的渲染、点击跳转、30 分钟刷新节奏需上线后肉眼确认。
2. **生产服务器**：未动服务器、DNS、`deploy.sh`；服务器 `.env` 配
   `X_BEARER_TOKEN` + 重启 + 线上 `/api/community` 实测待部署时做。
3. **X 开发者后台用量/账单**：未打开后台核对本次 2 次调用的计费与剩余额度；
   上面费用数字是按公开单价算的理论值，以后台为准。
4. **真机移动端**：未验。
