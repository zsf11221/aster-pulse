# Aster Pulse — buildaster.xyz

Aster 社区观察站：上新、价格表现、社区热度与每日回购。
线上域名：`buildaster.xyz`，目前从 Codex 托管迁移到香港服务器（阿里云轻量，中国香港，免备案）。

## 唯一生效的源码在哪里（别改错地方）

这个仓库里只有一份会真正跑起来的代码：

- **改页面文字、样式、前端交互、API 接口，都改 `app/worker.js`**。它是原站 `worker/index.js` 的复制（原始 SHA256 `c5f4a56b…09d9`，2026-11-07 导出源码包；2026-11-07 起已改动：新增 `GET /api/token-stats`（价格 + 质押 + 累计销毁）与回购卡片指标、右上角按钮改为邀请链接；2026-11-07 新增 `GET /api/community`（X API v2 社区热度），当前 SHA256 `2b7ad19d…0681`），HTML、CSS、前端 JS、后端接口全在这个文件里。
- **`server.js` 是香港服务器的适配层**：把原站的 `BUCKET` 缓存换成磁盘缓存、后台定时刷新、去掉 Google Fonts。平时改网站不用动它。
- **`reference/` 只是方便阅读的拆分版**（`client.js`、`backend.js`）和原包说明，改它们不会生效，运行时不读这些文件。
- **`cloudflare-worker/` 是原站的 Cloudflare Workers 适配版**，香港服务器部署不用它。

## 本地运行

```bash
node server.js
# 打开 http://127.0.0.1:3000 ，接口：/api/markets /api/announcements
# /api/activities /api/buyback /api/token-stats /api/market-detail?symbol=BTCUSDT
# /api/detail?symbol=XTENUSDT /api/health /api/community
```

详细部署步骤、路由表、缓存时间、本地实测记录见 [DEPLOY.md](DEPLOY.md) 和 [VERIFICATION.md](VERIFICATION.md)。

## 自动化测试与 CI

测试在 `tests/server.test.js`，用 Node 自带 test runner（`node:test`），零依赖，
不改任何应用逻辑。测试把 `server.js` 当子进程启动（临时端口 + 临时
`CACHE_DIR`，不污染仓库里的 `data/cache`），调真实上游接口断言：

- `/api/health`：服务名、uptime、缓存目录等字段
- `/`：首页 200 且不含 Google Fonts
- `/api/markets`：`rows` 数组结构、每行 symbol/price/change24 类型
- `/api/token-stats`：price / staked / burned 三个字段存在与类型、stale 标记逻辑
- `/api/buyback`：7 天统计结构（day/qty/spent/count）
- `/api/detail?symbol=BTCUSDT`：返回 502 是原站已知行为（老币种首日 K 线缺失），
  测试只断言它符合已知行为，不当成失败
- `POST /api/refresh`：无 token 时返回 405

断言只认结构不认数字：不断言具体价格、质押量或销毁量，只断言状态码 200、
JSON 结构、关键字段存在与类型、stale 逻辑；上游波动不会导致误报。
buyback 冷启动要调 7 天分段成交，单测超时放宽到 180 秒。

```bash
npm run check   # 语法检查
npm test        # 跑全部接口测试
```

CI 配置在 `feat/tests-ci` 分支的 `.github/workflows/test.yml`（push 和 PR 时先跑 `npm run check` 再跑 `npm test`，Node 20 和 22 各一档），因当前 GitHub 授权没有 `workflow` 权限、推不上去，暂未进 main，待有 workflow 权限的账号推送后生效；测试本身本地已可跑。

## 在 Codex 里改完，怎么同步（标准流程）

1. 在 Codex 里打开这个仓库（`zsf11221/aster-pulse`），改 `app/worker.js`（或 `server.js`，只在需要改适配层时）。
2. 在 Codex 里提交并 push 到 GitHub 的 `main` 分支。
3. 到香港服务器上同步（Workbench 终端或 SSH）：
   ```bash
   cd /opt/aster-pulse && git pull
   sudo docker compose restart   # Docker 方式；systemd 方式用 sudo systemctl restart aster-pulse
   bash scripts/check-local.sh   # 本机验收，通过后再看线上
   ```
4. 只改文案/样式也要走上面这套流程，不要直接在服务器上改文件——服务器上改的没有版本记录，改坏了没法回退，下次 `git pull` 还会冲突。

注意：Codex 那边如果现在是一个独立项目、没有连这个仓库，需要先在 Codex 里导入/打开 `zsf11221/aster-pulse` 这个仓库，再改；否则它改的是另一份代码，推不到这里来。

## 数据来源

行情、公告、活动、回购全部实时拉 Aster 官方公开接口（`fapi.asterdex.com`、`www.asterdex.com`、`tapi.asterdex.com`），本站不自己编数据。官方多久没发新公告，站上就多久没新内容——比如 2026-11-07 查的时候，最新上新公告还是 2026-10-27 的 $XTEN，最新活动还是 2026-10-26 的网格挖矿升级，那是 Aster 官方没发新的，不是本站缓存卡住了。页面上显示的“更新时间”是本站最后一次去官方拉数据的时间。

## 社区热度（X API v2）

首页“社区热度”区展示 X 上最近的 Aster 相关推文，服务端调 X 官方 API v2
搜索最近推文端点，浏览器不直接调 X（密钥不出服务器）。

- **接口**：`GET /api/community`，返回 `{available, tweets[], query, windowDays: 7, stale, updatedAt}`；
  每条推文含作者（`name` / `@username`）、时间、正文、点赞/转推数和跳转 `x.com` 的链接。
- **上游调用**：`GET https://api.x.com/2/tweets/search/recent?query=$ASTER -is:retweet&max_results=10&tweet.fields=created_at,author_id,public_metrics&expansions=author_id&user.fields=username,name`，
  请求头 `Authorization: Bearer <X_BEARER_TOKEN>`。默认只返回 `id`/`text`，
  作者名、时间、互动数都是靠 `tweet.fields` / `expansions` / `user.fields` 另外要来的。
  该端点只返回最近 7 天内的推文；`max_results` 只能取 10–100，本站取最小值 10。
- **查询**：`$ASTER -is:retweet`（只搜 $ASTER 话题标签，排除转推，
  不限语言，中英文都可展示；不做内容筛选，不编推文）。
- **缓存与限额**：服务端缓存 TTL 1800s（30 分钟），缓存文件 `data/cache/community.json`；
  前端每 1800s 刷新一次，后台每 1800s 刷一次。缓存未过期时不调上游，
  上游请求上限为每小时 2 次、每天 48 次、每月约 1,440 次，每次最多返回 10 条，
  即每月最多约 14,400 条。限额口径（以下数字未能在官方文档页直读核对，
  见 VERIFICATION.md 的说明，以开发者后台实际显示为准）：
  - 2026 年 2 月起新开发者默认按次计费（Pay Per Use）：读约 $0.005/条，
    月上限 200 万条（另有 2026 年 10 月的公开资料称上限已提到 300 万条）；
    按本站的调用量算，理论上限约 $72/月（14,400 条 × $0.005，实际按返回条数计）。
  - 旧的包月档（Basic $200/月、Pro $5,000/月）已不对新用户开放，仅老用户保留；
    各公开来源对 Basic 档 recent search 的 15 分钟限额说法不一（15–450 次），
    月度上限约 10,000–15,000 条（按请求计还是按返回条数计，各来源说法也不一致）。
    若账号是旧 Basic 档且按条数计费，忙月可能接近上限，请看开发者后台用量，
    不够时把 `app/worker.js` 里 `community.json` 的 TTL（1800000 毫秒）调大即可。
  - 2026-11-07 已用真实密钥联调通过（见 VERIFICATION.md）：连接器 `custom.x` 的
    helper 搜 `ASTER` 返回 10 条（`meta.result_count` 10）；本站 `/api/community`
    用生产同款查询 `($ASTER OR ASTER) -is:retweet` 返回 9 条（2026-11-07 23:35 用户决定收紧为只搜 `$ASTER`），作者、时间、
    正文、x.com 链接齐全，命中缓存后 2ms。TTL 取 1800s 而不是 15 分钟，
    是更保守的选择（费用上限减半）；想更频繁可把 TTL 改小，但不要低于 300s。
- **配置**：密钥只从环境变量 `X_BEARER_TOKEN` 读（`server.js` 传给 `worker.fetch` 的
  `env`）。服务器上在 `/opt/aster-pulse/.env` 里加一行
  `X_BEARER_TOKEN=...`（`.env` 不进 git，见 `.env.example`），然后
  `sudo docker compose up -d`（或 `sudo systemctl restart aster-pulse`）重启生效；
  本地跑 `X_BEARER_TOKEN=... node server.js`。`docker-compose.yml` 已接好该变量。
- **失败时表现**：没配密钥时接口返回 `available:false`，前端显示“暂未接入 X 搜索 API”，
  其余功能不受影响；上游失败（限流 429、鉴权失败、断网）时返回旧缓存并标 `stale:true`，
  前端显示旧推文并标“缓存 · 更新延迟”；无旧缓存才返回 502，前端显示“暂未接入”。
  429 会在报错里注明“限流，稍后重试”，401/403 注明“鉴权失败，请检查 X_BEARER_TOKEN 与套餐权限”。
- **联调状态**：已用真实密钥联调通过（2026-11-07，见 VERIFICATION.md）。
  服务器上配好 `X_BEARER_TOKEN` 后重启即生效，不用改代码；
  可先看 `/api/health` 里 `community` 的刷新状态，再看首页社区热度区。
  注意：裸关键词 `ASTER` 也会命中紫苑花、导演 Ari Aster 等无关推文，
  这是查询本身的口径，不是本站编造；想收紧可在 `app/worker.js` 的
  `community()` 查询里改（例如只留 `$ASTER`），改完重测。

## 服务器

- 阿里云轻量应用服务器，中国香港，2核 2GB，Ubuntu 24.04，公网 IP：`8.218.147.34`
- 部署目录：`/opt/aster-pulse`，部署脚本：`bash deploy.sh`
- 域名 DNS 切到香港服务器之前，先在服务器本机跑 `bash scripts/check-local.sh` 验收通过。
