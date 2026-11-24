#!/usr/bin/env bash
# Owns one shared heavy-job slot through build, disposable DB and foreground load.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."
mode="${1:-run}"
case "$mode" in
  smoke) peak_gib=2; disk_gib=1 ;;
  build) peak_gib=4; disk_gib=6 ;;
  run) peak_gib=6; disk_gib=2 ;;
  *) echo "Usage: $0 build|smoke|run" >&2; exit 2 ;;
esac
heavy_slot_acquired=0
for heavy_lock_path in \
  /home/ubuntu/.cache/codex-heavy-task.lock \
  /home/ubuntu/.cache/codex-heavy-task-2.lock \
  /home/ubuntu/.cache/codex-heavy-task-3.lock
do
  exec 9>"$heavy_lock_path" || exit 75
  if flock -n 9; then heavy_slot_acquired=1; break; fi
  exec 9>&-
done
[ "$heavy_slot_acquired" -eq 1 ] || exit 75
awk -v required="$(((peak_gib + 4) * 1048576))" '$1 == "MemAvailable:" { available = $2 } END { exit (available < required) }' /proc/meminfo || exit 75
awk '$1 == "full" { split($2, value, "="); ok = (value[2] < 1) } END { exit !ok }' /proc/pressure/memory || exit 75
export CARGO_BUILD_JOBS=1
export ACTIVE_LOAD_DIR="${ACTIVE_LOAD_DIR:-$PWD/apps/web/loadtest/.data/active-users}"
mkdir -p "$ACTIVE_LOAD_DIR"
available_kib="$(df -Pk "$ACTIVE_LOAD_DIR" | awk 'NR == 2 {print $4}')"
if [ "$available_kib" -lt "$((disk_gib * 1048576))" ]; then
  echo "Need ${disk_gib} GiB free disk for $mode; use a dedicated test host/build directory." >&2
  exit 75
fi
export WALLET_SCALE_HTTP_DIR="${WALLET_SCALE_HTTP_DIR:-$ACTIVE_LOAD_DIR/build}"
case "$mode" in
  build) exec node apps/web/loadtest/wallet-http-build.mjs ;;
  smoke) export ACTIVE_LOAD_MODE=smoke ;;
  run) unset ACTIVE_LOAD_MODE ;;
esac
exec bash scripts/with-disposable-postgres.sh node --no-warnings --import ./scripts/test-tsx-hooks.mjs apps/web/loadtest/active-users/run.mjs
