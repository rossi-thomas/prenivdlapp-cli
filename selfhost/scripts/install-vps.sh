#!/usr/bin/env bash
set -Eeuo pipefail

# PRENIVDL self-hosted API installer for Ubuntu/Debian.
# Run as root on a fresh VPS:
#   curl -fsSL https://raw.githubusercontent.com/arsya371/prenivdlapp-cli/main/selfhost/scripts/install-vps.sh | bash
#
# Optional non-interactive variables:
#   PRENIV_DOMAIN=api.example.com
#   YTDLP_COOKIES_B64=...
#   YTDLP_COOKIES_FILE=/root/cookies.txt
#   SSH_PORT=2348

APP_DIR="${APP_DIR:-/opt/prenivdl}"
SERVICE_USER="${SERVICE_USER:-prenivdl}"
SERVICE_NAME="${SERVICE_NAME:-prenivdl}"
APP_PORT="${APP_PORT:-8787}"
SSH_PORT="${SSH_PORT:-2348}"
PRENIV_DOMAIN="${PRENIV_DOMAIN:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行此脚本。" >&2
  exit 1
fi

if [[ -z "${YTDLP_COOKIES_B64:-}" && -n "${YTDLP_COOKIES_FILE:-}" ]]; then
  [[ -f "${YTDLP_COOKIES_FILE}" ]] || { echo "找不到 cookies 文件: ${YTDLP_COOKIES_FILE}" >&2; exit 1; }
  YTDLP_COOKIES_B64="$(base64 -w 0 "${YTDLP_COOKIES_FILE}")"
fi

if [[ -z "${YTDLP_COOKIES_B64:-}" ]]; then
  read -r -s -p "粘贴 YouTube cookies.txt 的 base64（可直接回车跳过）: " YTDLP_COOKIES_B64
  echo
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git ufw

# Node 20+ is required by the project. Use NodeSource when the distro Node is
# missing or too old; do not overwrite an adequate existing installation.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch --depth=1 origin main
  git -C "${APP_DIR}" reset --hard origin/main
else
  rm -rf "${APP_DIR}"
  git clone --depth=1 https://github.com/arsya371/prenivdlapp-cli.git "${APP_DIR}"
fi

cd "${APP_DIR}/selfhost"
chmod 755 api/bin/yt-dlp
npm install --omit=dev --ignore-scripts

install -d -m 0750 -o "${SERVICE_USER}" -g "${SERVICE_USER}" /etc/prenivdl
cat > /etc/prenivdl/server.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${APP_PORT}
YTDLP_BUDGET_MS=50000
YTDLP_TIMEOUT_MS=45000
YTDLP_COOKIES_B64=${YTDLP_COOKIES_B64}
EOF
chmod 600 /etc/prenivdl/server.env
chown root:"${SERVICE_USER}" /etc/prenivdl/server.env

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=PRENIVDL yt-dlp API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}/selfhost
EnvironmentFile=/etc/prenivdl/server.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/tmp

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

# Keep the SSH port reachable before enabling the firewall.
ufw allow "${SSH_PORT}/tcp"
if [[ -n "${PRENIV_DOMAIN}" ]]; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
  cat > /etc/caddy/Caddyfile <<EOF
${PRENIV_DOMAIN} {
  reverse_proxy 127.0.0.1:${APP_PORT}
}
EOF
  systemctl enable --now caddy
  ufw allow 80/tcp
  ufw allow 443/tcp
fi
ufw --force enable

echo
echo "PRENIVDL VPS 部署完成"
echo "本机健康检查: curl http://127.0.0.1:${APP_PORT}/health"
if [[ -n "${PRENIV_DOMAIN}" ]]; then
  echo "API 地址: https://${PRENIV_DOMAIN}/api"
else
  echo "当前未配置域名；请设置 PRENIV_DOMAIN 后重新运行以启用 HTTPS。"
fi
echo "服务日志: journalctl -u ${SERVICE_NAME} -f"
