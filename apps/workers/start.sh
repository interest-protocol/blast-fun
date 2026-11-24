#!/bin/sh
# One process per Render worker: `start.sh <name>` runs that row of src/processes.ts;
# `start.sh --list` prints the names. exec delivers graceful shutdown signals to Node.
set -eu
cd "$(dirname "$0")"
exec node --no-warnings --import ../../scripts/register-runtime-types.mjs --experimental-strip-types scripts/worker.ts "$@"
