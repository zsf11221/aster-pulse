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
