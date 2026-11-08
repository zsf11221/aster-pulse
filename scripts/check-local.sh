#!/usr/bin/env bash
# Aster Pulse — 服务器本机验收脚本（不经过公网 DNS，直接测 127.0.0.1:3000）
# 用法：bash scripts/check-local.sh
# 预期：/、/client.js、/api/health、/api/markets、/api/announcements、/api/activities 都是 200；
# /api/buyback 首次可能 10-60 秒（7 天分段查成交），有缓存后应 < 2 秒；/api/detail 用 BTCUSDT 测。
set -u
BASE="${BASE:-http://127.0.0.1:3000}"
fail=0
check() {
  local name="$1" url="$2" max_ms="${3:-30000}"
  local t0 t1 ms code body
  t0=$(date +%s%3N)
  body=$(curl -sS -m 180 -w "\n%{http_code}" "$url" 2>/dev/null || echo -e "\n000")
  code=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')
  t1=$(date +%s%3N); ms=$((t1 - t0))
  local size=${#body}
  if [ "$code" = "200" ]; then s="OK  "; else s="FAIL"; fail=1; fi
  printf "%s %-28s %s %6dms %8d bytes  %s\n" "$s" "$name" "$code" "$ms" "$size" "$url"
  if [ "$code" != "200" ]; then echo "    body: $(echo "$body" | head -c 300)"; fi
  echo "$body" > "/tmp/aster-check-$(echo "$name" | tr '/' '_').json" 2>/dev/null || true
}
echo "BASE=$BASE  $(date '+%F %T %Z')"
check "GET /"                       "$BASE/" 10000
check "GET /client.js"              "$BASE/client.js" 10000
check "GET /assets/aster-logo.svg"  "$BASE/assets/aster-logo.svg" 10000
check "GET /api/health"             "$BASE/api/health" 10000
check "GET /api/markets"            "$BASE/api/markets" 60000
check "GET /api/announcements"      "$BASE/api/announcements" 60000
check "GET /api/activities"         "$BASE/api/activities" 60000
check "GET /api/community"             "$BASE/api/community" 10000
check "GET /api/daily-brief"          "$BASE/api/daily-brief" 60000
check "GET /api/market-detail"      "$BASE/api/market-detail?symbol=BTCUSDT" 60000
check "GET /api/detail"             "$BASE/api/detail?symbol=XTENUSDT" 120000
echo "--- /api/detail BTCUSDT 预期 502（原站逻辑：老币种首日 K 线缺失，线上站同样 502，非部署问题）---"
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 60 "$BASE/api/detail?symbol=BTCUSDT"); echo "GET /api/detail?symbol=BTCUSDT -> $code （预期 502）"
echo "--- buyback（首次慢是正常的，第二次应命中缓存变快）---"
check "GET /api/buyback #1"         "$BASE/api/buyback" 180000
check "GET /api/buyback #2 cached"  "$BASE/api/buyback" 10000
echo "--- 字体检查：首页不应再请求 fonts.googleapis.com ---"
if curl -fsS "$BASE/" | grep -q "fonts.googleapis.com"; then echo "FAIL 首页仍含 fonts.googleapis.com"; fail=1; else echo "OK   首页无 fonts.googleapis.com"; fi
echo "--- 404 检查 ---"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/no-such-page"); echo "GET /no-such-page -> $code （预期 404）"
[ "$fail" = "0" ] && echo "全部通过" || echo "有 FAIL 项，见上"
exit "$fail"
