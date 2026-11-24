# Blast workers

Run a worker with `npm run worker -w @blast/workers -- <name>` or `start.sh <name>`; `start.sh --list` prints the names (`blast-keeper`, `vault-rewards`, `rewards-planner`, `vault-buyback`, `social`). Each is one row of [`src/processes.ts`](src/processes.ts). See [the worker contract](../../docs/deploy/workers.md) and [.env.example](.env.example).

Use the shared Effect [process scope](src/lib/worker-process.ts) for startup
and cleanup and the shared [poll loop](src/modules/worker-runtime/poll.ts)
for scheduled passes. Shutdown interrupts the wait and lets any active pass
finish. Keep retry state with the job.
