#!/usr/bin/env bash
# FlareCrawl Steel fleet manager. Reads FLEET_* from .env.
# Container flarecrawl-steel-<i> -> host port (FLEET_PORT_START + i) -> :3000.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
[ -f .env ] && set -a && . ./.env && set +a

IMAGE="${STEEL_IMAGE:-ghcr.io/steel-dev/steel-browser-api:latest}"
BASE="${FLEET_PORT_START:-3300}"
SIZE="${FLEET_SIZE:-25}"
MEM="${STEEL_MEM_CAP:-2g}"
CPU="${STEEL_CPU_CAP:-2}"
NAME="flarecrawl-steel"

d() { if command -v sg >/dev/null 2>&1 && id -nG | grep -qw docker; then sg docker -c "docker $*"; else docker "$@"; fi; }

running() { d "ps --format '{{.Names}}'" | grep -E "^${NAME}-[0-9]+$"; }

start() {
  local i api
  for i in $(seq 0 $((SIZE - 1))); do
    api=$((BASE + i))
    if d "inspect ${NAME}-$i" >/dev/null 2>&1; then
      d "start ${NAME}-$i" >/dev/null 2>&1 && echo "start  ${NAME}-$i (:$api)"
    else
      d "run -d --name ${NAME}-$i --restart unless-stopped -p ${api}:3000 -e DOMAIN=localhost:${api} --memory=${MEM} --cpus=${CPU} ${IMAGE}" >/dev/null 2>&1 \
        && echo "run    ${NAME}-$i (:$api)"
    fi
    sleep 0.2
  done
}
stop_all() { for n in $(running); do d "stop $n" >/dev/null 2>&1; done; echo "stopped"; }
rm_all()   { for n in $(d "ps -a --format '{{.Names}}'" | grep -E "^${NAME}-[0-9]+$"); do d "rm -f $n" >/dev/null 2>&1; done; echo "removed"; }
count()    { running | wc -l; }
health() {
  local ok=0 total=0 i api
  for i in $(seq 0 $((SIZE - 1))); do
    api=$((BASE + i)); total=$((total + 1))
    curl -s -o /dev/null --max-time 3 "http://localhost:${api}/v1/sessions" && ok=$((ok + 1))
  done
  echo "healthy ${ok}/${total}"
}

case "${1:-}" in
  start) start ;;
  stop) stop_all ;;
  rm) rm_all ;;
  count) count ;;
  health) health ;;
  *) echo "usage: $0 {start|stop|rm|count|health}"; exit 1 ;;
esac
