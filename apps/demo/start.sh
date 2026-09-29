#!/bin/sh
# Boots the demo's four processes in dependency order. tini is PID 1 and reaps;
# if any process dies the container exits and Cloudflare starts a fresh one.
set -eu

# Redis: in memory only, capped, noeviction (evicting a job hash corrupts a queue).
redis-server --bind 127.0.0.1 --save "" --appendonly no \
  --maxmemory 256mb --maxmemory-policy noeviction --daemonize no &
REDIS_PID=$!

# MariaDB: fresh datadir every boot, loopback TCP only (Alpine ships skip-networking), small buffers.
mkdir -p /run/mysqld /var/lib/mysql && chown -R mysql:mysql /run/mysqld /var/lib/mysql
mariadb-install-db --user=mysql --datadir=/var/lib/mysql --skip-test-db >/dev/null
mariadbd --user=mysql --datadir=/var/lib/mysql --skip-networking=0 --port=3306 --bind-address=127.0.0.1 \
  --innodb-buffer-pool-size=64M --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_unicode_ci --skip-name-resolve &
DB_PID=$!

i=0
until mariadb-admin ping --silent 2>/dev/null; do
  i=$((i + 1)); [ "$i" -gt 60 ] && { echo "mariadb did not start" >&2; exit 1; }
  sleep 0.5
done
mariadb -uroot <<'SQL'
CREATE DATABASE IF NOT EXISTS bullpane CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'bullpane'@'127.0.0.1' IDENTIFIED BY 'bullpane';
GRANT ALL ON bullpane.* TO 'bullpane'@'127.0.0.1';
SQL

until redis-cli -h 127.0.0.1 ping >/dev/null 2>&1; do sleep 0.2; done

cd /app
pnpm --filter @bullpane/simulator start &
SIM_PID=$!
pnpm --filter @bullpane/server start &
APP_PID=$!

# Exit as soon as any of them exits, so a half-dead demo is replaced, not served.
while kill -0 "$REDIS_PID" "$DB_PID" "$SIM_PID" "$APP_PID" 2>/dev/null; do sleep 2; done
echo "a demo process exited; stopping the container" >&2
exit 1
