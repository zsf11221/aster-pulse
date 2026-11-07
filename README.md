# Aster Pulse — buildaster.xyz

Aster 社区观察站：上新、价格表现、社区热度与每日回购。
线上域名：`buildaster.xyz`，目前从 Codex 托管迁移到香港服务器（阿里云轻量，中国香港，免备案）。

## 唯一生效的源码在哪里（别改错地方）

这个仓库里只有一份会真正跑起来的代码：

- **改页面文字、样式、前端交互、API 接口，都改 `app/worker.js`**。它是原站 `worker/index.js` 的复制（原始 SHA256 `c5f4a56b…09d9`，2026-11-07 导出源码包；2026-11-07 起已改动：新增 `GET /api/token-stats`（价格 + 质押 + 累计销毁）与回购卡片指标、右上角按钮改为邀请链接，当前 SHA256 `71263f99…fa23`），HTML、CSS、前端 JS、后端接口全在这个文件里。
- **`server.js` 是香港服务器的适配层**：把原站的 `BUCKET` 缓存换成磁盘缓存、后台定时刷新、去掉 Google Fonts。平时改网站不用动它。
- **`reference/` 只是方便阅读的拆分版**（`client.js`、`backend.js`）和原包说明，改它们不会生效，运行时不读这些文件。
- **`cloudflare-worker/` 是原站的 Cloudflare Workers 适配版**，香港服务器部署不用它。

## 本地运行

```bash
node server.js
# 打开 http://127.0.0.1:3000 ，接口：/api/markets /api/announcements
# /api/activities /api/buyback /api/token-stats /api/market-detail?symbol=BTCUSDT
# /api/detail?symbol=XTENUSDT /api/health
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

CI 在 `.github/workflows/test.yml`：push 和 PR 时，先跑 `npm run check` 再跑
`npm test`，Node 20 和 22 各跑一档。

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

## 服务器

- 阿里云轻量应用服务器，中国香港，2核 2GB，Ubuntu 24.04，公网 IP：`8.218.147.34`
- 部署目录：`/opt/aster-pulse`，部署脚本：`bash deploy.sh`
- 域名 DNS 切到香港服务器之前，先在服务器本机跑 `bash scripts/check-local.sh` 验收通过。
