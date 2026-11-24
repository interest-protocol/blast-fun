#!/usr/bin/env bash
# Runs a command with MISSION_CONTROL_TEST_DATABASE_URL pointing at a
# throwaway Postgres container (scripts/postgres-image.sh) removed on exit.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/postgres-image.sh"

container_name="blast-v2-disposable-db-$$"
database_name="mission_control_test"
database_password="disposable-test"

cleanup() {
  # --volumes: an explicit rm skips --rm's anonymous-volume cleanup.
  docker rm --force --volumes "${container_name}" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

docker run --detach --rm \
  --name "${container_name}" \
  --shm-size "${POSTGRES_TEST_SHM_SIZE:-64m}" \
  --env "POSTGRES_DB=${database_name}" \
  --env "POSTGRES_PASSWORD=${database_password}" \
  --publish 127.0.0.1::5432 \
  "${postgres_image}" -c max_connections=300 >/dev/null

# Over TCP: the image's first-boot server (initdb, init scripts) listens only on
# the Unix socket and then restarts, so a socket check can pass too early.
for attempt in $(seq 1 60); do
  if docker exec "${container_name}" pg_isready --host 127.0.0.1 --username postgres --dbname "${database_name}" >/dev/null 2>&1; then
    break
  fi
  if [ "${attempt}" -eq 60 ]; then
    echo "Disposable PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 1
done

published_port="$(docker port "${container_name}" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
export MISSION_CONTROL_TEST_DATABASE_URL="postgresql://postgres:${database_password}@127.0.0.1:${published_port}/${database_name}"

export DATABASE_URL="$MISSION_CONTROL_TEST_DATABASE_URL"
export DATABASE_MIGRATION_URL="$MISSION_CONTROL_TEST_DATABASE_URL"

# blast-infra's roles and chain_read_v1 views come first, as in production.
node --no-warnings --experimental-strip-types "$(dirname "${BASH_SOURCE[0]}")/../packages/core/test/scripts/apply-chain-fixture.ts"

"$@"
