# Database foundation

Blast services use PostgreSQL. Run migrations from the repository root:

```bash
export DATABASE_URL='postgresql://user:password@host:5432/database'
# On Neon, migrations use the primary's direct endpoint as the migration login:
# export DATABASE_MIGRATION_URL='postgresql://migrator:password@<direct host>/database?sslmode=verify-full'
npm run db:migrate
```

`npm run db:reset -w @blast/web` clears Mission Control runtime data without reversing or
reapplying schema migrations. It preserves the migration ledger, reserved
callsigns, and the three configured sticky codes; resets those codes to usable;
and recreates an empty `season-zero` starting at crew number 1. It is destructive
and is intended only for a local or disposable development database.

## Disposable integration database

Docker is the only prerequisite for the focused database proof:

```bash
npm run test:integration -w @blast/server -- src/modules/mission-control/maintenance/maintenance.integration.test.ts
```

The runner starts `postgres:18-alpine` on a Docker-assigned loopback port,
waits until it is ready, runs the transactional integration test, and removes
the container on success, failure, or interruption. It does not leave a
database or background process running.

Every disposable-database suite (`scripts/with-disposable-postgres.sh` and
`scripts/with-streaming-replica.sh`) takes its image from
`scripts/postgres-image.sh`: Postgres 18, the major version production runs on
Neon. Set `MISSION_CONTROL_TEST_POSTGRES_IMAGE` to run them against another
image, for example `MISSION_CONTROL_TEST_POSTGRES_IMAGE=postgres:16-alpine npm
run test:integration`.

To use an already-running disposable database instead:

```bash
export MISSION_CONTROL_TEST_DATABASE_URL='postgresql://user:password@host:5432/database'
node --no-warnings --test --experimental-strip-types \
  packages/server/src/modules/mission-control/maintenance/maintenance.integration.test.ts
```

The test resets its database. Never point
`MISSION_CONTROL_TEST_DATABASE_URL` at shared or production data.

## Shared database roles

The database is shared with blast-infra. Migration `0030_runtime_roles`
creates the shared roles and grants every web table to the runtime role
`blast_web` (read and write, nothing else); a new web table is granted the
same way in its migration. The web roles read chain data only through
blast-infra's versioned `chain_read_v1` views; `0034_chain_read_views`
retires the web app's former `chain_v1` views. The operational worker's
tables (`0035_operational_worker`) are the exception to the `blast_web` rule:
they are granted to `blast_watcher` only
([operational-worker.md](launchpad/operational-worker.md)), and
`npm run db:reset -w @blast/web` leaves them as they are. See
[capacity.md](mission-control/capacity.md#shared-neon-runtime) for the endpoints, logins,
read routing and cache policy.

The role and routing proof runs against a disposable server (roles are
cluster-wide and must stay idempotent):

```bash
npm run test:integration -w @blast/core -- src/modules/database/runtime-roles.integration.test.ts
npm run test:integration -w @blast/server -- src/modules/read-routing/read-routing.integration.test.ts
# A real primary and streaming replica: a stopped WAL receiver degrades reads.
npm run test:integration -w @blast/server -- src/modules/read-routing/replica-streaming.integration.test.ts
```

## Write ownership

Module-scoped transactions write only their tables in `TABLE_OWNERSHIP`.
Cross-module workflows coordinate the owning repositories within one transaction.
Historical campaign tables and previously applied migrations stay in place.
