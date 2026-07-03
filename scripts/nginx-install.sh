#!/usr/bin/env bash
# Installs the crawl.flare-labs.tech nginx vhost. Run with sudo.
set -euo pipefail
SRC="/home/flare/labs/crawl/nginx/crawl.flare-labs.tech.conf"
DST="/etc/nginx/sites-available/crawl.flare-labs.tech"

install -m 0644 -o root -g root "$SRC" "$DST"
ln -sf "$DST" /etc/nginx/sites-enabled/crawl.flare-labs.tech
mkdir -p /var/log/nginx
nginx -t
systemctl reload nginx
echo "OK: crawl.flare-labs.tech vhost installed and nginx reloaded."
