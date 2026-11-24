#!/usr/bin/env bash
# Owner-host image check. Run within the shared heavy-job guard on shared hosts.
# No credentials, database connections, keys, or transactions are required.
set -euo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
image="blast-workers:smoke-$$"
trap 'docker image rm "$image" >/dev/null 2>&1 || true' EXIT
docker build --platform "${SMOKE_PLATFORM:-linux/amd64}" -f "$root/apps/workers/Dockerfile" -t "$image" "$root"
[[ "$(docker run --rm --entrypoint id "$image" -u)" != 0 ]]
[[ "$(docker run --rm --entrypoint date "$image" +%Z)" == UTC ]]
workers="$(docker run --rm --network none "$image" /app/apps/workers/start.sh --list)"
[[ -n "$workers" ]]
while read -r worker _; do
  status=0
  output="$(docker run --rm --network none --env BLAST_SOCIAL_ENABLED=true "$image" /app/apps/workers/start.sh "$worker" 2>&1)" || status=$?
  if [[ "$status" != 1 ]] || ! grep -Eq '"metric":"(social\.)?worker\.config_error"' <<< "$output"; then
    printf '%s failed configuration smoke check (exit %s)\n' "$worker" "$status" >&2
    exit 1
  fi
  printf 'ok %s loads and refuses missing configuration\n' "$worker"
done <<< "$workers"
