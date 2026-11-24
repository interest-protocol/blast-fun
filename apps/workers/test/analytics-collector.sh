#!/usr/bin/env bash
# Manual, cross-repository contract proof. Owns exactly three loopback PostgreSQL clusters.
set -euo pipefail
analytics_repo=$(cd "$(dirname "$0")/../../.." && pwd)
analytics_infra=${1:?Pass the blast-infra export checkout}
analytics_infra_ref=${2:?Pass its exact commit}
analytics_sui=${3:?Pass the pinned Sui checkout}
analytics_sui_ref=${4:?Pass its exact commit}
shift 4
test "$(git -C "$analytics_infra" rev-parse HEAD)" = "$analytics_infra_ref"
test "$(git -C "$analytics_sui" rev-parse HEAD)" = "$analytics_sui_ref"
if ! git -C "$analytics_infra" diff --quiet HEAD -- migrations src/database_roles.sql tests/sql/analytics_export.sql; then
  echo 'Infra contract has local edits; this rehearsal records the export/fixture hashes below.'
fi
python3 - "$analytics_infra/Cargo.toml" "$analytics_sui_ref" <<'PY'
import re, sys
source = open(sys.argv[1]).read()
match = re.search(r'sui-indexer-alt-framework = .*rev = "([0-9a-f]+)"', source)
if not match or match[1] != sys.argv[2]:
    raise SystemExit("Sui commit does not match the infra dependency")
PY
analytics_export="$analytics_infra/migrations/2026-12-18-000000_analytics_export/up.sql"
test -f "$analytics_export"
test -d "$analytics_sui/crates/sui-pg-db/migrations"

# Budget 2 GiB extra disk and 2 GiB memory, in addition to the shared reserves.
df -Pk /tmp "$analytics_repo" | awk 'NR > 1 && $4 < 10485760 { failed=1 } END { exit failed ? 75 : 0 }'
awk '$1 == "MemAvailable:" { exit ($2 < 6291456) ? 75 : 0 }' /proc/meminfo
awk '$1 == "full" { split($2,v,"="); exit (v[2] >= 1) ? 75 : 0 }' /proc/pressure/memory
analytics_pg_bin=${ANALYTICS_PG_BIN:-/usr/lib/postgresql/16/bin}
analytics_tmp=$(mktemp -d /tmp/blast-collector.XXXXXX)
cleanup() {
  for analytics_cluster in standby primary warehouse; do
    "$analytics_pg_bin/pg_ctl" -D "$analytics_tmp/$analytics_cluster" -m immediate -w stop >/dev/null 2>&1 || true
  done
  if [ -n "${ANALYTICS_TEST_LOG_DIR:-}" ]; then
    mkdir -p "$ANALYTICS_TEST_LOG_DIR"
    for analytics_cluster in standby primary warehouse; do
      if [ -f "$analytics_tmp/$analytics_cluster.log" ]; then
        cp "$analytics_tmp/$analytics_cluster.log" "$ANALYTICS_TEST_LOG_DIR/$analytics_cluster.log"
      fi
    done
  fi
  python3 - "$analytics_tmp" <<'PY'
from pathlib import Path
import shutil, sys
target = Path(sys.argv[1])
if target.parent != Path("/tmp") or not target.name.startswith("blast-collector.") or target.is_symlink():
    raise SystemExit("Refusing unexpected collector cleanup path")
shutil.rmtree(target)
PY
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
read -r analytics_primary_port analytics_standby_port analytics_warehouse_port < <(python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(3)]
for sock in sockets:
    sock.bind(("127.0.0.1", 0))
print(*(sock.getsockname()[1] for sock in sockets))
PY
)
start_cluster() {
  "$analytics_pg_bin/pg_ctl" -D "$analytics_tmp/$1" -l "$analytics_tmp/$1.log" \
    -o "-p $2 -c listen_addresses=127.0.0.1 -c unix_socket_directories='$analytics_tmp' -c shared_buffers=32MB -c work_mem=4MB -c max_connections=15 -c max_wal_senders=3 -c hot_standby_feedback=off" -w start >/dev/null
}
"$analytics_pg_bin/initdb" -D "$analytics_tmp/primary" -U analytics_admin --auth=trust >/dev/null
"$analytics_pg_bin/initdb" -D "$analytics_tmp/warehouse" -U analytics_admin --auth=trust >/dev/null
start_cluster primary "$analytics_primary_port"
start_cluster warehouse "$analytics_warehouse_port"
analytics_primary="postgresql://analytics_admin@127.0.0.1:$analytics_primary_port/source"
analytics_warehouse="postgresql://analytics_admin@127.0.0.1:$analytics_warehouse_port/warehouse"
"$analytics_pg_bin/createdb" -h 127.0.0.1 -p "$analytics_primary_port" -U analytics_admin source
"$analytics_pg_bin/createdb" -h 127.0.0.1 -p "$analytics_warehouse_port" -U analytics_admin warehouse
psql -X --no-password -v ON_ERROR_STOP=1 "$analytics_primary" -f "$analytics_infra/src/database_roles.sql" >/dev/null
psql -X --no-password -v ON_ERROR_STOP=1 "$analytics_primary" \
  -c 'CREATE SCHEMA blast_infra AUTHORIZATION blast_indexer' \
  -c 'CREATE TABLE blast_infra.__diesel_schema_migrations(version varchar(50) PRIMARY KEY,run_on timestamp NOT NULL DEFAULT now())' >/dev/null
# The framework merges both sources into the same scoped Diesel ledger, by version.
# Default migrations and their ledger writes are atomic; metadata opts out for concurrent indexes.
python3 - "$analytics_infra" "$analytics_sui" "$analytics_primary" <<'PY'
from pathlib import Path
import os, re, subprocess, sys, tomllib
infra, sui = Path(sys.argv[1]), Path(sys.argv[2])
paths = [*infra.glob("migrations/*/up.sql"), *sui.glob("crates/sui-pg-db/migrations/*/up.sql")]
def version(path):
    value = path.parent.name.split("_", 1)[0].replace("-", "")
    if not re.fullmatch(r"[0-9]+", value):
        raise SystemExit("Invalid migration version")
    return value
env = dict(os.environ, PGOPTIONS="-c search_path=blast_infra")
command = ["psql", "-X", "--no-password", "-q", "-v", "ON_ERROR_STOP=1", sys.argv[3]]
for path in sorted(paths, key=version):
    metadata = path.parent / "metadata.toml"
    atomic = tomllib.loads(metadata.read_text()).get("run_in_transaction", True) if metadata.exists() else True
    ledger = "INSERT INTO blast_infra.__diesel_schema_migrations(version) VALUES ('" + version(path) + "')"
    if atomic:
        subprocess.run([*command, "--single-transaction", "-f", str(path), "-c", ledger], env=env, stdout=subprocess.DEVNULL, check=True)
    else:
        subprocess.run([*command, "-f", str(path)], env=env, stdout=subprocess.DEVNULL, check=True)
        subprocess.run([*command, "-c", ledger], env=env, stdout=subprocess.DEVNULL, check=True)
PY
PGOPTIONS='-c search_path=blast_infra' psql -X --no-password -v ON_ERROR_STOP=1 "$analytics_primary" \
  -f "$analytics_infra/tests/sql/analytics_export.sql" \
  -c "INSERT INTO deployment_identity VALUES(TRUE,'mainnet',repeat('a',64))" \
  -c "INSERT INTO watermarks(pipeline,epoch_hi_inclusive,checkpoint_hi_inclusive,tx_hi,timestamp_ms_hi_inclusive,reader_lo,pruner_timestamp,pruner_hi) SELECT pipeline,0,20,21,100020,1,now(),0 FROM unnest(ARRAY['intake','market','presale']) pipeline" \
  -c 'CREATE ROLE analytics_test_source LOGIN; GRANT blast_analytics_source TO analytics_test_source' >/dev/null
psql -X --no-password -v ON_ERROR_STOP=1 "$analytics_warehouse" \
  -f "$analytics_repo/apps/workers/src/modules/analytics/warehouse.sql" \
  -c 'CREATE ROLE analytics_test_writer LOGIN; GRANT blast_analytics_writer TO analytics_test_writer' \
  -c 'CREATE ROLE analytics_test_reader LOGIN; GRANT blast_analytics_reader TO analytics_test_reader' >/dev/null
"$analytics_pg_bin/pg_basebackup" -h 127.0.0.1 -p "$analytics_primary_port" -U analytics_admin \
  -D "$analytics_tmp/standby" -R --checkpoint=fast >/dev/null
start_cluster standby "$analytics_standby_port"
printf 'Owned collector clusters: %s\n' "$analytics_tmp"
export ANALYTICS_TEST_PRIMARY_ADMIN_URL="$analytics_primary"
export ANALYTICS_TEST_STANDBY_ADMIN_URL="postgresql://analytics_admin@127.0.0.1:$analytics_standby_port/source"
export ANALYTICS_TEST_PRIMARY_URL="postgresql://analytics_test_source@127.0.0.1:$analytics_primary_port/source"
export ANALYTICS_TEST_SOURCE_URL="postgresql://analytics_test_source@127.0.0.1:$analytics_standby_port/source"
export ANALYTICS_TEST_WAREHOUSE_ADMIN_URL="$analytics_warehouse"
export ANALYTICS_TEST_WRITER_URL="postgresql://analytics_test_writer@127.0.0.1:$analytics_warehouse_port/warehouse"
export ANALYTICS_TEST_READER_URL="postgresql://analytics_test_reader@127.0.0.1:$analytics_warehouse_port/warehouse"
printf 'Collector proof: infra=%s sui=%s\n' "$analytics_infra_ref" "$analytics_sui_ref"
sha256sum "$analytics_export" "$analytics_infra/tests/sql/analytics_export.sql"
cd "$analytics_repo"
node --max-old-space-size=640 --no-warnings --import ./scripts/register-runtime-types.mjs \
  --test --test-concurrency=1 --experimental-strip-types "$@" apps/workers/test/analytics-collector.ts
