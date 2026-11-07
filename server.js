// Aster Pulse — 香港 Linux 服务器 Node 适配层（零依赖，Node >= 20）
//
// 原站是 Worker 运行时应用（app/worker.js，原样复制，未改动，
// SHA256 c5f4a56ba88b57fa6945bb41eceefd6a08869abc16a99da00821d40e81d0b9d9，
// 与原 zip 包 original-site/worker/index.js 一致）。
// 本文件只做三件事：
//   1. 把 env.BUCKET（对象存储）换成磁盘文件缓存（data/cache/*.json），
//      保留原站 cached() 的 stale 回退逻辑：上游失败时返回旧缓存并标 stale:true。
//   2. 把 Worker 的 fetch(request, env) 接到 Node http server 上。
//   3. 补原站没有的东西：/api/health、后台定时刷新（代替 Cloudflare Cron）、
//      同接口并发去重（buyback 很贵，不能让 10 个并发各算一次）、
//      去掉 HTML 里的 Google Fonts（国内打不开，拖慢首屏）。
//
// 路由（全部来自 app/worker.js，见 README.md 的路由表）：
//   GET  /                              HTML 首页
//   GET  /client.js                     前端 JS
//   GET  /assets/aster-logo.svg         Logo
//   GET  /api/markets                  TTL 30s  cache market-v3.json
//   GET  /api/announcements           TTL 60s  cache announcements.json
//   GET  /api/activities              TTL 60s  cache activities.json
//   GET  /api/buyback                 TTL 300s cache buyback.json（7 天分段查成交，最慢）
//   GET  /api/token-stats             价格 TTL 30s（token-price.json）+ 质押 TTL 300s（token-staked.json）+ 销毁 TTL 300s（token-burned.json）
//   GET  /api/community              X API v2 搜索最近推文，TTL 1800s cache community.json；
//                                     没配 X_BEARER_TOKEN 时返回 available:false，不调上游
//   GET  /api/market-detail?symbol=   TTL 30s  cache market-detail-<symbol>.json
//   GET  /api/detail?symbol=          TTL 300s cache detail-v2-<symbol>.json
//   POST /api/refresh                 原站有；本机默认禁用公开调用（见下），由后台刷新代替
//   GET  /api/health                  本适配层新增（Cloudflare 版也有同名接口）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './app/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'data', 'cache'));
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || '';
const STARTED_AT = Date.now();

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 磁盘版 BUCKET：接口与 Worker 的 R2/KV 绑定一致
//   get(key) -> { json: async () => parsed } | null
//   put(key, string) -> 原子写（先写临时文件再 rename）
// ---------------------------------------------------------------------------
function safePath(key) {
  const safe = String(key).replace(/[^A-Za-z0-9._-]/g, '_');
  const p = path.resolve(CACHE_DIR, safe);
  if (!p.startsWith(CACHE_DIR + path.sep) && p !== CACHE_DIR) throw new Error('非法缓存键: ' + key);
  return p;
}
const BUCKET = {
  async get(key) {
    try {
      const text = await fs.promises.readFile(safePath(key), 'utf8');
      return { json: async () => JSON.parse(text) };
    } catch {
      return null; // 不存在或损坏都当作无缓存，原站 cached() 会走上游重算
    }
  },
  async put(key, value) {
    const file = safePath(key);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(tmp, String(value), 'utf8');
    await fs.promises.rename(tmp, file);
  },
};
// X_BEARER_TOKEN 只从环境变量读（见 .env.example），绝不写进代码或仓库；
// 没配时 community() 直接返回 available:false。X_API_BASE 仅供本地 mock 联调
// 覆盖上游地址，生产不配（默认 https://api.x.com）。
const env = { BUCKET, X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || '', X_API_BASE: process.env.X_API_BASE || '' };

// ---------------------------------------------------------------------------
// 后台刷新状态（供 /api/health 查看）
// ---------------------------------------------------------------------------
const lastRefresh = {}; // name -> { ok, status, ms, at, error? }
let refreshRunning = false;

async function refreshOne(name, urlPath) {
  const t0 = Date.now();
  try {
    const res = await worker.fetch(new Request('http://localhost' + urlPath), env, {});
    const body = await res.json().catch(() => ({}));
    lastRefresh[name] = {
      ok: res.ok && !body.stale, status: res.status,
      stale: !!body.stale, error: body.error || null,
      ms: Date.now() - t0, at: new Date().toISOString(),
    };
    console.log(`[refresh] ${name} ${res.status} stale=${!!body.stale} ${Date.now() - t0}ms${body.error ? ' error=' + body.error : ''}`);
  } catch (e) {
    lastRefresh[name] = { ok: false, status: 0, ms: Date.now() - t0, at: new Date().toISOString(), error: e.message };
    console.log(`[refresh] ${name} FAILED ${Date.now() - t0}ms ${e.message}`);
  }
}

// 每 60 秒刷快接口；buyback TTL 300s，每 300 秒刷一次（它要调 7 天成交，
// 每分钟刷一次既浪费上游配额，又容易撞上 tapi 的限流）。
async function refreshLoop() {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    await refreshOne('markets', '/api/markets');
    await refreshOne('announcements', '/api/announcements');
    await refreshOne('activities', '/api/activities');
    await refreshOne('token-stats', '/api/token-stats');
  } finally { refreshRunning = false; }
}
async function refreshBuyback() {
  if (refreshRunning) return;
  refreshRunning = true;
  try { await refreshOne('buyback', '/api/buyback'); }
  finally { refreshRunning = false; }
}
// 社区热度：TTL 1800s，后台每 1800s 刷一次（与 TTL 对齐；缓存未过期时不调上游，
// 不会多花 X API 配额）。没配 X_BEARER_TOKEN 时接口直接返回 available:false。
async function refreshCommunity() {
  if (refreshRunning) return;
  refreshRunning = true;
  try { await refreshOne('community', '/api/community'); }
  finally { refreshRunning = false; }
}
function startBackgroundRefresh() {
  // 启动后先在后台预热（不等它完成就开始监听端口，首屏不被 buyback 拖死）；
  // 预热期间用户请求若缓存未命中，会按原站逻辑现算一次，这是预期行为。
  setTimeout(() => { refreshLoop().then(() => refreshBuyback()).then(() => refreshCommunity()); }, 1000);
  setInterval(refreshLoop, 60_000);
  setInterval(refreshBuyback, 300_000);
  setInterval(refreshCommunity, 1_800_000);
}

// ---------------------------------------------------------------------------
// Google Fonts 替换：原 HTML 有
//   @import url('https://fonts.googleapis.com/css2?family=DM+Sans...');
//   font:14px 'DM Sans',Arial,'Microsoft Yahei',sans-serif
// fonts.googleapis.com 在国内经常打不开，会阻塞首屏渲染。改成本地系统字体栈，
// 视觉上 DM Sans / Arial / 微软雅黑的兜底效果基本一致，不再发任何境外字体请求。
// ---------------------------------------------------------------------------
const FONT_IMPORT_RE = /@import url\('https:\/\/fonts\.googleapis\.com[^']*'\);\s*/;
const FONT_STACK_RE = /'DM Sans',Arial,'Microsoft Yahei',sans-serif/;
const FONT_STACK_NEW = `system-ui,-apple-system,"Segoe UI",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif`;
function patchHtml(html) {
  let out = html;
  let patched = 0;
  if (FONT_IMPORT_RE.test(out)) { out = out.replace(FONT_IMPORT_RE, ''); patched++; }
  if (FONT_STACK_RE.test(out)) { out = out.replace(FONT_STACK_RE, FONT_STACK_NEW); patched++; }
  if (patched !== 2) console.warn(`[warn] HTML 字体替换只命中 ${patched}/2 处，原站 HTML 可能已变，请检查 app/worker.js`);
  return out;
}

// ---------------------------------------------------------------------------
// HTTP 服务：把 Node 请求转成 Worker 的 Request/Response
// ---------------------------------------------------------------------------
// 同接口并发去重：buyback 一次计算要调 7 天成交（最慢几十秒），
// 5 个用户同时点进来不能各算一次。相同 GET /api/* 请求共享同一次计算结果。
const inflight = new Map(); // key -> Promise<{status, headers, body: Buffer}>
async function callWorker(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const request = new Request(url.toString(), { method: req.method, headers });
  const res = await worker.fetch(request, env, {});
  const buf = Buffer.from(await res.arrayBuffer());
  const outHeaders = {};
  res.headers.forEach((v, k) => { outHeaders[k] = v; });
  return { status: res.status, headers: outHeaders, body: buf };
}

function healthPayload() {
  let cacheFiles = [];
  try { cacheFiles = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json')); } catch {}
  return {
    service: 'aster-pulse',
    mode: 'node-disk-cache',
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    cacheDir: CACHE_DIR,
    cacheFiles: cacheFiles.length,
    cacheKeys: cacheFiles,
    lastRefresh,
    time: new Date().toISOString(),
  };
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // --- /api/health：本适配层新增，Cloudflare 版同名接口的平替 ---
    if (url.pathname === '/api/health') {
      const body = JSON.stringify(healthPayload());
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
      console.log(`[http] ${req.method} ${url.pathname} 200 ${Date.now() - t0}ms`);
      return;
    }

    // --- POST /api/refresh：默认禁用公开调用 ---
    // 原站是公开的 POST 刷新，任何人都能触发一次全量上游拉取（含最贵的 buyback）。
    // 香港服务器上改为：只有带对 REFRESH_TOKEN 才放行；没配 token 时一律 405，
    // 刷新由本机的后台定时任务做。需要手动刷新时：设好 REFRESH_TOKEN 后
    //   curl -X POST -H "x-refresh-token: <token>" http://127.0.0.1:3000/api/refresh
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      const token = req.headers['x-refresh-token'] || url.searchParams.get('token') || '';
      if (!REFRESH_TOKEN || token !== REFRESH_TOKEN) {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '刷新由服务器后台定时任务执行，公开入口已关闭' }));
        console.log(`[http] POST /api/refresh 405 ${Date.now() - t0}ms`);
        return;
      }
      // token 对上：走原站逻辑
    }

    const isApiGet = req.method === 'GET' && url.pathname.startsWith('/api/');
    const dedupeKey = isApiGet ? url.pathname + url.search : null;
    let result;
    if (dedupeKey && inflight.has(dedupeKey)) {
      result = await inflight.get(dedupeKey);
    } else {
      const p = callWorker(req);
      if (dedupeKey) inflight.set(dedupeKey, p);
      try { result = await p; } finally { if (dedupeKey) inflight.delete(dedupeKey); }
    }

    // 首页去掉 Google Fonts（只对 / 做文本替换，其它路由原样透传）
    let body = result.body;
    const headers = { ...result.headers };
    if (url.pathname === '/' && result.status === 200) {
      const patched = patchHtml(body.toString('utf8'));
      body = Buffer.from(patched, 'utf8');
      delete headers['content-length'];
    }
    res.writeHead(result.status, headers);
    res.end(body);
    console.log(`[http] ${req.method} ${url.pathname}${url.search} ${result.status} ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[http] ${req.method} ${url.pathname} ERROR ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    } else res.end();
  }
});

server.timeout = 0; // buyback 首次计算可能超过 60s，不让 Node 默认超时砍掉它；Nginx 侧另设 180s
server.headersTimeout = 120_000;
server.listen(PORT, HOST, () => {
  console.log(`[boot] aster-pulse listening on http://${HOST}:${PORT} cache=${CACHE_DIR}`);
  startBackgroundRefresh();
});

process.on('SIGTERM', () => { console.log('[boot] SIGTERM, shutting down'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { console.log('[boot] SIGINT, shutting down'); server.close(() => process.exit(0)); });
