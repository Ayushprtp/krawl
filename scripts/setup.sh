#!/usr/bin/env bash
# FlareCrawl one-shot setup. Ready-to-go: asks how many browsers + start port,
# then provisions everything (Postgres, Steel fleet, .env, DB schema).
# Non-interactive: preset FLEET_SIZE, FLEET_PORT_START, ADMIN_PASSWORD, LLM_API_KEY as env vars.
set -euo pipefail
cd "$(dirname "$0")/.."

d() { if id -nG | grep -qw docker && command -v sg >/dev/null; then sg docker -c "docker $*"; else docker "$@"; fi; }
ask() { local p="$1" def="$2" v; if [ -n "${3:-}" ]; then echo "$3"; return; fi; read -rp "$p [$def]: " v; echo "${v:-$def}"; }

echo "== FlareCrawl setup =="
SIZE=$(ask "How many browser agents (containers)?" "25" "${FLEET_SIZE:-}")
PSTART=$(ask "Fleet start port" "3300" "${FLEET_PORT_START:-}")
PEND=$((PSTART + SIZE - 1))
AEMAIL=$(ask "Admin email" "admin@flare-labs.tech" "${ADMIN_EMAIL:-}")
APASS="${ADMIN_PASSWORD:-$(ask "Admin password" "changeme" "")}"
LKEY="${LLM_API_KEY:-$(ask "Flare LLM API key (sk-bf-...)" "" "")}"
PUB=$(ask "Public base URL" "https://crawl.flare-labs.tech" "${PUBLIC_BASE_URL:-}")

echo "-> provisioning ${SIZE} browsers on ports ${PSTART}-${PEND}"

PHASH=$(node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');const h=c.scryptSync(process.argv[1],s,64).toString('hex');console.log(s+':'+h)" "$APASS")
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cat > .env <<EOF
PORT=4000
PUBLIC_BASE_URL=${PUB}
FLEET_SIZE=${SIZE}
FLEET_PORT_START=${PSTART}
FLEET_PORT_END=${PEND}
STEEL_HOST=localhost
STEEL_IMAGE=ghcr.io/steel-dev/steel-browser-api:latest
STEEL_MEM_CAP=2g
STEEL_CPU_CAP=2
DATABASE_URL=postgres://crawl:crawl_pw@localhost:5459/crawl
ADMIN_EMAIL=${AEMAIL}
ADMIN_PASSWORD_HASH=${PHASH}
SESSION_SECRET=${SECRET}
LLM_BASE_URL=https://api.flare-sh.tech/v1
LLM_API_KEY=${LKEY}
LLM_TEXT_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
LLM_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
AGENT_MAX_STEPS=10
EOF
echo "-> wrote .env"

echo "-> starting Postgres"; d "compose up -d db" >/dev/null 2>&1 || d "compose up -d db"
echo "-> installing deps"; pnpm install --silent 2>&1 | tail -2 || npm install
echo "-> waiting for Postgres"; until d "exec crawl-pg pg_isready -U crawl" >/dev/null 2>&1; do sleep 1; done
echo "-> applying schema"; pnpm run db:init
echo "-> provisioning Steel fleet (${SIZE})"; bash scripts/fleet.sh start >/dev/null; bash scripts/fleet.sh health

echo ""
echo "== Done. Start the gateway: pnpm start (or systemctl --user start crawl) =="
echo "   Admin: ${PUB}/admin  (login ${AEMAIL})"
