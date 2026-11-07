# Aster Pulse 网站完整源码包

导出日期：2026-11-07。对应已恢复源码版本：966d219200e4aa0163be0137aaad276f23073ee7。
原域名：buildaster.xyz。本文件包不会修改线上网站或域名解析。

## 文件内容
- original-site/：原站完整源码、页面、样式、前端脚本、Logo、后端接口、构建产物和检查脚本。
- original-site/worker/index.js：原站运行入口，内嵌 HTML、CSS、前端 JavaScript 和 Logo，不能当成普通静态 HTML 直接双击运行。
- original-site/worker/client.js、backend.js：拆分的前端与后端源码；实际运行入口以 index.js 为准。
- cloudflare-worker/：已准备的独立 Cloudflare Workers 适配版，使用 ASTER_CACHE KV，保留原站功能，并提供每小时定时更新入口。
- SHA256SUMS.txt：包内文件校验值。

## 原站部署
原站是 Worker 运行时应用，使用 BUCKET 对象存储绑定。构建命令：在 original-site 目录执行 bash scripts/build.sh。
入口为 dist/server/index.js。具体原托管配置见 .openai/hosting.json。

## Cloudflare Workers 部署
1. 创建 Workers KV 命名空间。
2. 修改 wrangler.jsonc 的 REPLACE_WITH_YOUR_KV_NAMESPACE_ID，填入自己的命名空间 ID；绑定名称必须为 ASTER_CACHE。
3. 将 worker.js 部署为 Worker；也可在控制台粘贴文件内容，并配置同名 KV 绑定。
4. 设置 Cron：5 * * * *（每小时第 5 分钟，UTC）。
5. /api/health 检查缓存绑定；定时执行状态保存在 KV 的 schedule-status.json。
此版关闭公开 /api/refresh 写入口，由定时任务更新。

## 香港 Linux 服务器迁移注意
此包提供完整现有网站源码，并非已完成适配的 Ubuntu 一键安装包。
迁移到 Linux 需实现 Worker 请求处理与 Node.js 等服务运行时的衔接，将 BUCKET 对象存储适配为磁盘或对象存储，并配置后台定时刷新、服务守护与 HTTPS。
不要仅把 dist 上传给 Nginx 后当作纯静态站使用，否则动态接口、更新和回购监控不会工作。
需先验证新服务器全部接口与大陆访问，再将 buildaster.xyz 的 DNS 指向新服务器。

## 数据与限制
行情、公告、活动及回购数据实时请求 Aster 上游公开接口，包内不含线上对象存储/KV 的历史缓存快照。
回购统计来自公开钱包 BUY 成交记录，不等于链上销毁；上游账户隐私设置或接口不可用会影响该模块。
回购钱包：0xa0edBaBcb48034e368de286b49F9603C7AfA1b60。
迁移不会自动消除上游接口限制，也不保证任意运营商网络可用。
本包未包含密码、SSH 私钥、API 密钥或账户登录凭据。部署仍需自行配置托管账户、存储和域名。

## 本地逻辑检查
需要支持原生 fetch 的 Node.js，在 original-site 目录执行：
node scripts/check.mjs
node scripts/rank-check.mjs
这些检查使用模拟数据，不代表新服务器线上验收通过。
