# Aster Pulse — buildaster.xyz

Aster 社区观察站：上新、价格表现、社区热度与每日回购。
线上域名：`buildaster.xyz`，目前从 Codex 托管迁移到香港服务器（阿里云轻量，中国香港，免备案）。

## 唯一生效的源码在哪里（别改错地方）

这个仓库里只有一份会真正跑起来的代码：

- **改页面文字、样式、前端交互、API 接口，都改 `app/worker.js`**。它是原站 `worker/index.js` 的复制（原始 SHA256 `c5f4a56b…09d9`，2026-11-07 导出源码包；2026-11-07 起已改动：新增 `GET /api/token-stats`（价格 + 质押 + 累计销毁）与回购卡片指标、右上角按钮改为邀请链接；2026-11-07 新增 `GET /api/community`（X API v2 社区热度）；2026-11-08 新增 `GET /api/daily-brief`（每日异动日报）与分享图自定义（模板/尺寸/内容开关/自定义一句话/水印）；2026-11-09 每日异动第二轮改版（改名每日异动、去掉日报分享、异动不含 ASTER 内容、前 3 名开单思路、分享图精简为模板/回购开关/自定义一句话），当前 SHA256 `dd6d91d5…18e95`），HTML、CSS、前端 JS、后端接口全在这个文件里。
- **`server.js` 是香港服务器的适配层**：把原站的 `BUCKET` 缓存换成磁盘缓存、后台定时刷新、去掉 Google Fonts。平时改网站不用动它。
- **`reference/` 只是方便阅读的拆分版**（`client.js`、`backend.js`）和原包说明，改它们不会生效，运行时不读这些文件。
- **`cloudflare-worker/` 是原站的 Cloudflare Workers 适配版**，香港服务器部署不用它。

## 本地运行

```bash
node server.js
# 打开 http://127.0.0.1:3000 ，接口：/api/markets /api/announcements
# /api/activities /api/buyback /api/token-stats /api/market-detail?symbol=BTCUSDT
# /api/detail?symbol=XTENUSDT /api/health /api/community /api/daily-brief
```

详细部署步骤、路由表、缓存时间、本地实测记录见 [DEPLOY.md](DEPLOY.md) 和 [VERIFICATION.md](VERIFICATION.md)。

## 中英文切换

右上角有个 中文 / EN 切换按钮，默认中文。切换存在浏览器 localStorage
（`aster-pulse-lang`），刷新后保持选择。切换只改前端文案：静态 HTML 文案
（`data-i18n` / `data-i18n-html` / `data-i18n-ph` / `data-i18n-aria` /
`data-i18n-alt` 属性）+ CLIENT 动态文案 + 分享图片画布文字；日期按语言换
locale（zh-CN / en-US，时区仍为 Asia/Shanghai）。数字、价格、链接、邀请链接
不变，`server.js` 与接口行为不动。翻译表在 CLIENT 开头的 `I18N` 对象里
（zh/en 各 259 条），`reference/client.js` 与内嵌 CLIENT 逐字节一致。
切换后已打开的详情弹窗下次打开时才换语言（弹窗内容不重渲染）。

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

CI 配置在 main 的 `.github/workflows/test.yml`（push 和 PR 时先跑 `npm run check` 再跑 `npm test`，Node 20 和 22 各一档），2026-11-07 重新授权拿到 `workflow` 权限后已推上 main。

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
- **热度排序与收起**：推文按热度（点赞 + 转推 + 回复）降序排，时间相同则新的在前；默认只显示前 5 条，超过 5 条时下面出现“展开更多（还有 n 条）”，点开显示全部、再点“收起”。
- **官方兜底**：搜索结果少于 3 条时，服务端再调一次 `from:Aster_DEX -is:retweet`（最多 5 条），取最新 3 条未收录的官方推文补进来、带“官方”标记（`official:true`，响应里 `officialAdded` 为补的数量）；搜索结果够 3 条时不调这第二下，不多花配额。
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

## 每日异动

首页回购区之后、上新雷达之前，有一个“每日异动”区块：开头三句话摘要、
今日最热大卡片（一句话结论 + 信号佐证 + 异动分）、前 3 名涨幅币的开单思路、
老币观察、催化剂日历。样式沿用现有深色主题与卡片样式，不引入新配色、新字体。
异动里不放 ASTER 的内容（回购与销毁只在首页回购卡片里，催化剂日历也只放
妖币本身的事件）。

- **接口**：`GET /api/daily-brief`，TTL 300s，缓存文件 `data/cache/daily-brief.json`，
  失败时沿用旧缓存并标 `stale:true`。聚合 markets（复用其缓存）+ 前 3 名各追加查
  日内高低点与持仓量（`marketDetail`，复用其 30s 缓存）+ 资金费率
  （Aster 公开接口 `fapi/v1/premiumIndex`；失败只留空，不让整份异动失败）。
  后台每 60 秒刷一次（缓存未过期时不调上游）。
- **异动分（0–100）**：只用现有数据算，不编造 1h 数据（站上没有 1h 数据）：
  涨幅分（50）= min(50, 24h 涨幅 × 0.125)；成交额分（20）= min(20, 4 × log10(24h 成交额 ÷ 10000))；
  资金费率分（15）= min(15, |资金费率 − 0.01%| × 1000)；领先分（15）= min(15, (第一名涨幅 − 第二名涨幅) × 0.05)。
  公式写在 `app/worker.js` 的 `briefScore()` 注释里。
- **一句话结论**：服务端只给结论键，前端按语言渲染句子——资金费率 > 0.5% 为“过热，别追”；
  否则 24h 涨幅 ≥ 100% 为“放量大涨”、≥ 20% 为“涨幅居前”、其余为“今日无明显异动”。
- **开单思路（规则版，非投资建议）**：前 3 名涨幅币各 2–3 行：方向 + 参考点位
  （回踩位/突破位/止损位/目标位）+ 一句话理由。只用现有信号判断，不接 LLM、
  不新增任何 key。规则写在 `app/worker.js` 的 `briefIdea()` 注释里：
  资金费率 > 0.5% 或 24h 涨幅 ≥ 200% → 不追多（回踩位 = 日内高点 × 0.85，
  止损 = 回踩位 × 0.93，目标 = 日内高点 × 1.10）；24h 涨幅 ≥ 50%（费率正常）→
  轻仓试多（回踩位 = min(现价, 日内高点 × 0.90)，止损 = 日内低点 × 0.98，
  目标 = 日内高点 × 1.15）；24h 涨幅 ≥ 20%（费率正常）→ 观望
  （突破位 = 日内高点，止损 = 日内低点 × 0.98，目标 = 日内高点 × 1.20）；
  其余 → 暂无思路。日内高点取 `fapi/v1/ticker/24hr` 的 `highPrice`，取不到
  就省略该项点位。持仓量是单点快照、无变化趋势，只展示不参与方向判断；
  与第二名差距只影响异动分，不参与开单判断。点位按 4 位有效数字取整，
  前端注明“规则判断，仅供参考，非投资建议”。
- **老币观察**：XLM / XTZ / LTC / ZEC，从 markets 实时行里取，取不到就隐藏该行；
  “值得关注”筛选只留 24h 涨幅 ≥ 20% 的。
- **催化剂日历**：`app/worker.js` 里 `BRIEF_EVENTS` 静态数组（人工维护），
  日期过了当天（北京时间）自动隐藏；有新事件加一行，删掉数组即去掉整个日历。
  只放妖币本身的事件，不放 ASTER 回购/销毁。
- **开关与删除**：单一代志 `DAILY_BRIEF_ENABLED`，默认 true。
  关闭：服务器 `.env` 加 `DAILY_BRIEF_ENABLED=false` 后重启，接口返回 404，
  前端区块保持隐藏，其它功能不受影响。彻底删除：删掉 `app/worker.js` 里
  `BEGIN/END DAILY BRIEF` 标出的三处（HTML 区块、`<style>` 段、CLIENT 段、
  后端 `dailyBrief()` 及路由）+ `server.js` 里的代志与后台刷新行 +
  `tests/server.test.js` 里的异动测试 + `scripts/check-local.sh` 里的异动检查行 +
  本节；删完跑 `npm run check` 与 `npm test` 确认。

## 分享图自定义

回购区“分享图片 ↗”打开分享弹窗，画布只改回购快照。弹窗里可以改：

- **模板**：浅色（现有默认图，米白底 + 深蓝字）/ 深色（站内深色主题）/ 品牌金。
- **内容开关**：回购数据（关掉则图上不画三张回购卡片）。
- **自定义一句话**：输入一行文字（最多 60 字），加到图上。
- 尺寸写死默认 4:5（1080×1350）；社区热度、一句话结论、来源水印三个开关已删，
  图里也不再画社区热度、结论、水印与“独立社区观察站 · x.com/zsf11221”。
  不做自由拖拽排版。选项存在浏览器 localStorage（`aster-pulse-share-opts`），
  下次打开弹窗保持上次选择。

默认选项（浅色 + 只开回购数据）走旧绘制代码原样复现，默认图行为不变；
改了任何选项才走自适应布局。快速连点选项时绘制串行化，预览只保留最新一次选项的结果，
不会停留在旧图；三列紧凑布局里过长的回购数字自动缩小字号，不会互相重叠。删除：删掉弹窗里的设置区块 + `<style>` 里的
`SHARE CUSTOM` 段 + CLIENT 里的 `SHARE CUSTOM` 段即恢复只有默认图。

## 服务器

- 阿里云轻量应用服务器，中国香港，2核 2GB，Ubuntu 24.04，公网 IP：`8.218.147.34`
- 部署目录：`/opt/aster-pulse`，部署脚本：`bash deploy.sh`
- 域名 DNS 切到香港服务器之前，先在服务器本机跑 `bash scripts/check-local.sh` 验收通过。
