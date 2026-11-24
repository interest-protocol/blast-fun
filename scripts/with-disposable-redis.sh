#!/usr/bin/env bash
# Task-owned loopback Valkey; always removed, never a production connection.
# Run inside the shared heavy-job guard, just like with-disposable-postgres.sh.
set -euo pipefail
redis_container="blast-v2-disposable-redis-$$"
trap 'docker rm --force "$redis_container" >/dev/null 2>&1 || true' EXIT INT TERM
docker run --detach --rm --memory=128m --name "$redis_container" \
  --publish 127.0.0.1::6379 valkey/valkey:8-alpine \
  valkey-server --maxmemory 64mb --maxmemory-policy noeviction --save '' --appendonly no >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$redis_container" valkey-cli ping >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 30 ]; then echo 'Disposable Redis did not become ready.' >&2; exit 1; fi
  sleep 1
done
redis_port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "6379/tcp") 0).HostPort}}' "$redis_container")
export BLAST_TEST_REDIS_URL="redis://127.0.0.1:$redis_port"
# Lets an owned test pause exactly this container; never another chat's.
export BLAST_TEST_REDIS_CONTAINER="$redis_container"
"$@"
