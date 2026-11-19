#!/usr/bin/env bash
# Runs a command against a throwaway local PostgreSQL (needs postgres binaries:
# apt install postgresql, or brew install postgresql@16).
# Usage: scripts/with-test-db.sh npm test
set -euo pipefail
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"
PORT="${TEST_PGPORT:-54329}"
DIR="${TEST_PGDATA:-$(mktemp -d /tmp/poputka-pg-XXXXXX)}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then chown -R postgres "$DIR"; RUN_AS=(su postgres -c); fi
run() { if [ ${#RUN_AS[@]} -gt 0 ]; then "${RUN_AS[@]}" "$*"; else bash -c "$*"; fi; }
if [ ! -f "$DIR/PG_VERSION" ]; then run "$PGBIN/initdb -D $DIR -A trust -U postgres >/dev/null"; fi
run "$PGBIN/pg_ctl -D $DIR -o '-p $PORT -k /tmp -c fsync=off' -l $DIR/log.txt -w start >/dev/null"
trap 'run "$PGBIN/pg_ctl -D $DIR -m fast stop >/dev/null" || true' EXIT
export TEST_PGHOST=/tmp TEST_PGPORT=$PORT TEST_PGUSER=postgres
"$@"
