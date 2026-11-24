#!/usr/bin/env bash
# Runs a command with READ_ROUTING_PRIMARY_URL and READ_ROUTING_REPLICA_URL
# pointing at a throwaway PostgreSQL primary and a hot-standby streaming
# replica of it (scripts/postgres-image.sh). Both containers and their network
# are removed on exit. The replica's superuser may stop its WAL receiver
# (ALTER SYSTEM SET primary_conninfo = '').
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/postgres-image.sh"

suffix="$$"
network="blast-v2-replication-${suffix}"
primary="blast-v2-primary-${suffix}"
replica="blast-v2-replica-${suffix}"
database_name="mission_control_test"
database_password="disposable-test"
data="/var/lib/postgresql/data/pg"

cleanup() {
  docker rm --force --volumes "${replica}" "${primary}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM

ready() {
  for attempt in $(seq 1 60); do
    if docker exec "$1" pg_isready --host 127.0.0.1 --username postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Disposable PostgreSQL $1 did not become ready." >&2
  exit 1
}

docker network create "${network}" >/dev/null
docker run --detach --rm \
  --name "${primary}" --network "${network}" \
  --env "POSTGRES_DB=${database_name}" \
  --env "POSTGRES_PASSWORD=${database_password}" \
  --env "PGDATA=${data}" \
  --publish 127.0.0.1::5432 \
  "${postgres_image}" -c wal_level=replica -c max_wal_senders=4 >/dev/null
ready "${primary}"
# The first-boot server restarts after its init scripts; wait for the final one.
sleep 3
ready "${primary}"
docker exec "${primary}" sh -c "echo 'host replication all all scram-sha-256' >> ${data}/pg_hba.conf"
docker exec --user postgres "${primary}" psql -qAt -c "SELECT pg_reload_conf()" >/dev/null

docker run --detach --rm \
  --name "${replica}" --network "${network}" --user postgres \
  --env "PGPASSWORD=${database_password}" \
  --env "PGDATA=${data}" \
  --publish 127.0.0.1::5432 \
  --entrypoint sh "${postgres_image}" -c \
  "mkdir -p ${data} && chmod 700 ${data} \
   && pg_basebackup -h ${primary} -U postgres -D ${data} -R -X stream \
   && exec postgres -c hot_standby=on" >/dev/null
ready "${replica}"

port() {
  docker port "$1" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/'
}
export READ_ROUTING_PRIMARY_URL="postgresql://postgres:${database_password}@127.0.0.1:$(port "${primary}")/${database_name}"
export READ_ROUTING_REPLICA_URL="postgresql://postgres:${database_password}@127.0.0.1:$(port "${replica}")/${database_name}"

"$@"
