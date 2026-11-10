// Aster Pulse — server.js 关键接口自动化测试（Node 自带 test runner，零依赖）
//
// 做法：把 server.js 当子进程启动（临时端口 + 临时 CACHE_DIR，不污染
// 仓库里的 data/cache），调真实上游接口做断言。
// 断言只认结构不认数字：状态码 200、JSON 结构、关键字段存在与类型、
// stale 标记逻辑；不写死任何价格/数量，因为上游每天都在变。
// /api/detail?symbol=BTCUSDT 返回 502 是原站已知行为（check-local.sh 里
// 已注明：老币种首日 K 线缺失，线上站同样 502），这里只断言它符合已
// 知行为，不当成失败。
//
// 本地跑：npm test        CI 跑：.github/workflows/test.yml

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

// buyback 冷启动要调 7 天分段成交，几秒到几十秒都正常；其它接口也可能
// 等上游，超时一律放宽。上游偶发失败时，断言信息里带上状态码和 body
// 前 300 字符，方便一眼看出是本站问题还是上游问题。
const SLOW_TIMEOUT = 180_000;
const FAST_TIMEOUT = 90_000;

let base = '';
let child = null;
let cacheDir = '';
let serverLog = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function getJSON(pathname, { timeoutMs = 120_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + pathname, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* 非 JSON 时 body 保持 null */ }
    return { status: res.status, body, raw: text.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

test.before(async () => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aster-pulse-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CACHE_DIR: cacheDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  // 等 /api/health 变 200，最多 30 秒；起不来就把日志打出来再失败。
  const deadline = Date.now() + 30_000;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      assert.fail(`server.js 启动即退出（exit ${child.exitCode}），日志：\n${serverLog.slice(-2000)}`);
    }
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail(`server.js 30 秒内未就绪（${base}），最后一次错误：${lastErr}\n日志：\n${serverLog.slice(-2000)}`);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('GET /api/health 返回服务状态', { timeout: FAST_TIMEOUT }, async () => {
  const { status, body, raw } = await getJSON('/api/health');
  assert.equal(status, 200, `health 应返回 200，实际 ${status}，body：${raw}`);
  assert.equal(body.service, 'aster-pulse');
  assert.equal(body.mode, 'node-disk-cache');
  assert.equal(typeof body.uptimeSec, 'number');
  assert.ok(body.uptimeSec >= 0, `uptimeSec 应 >= 0，实际 ${body.uptimeSec}`);
  assert.equal(body.cacheDir, cacheDir);
  assert.equal(typeof body.cacheFiles, 'number');
  assert.ok(Array.isArray(body.cacheKeys));
  assert.equal(typeof body.lastRefresh, 'object');
  assert.ok(!Number.isNaN(Date.parse(body.time)), `time 应为合法时间，实际 ${body.time}`);
});

test('GET / 返回首页且不含 Google Fonts', { timeout: FAST_TIMEOUT }, async () => {
  const res = await fetch(base + '/', { signal: AbortSignal.timeout(60_000) });
  assert.equal(res.status, 200, `首页应返回 200，实际 ${res.status}`);
  const html = await res.text();
  assert.ok(html.includes('Aster Pulse'), '首页应包含 Aster Pulse');
  assert.ok(!html.includes('fonts.googleapis.com'), '首页不应再请求 fonts.googleapis.com');
});

test('GET /api/markets 返回行情行', { timeout: FAST_TIMEOUT }, async () => {
  const { status, body, raw } = await getJSON('/api/markets');
  assert.equal(status, 200, `markets 应返回 200，实际 ${status}，body：${raw}`);
  assert.ok(Array.isArray(body.rows), 'rows 应为数组');
  assert.ok(body.rows.length > 0, 'rows 不应为空（上游无数据或格式变了）');
  for (const row of body.rows.slice(0, 5)) {
    assert.equal(typeof row.symbol, 'string');
    assert.ok(row.symbol.endsWith('USDT'), `symbol 应以 USDT 结尾，实际 ${row.symbol}`);
    assert.equal(typeof row.name, 'string');
    assert.ok(row.price === null || typeof row.price === 'string', 'price 应为字符串或 null');
    assert.ok(row.change24 === null || typeof row.change24 === 'number', 'change24 应为数字或 null');
  }
  assert.equal(typeof body.stale, 'boolean', 'stale 应为布尔值');
  assert.equal(typeof body.updatedAt, 'number');
});

test('GET /api/token-stats 返回价格/质押/销毁字段', { timeout: FAST_TIMEOUT }, async () => {
  const { status, body, raw } = await getJSON('/api/token-stats');
  assert.equal(status, 200, `token-stats 应返回 200，实际 ${status}，body：${raw}`);
  // 三个分项各自带 stale/error 标记；整体 stale 为真时，允许个别分项为空，
  // 但至少价格和质押其一可用是 tokenStats() 的兜底（否则它自己会抛错）。
  assert.equal(typeof body.stale, 'boolean');
  assert.equal(typeof body.priceStale, 'boolean');
  assert.equal(typeof body.stakedStale, 'boolean');
  assert.equal(typeof body.burnedStale, 'boolean');
  assert.equal(typeof body.updatedAt, 'number');
  assert.ok(body.updatedAt > 0, 'updatedAt 应为正数时间戳');

  // 价格：不断言具体数字，只断言存在时为正数
  assert.ok(body.price === null || (typeof body.price === 'number' && body.price > 0),
    `price 应为正数或 null，实际 ${body.price}`);
  if (body.price !== null) {
    assert.equal(typeof body.change24, 'number', '有价格时 change24 应为数字');
  }
  // 质押：DefiLlama TVL ÷ 永续价换算，存在时为正数
  assert.ok(body.staked === null || (typeof body.staked === 'number' && body.staked > 0),
    `staked 应为正数或 null，实际 ${body.staked}`);
  assert.ok(body.stakedUsd === null || (typeof body.stakedUsd === 'number' && body.stakedUsd > 0),
    `stakedUsd 应为正数或 null，实际 ${body.stakedUsd}`);
  // 销毁：80 亿 - CoinGecko 总量反推，存在时应在 (0, 80亿) 区间
  assert.ok(body.burned === null || (typeof body.burned === 'number' && body.burned > 0 && body.burned < 8_000_000_000),
    `burned 应在 (0, 80亿) 区间或为 null，实际 ${body.burned}`);
  if (body.burned !== null) {
    assert.equal(typeof body.totalSupply, 'number');
    assert.ok(body.totalSupply > 0 && body.totalSupply < 8_000_000_000);
  }
  // stale 为 false 时三项应齐全；stale 为真时至少有一项带 error 说明
  if (!body.stale) {
    assert.notEqual(body.price, null, '非 stale 时 price 不应为空');
    assert.notEqual(body.staked, null, '非 stale 时 staked 不应为空');
    assert.notEqual(body.burned, null, '非 stale 时 burned 不应为空');
  } else {
    assert.ok(body.priceError || body.stakedError || body.burnedError,
      'stale 时至少一项应带 error 说明');
  }
});

test('GET /api/buyback 返回 7 天回购统计', { timeout: SLOW_TIMEOUT }, async () => {
  const { status, body, raw } = await getJSON('/api/buyback', { timeoutMs: 170_000 });
  assert.equal(status, 200, `buyback 应返回 200，实际 ${status}，body：${raw}`);
  assert.equal(typeof body.wallet, 'string');
  assert.ok(body.wallet.length > 0, 'wallet 不应为空');
  assert.ok(Array.isArray(body.days), 'days 应为数组');
  assert.equal(body.days.length, 7, `days 应为 7 天，实际 ${body.days.length}`);
  for (const d of body.days) {
    assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/, `day 应为 YYYY-MM-DD，实际 ${d.day}`);
    assert.equal(typeof d.qty, 'number');
    assert.ok(d.qty >= 0, `qty 应 >= 0，实际 ${d.qty}`);
    assert.equal(typeof d.spent, 'number');
    assert.ok(d.spent >= 0, `spent 应 >= 0，实际 ${d.spent}`);
    assert.ok(Number.isInteger(d.count) && d.count >= 0, `count 应为非负整数，实际 ${d.count}`);
  }
  assert.equal(typeof body.start, 'number');
  assert.equal(typeof body.end, 'number');
  assert.ok(body.end > body.start, 'end 应大于 start');
  assert.equal(typeof body.stale, 'boolean');
});

test('GET /api/daily-brief 返回每日异动结构', { timeout: SLOW_TIMEOUT }, async () => {
  const { status, body, raw } = await getJSON('/api/daily-brief', { timeoutMs: 170_000 });
  assert.equal(status, 200, `daily-brief 应返回 200，实际 ${status}，body：${raw}`);
  assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/, `date 应为 YYYY-MM-DD，实际 ${body.date}`);
  assert.ok(body.top === null || typeof body.top.name === 'string', 'top 应为 null 或带 name 的对象');
  if (body.top) {
    assert.equal(typeof body.top.symbol, 'string');
    assert.ok(body.top.change24 === null || typeof body.top.change24 === 'number');
    assert.ok(body.top.fundingRate === null || typeof body.top.fundingRate === 'number',
      `fundingRate 应为数字或 null，实际 ${body.top.fundingRate}`);
  }
  assert.ok(Array.isArray(body.top5), 'top5 应为数组');
  assert.ok(body.top5.length <= 5, `top5 最多 5 条，实际 ${body.top5.length}`);
  assert.equal(typeof body.score, 'number');
  assert.ok(body.score >= 0 && body.score <= 100, `score 应在 0-100，实际 ${body.score}`);
  assert.ok(['overheated', 'strong', 'watch', 'quiet'].includes(body.verdict),
    `verdict 应为四种之一，实际 ${body.verdict}`);
  assert.ok(Array.isArray(body.dino), 'dino 应为数组');
  assert.ok(Array.isArray(body.events), 'events 应为数组');
  assert.ok(Array.isArray(body.ideas), 'ideas 应为数组');
  assert.ok(body.ideas.length <= 3, `ideas 最多 3 条，实际 ${body.ideas.length}`);
  for (const it of body.ideas) {
    assert.equal(typeof it.symbol, 'string');
    assert.ok(['noChase', 'tryLong', 'watch', 'none'].includes(it.idea.direction),
      `idea.direction 应为四种之一，实际 ${it.idea.direction}`);
    assert.equal(typeof it.idea.reason.zh, 'string');
    assert.equal(typeof it.idea.reason.en, 'string');
    for (const k of ['entry', 'stop', 'target']) {
      assert.ok(it.idea[k] === null || typeof it.idea[k] === 'number',
        `idea.${k} 应为数字或 null，实际 ${it.idea[k]}`);
    }
  }
  assert.ok(!('buyback' in body) && !('aster' in body), '异动里不应再含回购/ASTER 字段');
  assert.equal(typeof body.stale, 'boolean');
  assert.equal(typeof body.updatedAt, 'number');
});

test('GET /api/detail?symbol=BTCUSDT 返回已知 502（原站行为，非失败）', { timeout: FAST_TIMEOUT }, async () => {
  const { status, body, raw } = await getJSON('/api/detail?symbol=BTCUSDT');
  assert.equal(status, 502, `detail BTCUSDT 已知应返回 502，实际 ${status}，body：${raw}`);
  assert.equal(typeof body.error, 'string', '502 时应带 error 说明');
  assert.ok(body.error.length > 0, 'error 不应为空');
});

test('POST /api/refresh 无 token 时返回 405', { timeout: FAST_TIMEOUT }, async () => {
  const res = await fetch(base + '/api/refresh', {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(res.status, 405, `无 token 的 refresh 应返回 405，实际 ${res.status}`);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});

// ---------------------------------------------------------------------------
// /api/daily-brief 的 mock 上游单测：直接调 app/worker.js 的 fetch，
// 上游 fetch 全部 stub，不碰真实网络。断言只认结构、异动分公式与
// 开单思路规则，不写死价格。DAILY_BRIEF_ENABLED=false 时接口应返回 404。
// ---------------------------------------------------------------------------
test('GET /api/daily-brief（mock 上游）返回聚合结构、异动分与开单思路', async () => {
  const worker = (await import('../app/worker.js')).default;
  const store = new Map();
  const env = {
    BUCKET: {
      async get(k) { const v = store.get(k); return v ? { json: async () => JSON.parse(v) } : null; },
      async put(k, v) { store.set(k, String(v)); },
    },
    X_BEARER_TOKEN: '',
    DAILY_BRIEF_ENABLED: true,
  };
  const now = Date.now();
  const exchangeInfo = { symbols: [
    { symbol: 'JCTUSDT', baseAsset: 'JCT', quoteAsset: 'USDT', status: 'TRADING', onboardDate: now - 86400000 },
    { symbol: 'STONKBROKERUSDT', baseAsset: 'STONKBROKER', quoteAsset: 'USDT', status: 'TRADING', onboardDate: now - 2 * 86400000 },
    { symbol: 'XLMUSDT', baseAsset: 'XLM', quoteAsset: 'USDT', status: 'TRADING', onboardDate: now - 3 * 86400000 },
  ] };
  const tickers = [
    { symbol: 'JCTUSDT', lastPrice: '0.012', openPrice: '0.0027', highPrice: '0.0154', lowPrice: '0.0023', quoteVolume: '23000000', closeTime: now },
    { symbol: 'STONKBROKERUSDT', lastPrice: '0.0078', openPrice: '0.0056', highPrice: '0.0082', lowPrice: '0.0054', quoteVolume: '500000', closeTime: now },
    { symbol: 'XLMUSDT', lastPrice: '0.5', openPrice: '0.45', highPrice: '0.52', lowPrice: '0.44', quoteVolume: '5000000', closeTime: now },
  ];
  const fundingBySymbol = { JCTUSDT: '0.0135', STONKBROKERUSDT: '0.0002', XLMUSDT: '0.0001' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('exchangeInfo')) return ok(exchangeInfo);
    if (u.includes('ticker/24hr')) {
      const m = u.match(/symbol=([A-Z0-9_]+)/);
      if (m) { const one = tickers.find(t => t.symbol === m[1]); if (one) return ok(one); }
      return ok(tickers);
    }
    if (u.includes('premiumIndex')) {
      const m = u.match(/symbol=([A-Z0-9_]+)/);
      const sym = m ? m[1] : 'JCTUSDT';
      return ok({ symbol: sym, lastFundingRate: fundingBySymbol[sym] ?? '0.0001', time: now });
    }
    if (u.includes('openInterest')) return ok({ symbol: 'JCTUSDT', openInterest: '753936743', time: now });
    throw new Error('mock 未覆盖的上游: ' + u);
  };
  try {
    const res = await worker.fetch(new Request('http://localhost/api/daily-brief'), env, {});
    assert.equal(res.status, 200, `mock 异动应返回 200，实际 ${res.status}`);
    const body = await res.json();
    assert.equal(body.top.name, 'JCT', `涨幅第一应为 JCT，实际 ${body.top?.name}`);
    assert.equal(body.top.fundingRate, 0.0135, `资金费率应为 0.0135，实际 ${body.top.fundingRate}`);
    assert.equal(body.top.openInterest, '753936743');
    assert.equal(body.top.highPrice, '0.0154', `日内高点应为 0.0154，实际 ${body.top.highPrice}`);
    assert.equal(body.verdict, 'overheated', `资金费率 1.35% 时结论应为 overheated，实际 ${body.verdict}`);
    // JCT +344.4%：涨幅分 43.1 + 成交额分 13.4 + 资金费率分 13.4 + 领先分 15 ≈ 85
    assert.ok(body.score >= 80 && body.score <= 90, `score 应在 80-90，实际 ${body.score}`);
    assert.equal(body.top5.length, 3, `top5 应为 3 条，实际 ${body.top5.length}`);
    assert.equal(body.top5[1].name, 'STONKBROKER');
    assert.equal(body.dino.length, 1, `老币观察只应命中 XLM，实际 ${JSON.stringify(body.dino)}`);
    assert.equal(body.dino[0].name, 'XLM');
    assert.ok(!('buyback' in body) && !('aster' in body), '异动里不应再含回购/ASTER 字段');
    assert.ok(Array.isArray(body.events), 'events 应为数组');
    // 开单思路：JCT 费率 1.35% 过热 → 不追多；STONKBROKER +39.3% 费率未过热（0.02%）→ 观望；XLM +11.1% → 暂无思路
    assert.equal(body.ideas.length, 3, `ideas 应为 3 条，实际 ${body.ideas.length}`);
    const [jct, stonk, xlm] = body.ideas;
    assert.equal(jct.idea.direction, 'noChase', `JCT 方向应为 noChase，实际 ${jct.idea.direction}`);
    assert.equal(jct.idea.entry, 0.01309, `JCT 回踩位应为高点 0.0154×0.85，实际 ${jct.idea.entry}`);
    assert.equal(jct.idea.stop, 0.01217, `JCT 止损应为回踩位×0.93，实际 ${jct.idea.stop}`);
    assert.equal(jct.idea.target, 0.01694, `JCT 目标应为高点×1.10，实际 ${jct.idea.target}`);
    assert.match(jct.idea.reason.zh, /1\.35%/, `JCT 理由应带资金费率，实际 ${jct.idea.reason.zh}`);
    assert.equal(stonk.idea.direction, 'watch', `STONKBROKER 方向应为 watch，实际 ${stonk.idea.direction}`);
    assert.equal(stonk.idea.entry, 0.0082, `STONKBROKER 突破位应为日内高点，实际 ${stonk.idea.entry}`);
    assert.equal(stonk.idea.stop, 0.005292, `STONKBROKER 止损应为低点×0.98，实际 ${stonk.idea.stop}`);
    assert.equal(stonk.idea.target, 0.00984, `STONKBROKER 目标应为高点×1.20，实际 ${stonk.idea.target}`);
    assert.equal(xlm.idea.direction, 'none', `XLM 方向应为 none，实际 ${xlm.idea.direction}`);
    assert.equal(xlm.idea.entry, null);
    assert.equal(xlm.idea.stop, null);
    assert.equal(xlm.idea.target, null);
    // 代志关闭时返回 404
    const res404 = await worker.fetch(new Request('http://localhost/api/daily-brief'), { ...env, DAILY_BRIEF_ENABLED: false }, {});
    assert.equal(res404.status, 404, `代志关闭时应返回 404，实际 ${res404.status}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});
