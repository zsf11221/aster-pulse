#!/usr/bin/env bash
# Aster Pulse — 香港服务器一键部署脚本
# 用法（在服务器上，部署包所在目录里执行）：
#   bash deploy.sh            # Docker 方式（推荐）
#   MODE=systemd bash deploy.sh   # 不用 Docker，改走 systemd + 本机 Node
#
# 前置条件：Ubuntu 22.04 / 24.04，已把本部署包传到服务器（见 README 第 2 步）。
# 本脚本不改 DNS、不动线上 buildaster.xyz，切流量前先在本地验完（scripts/check-local.sh）。
set -euo pipefail
cd "$(dirname "$0")"
MODE="${MODE:-docker}"
DOMAIN="${DOMAIN:-buildaster.xyz}"

echo "==> [1/5] 检查系统"
sudo apt-get update -qq
sudo apt-get install -y -qq nginx curl wget ca-certificates gnupg

if [ "$MODE" = "docker" ]; then
  echo "==> [2/5] 安装 Docker（如已安装会跳过）"
  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER" || true
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "未检测到 docker compose 插件，请按 Docker 官方文档安装 docker-compose-plugin 后重试" >&2
    exit 1
  fi
  echo "==> [3/5] 构建并启动容器"
  mkdir -p data/cache
  sudo docker compose up -d --build
  echo "==> [4/5] 等待服务就绪"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -fsS "http://127.0.0.1:3000/api/health" || { echo "服务未就绪，看日志：sudo docker compose logs -f" >&2; exit 1; }
else
  echo "==> [2/5] 安装 Node 20（如已安装会跳过）"
  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
  fi
  node --version
  echo "==> [3/5] 安装 systemd 服务"
  mkdir -p data/cache
  sudo cp aster-pulse.service /etc/systemd/system/aster-pulse.service
  # 按实际路径修正：本脚本默认部署在 /opt/aster-pulse；如果不是，请手动改 service 里的路径
  sudo systemctl daemon-reload
  sudo systemctl enable --now aster-pulse
  echo "==> [4/5] 等待服务就绪"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -fsS "http://127.0.0.1:3000/api/health" || { echo "服务未就绪，看日志：sudo journalctl -u aster-pulse -f" >&2; exit 1; }
fi

echo "==> [5/5] 配置 Nginx（80 端口先行，HTTPS 下一步用 Certbot）"
sudo cp nginx.conf "/etc/nginx/sites-available/${DOMAIN}"
sudo ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo
echo "部署完成。下一步（见 README）："
echo "  1. 本机验收：bash scripts/check-local.sh"
echo "  2. 上 HTTPS：sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}"
echo "  3. 验收通过后，再把 ${DOMAIN} 的 DNS A 记录改到本机 IP（改之前先把 TTL 调低，Codex 侧先别关）"
