# Production deployment and release safeguards

Production backend hosting moved to **Render on 2026-10-22**. The frontend
remains on **Vercel** and the existing databases remain on **Neon**. Follow
[RENDER.md](RENDER.md) for the current service inventory, endpoints, environment
loading and read-only verification.

## Release order

### Main-only releases

`main` is the only integration and release branch. `develop` is retired; target
new and existing pull requests at `main`. Render services following the monorepo
use `main` with `autoDeployTrigger=off`. Changing a source branch does not deploy
or restart a service; releases remain explicit, pinned to reviewed commits.
Preserve suspended analytics services and their retained feature source until
that separate application is restored.

`apps/web/vercel.json` and the separately connected analytics project's
`apps/web/analytics/vercel.json` keep Git deployments disabled for `main` and the
retired `develop` branch. Keep these holds: merging a PR must not deploy either
project. The analytics file does not restore the retired application.

1. Confirm the exact source commit, contract manifests, network fingerprint and
   database roles for the intended release. A hosting move changes none of them.
2. Rehearse application migrations on an isolated database, then apply pending
   migrations to the selected release database before schema-dependent code.
3. Deploy the frontend through its existing partner API release gate. Keep its
   server-only backend credentials out of browser bundles.
   Before the deploy, run `DISABLE_TELEMETRY=1 npx -y modern-web-guidance@1.0.0 legacy-scan apps/web/src --json`
   once from the repo root. It changes no files in the repo. Handle hits by the
   root `AGENTS.md` rule for issues found during a task.
4. Deploy Render services explicitly from reviewed, pinned source commits.
   Auto-deploy is disabled; pushing `main` alone changes no service.
   Preserve each service's existing database credentials and signer identity.
5. Verify ordinary authenticated data reads, provenance, freshness and worker
   progress. Liveness alone does not establish readiness or launch acceptance.
   Financial execution and any test transactions need their own authorization.

### Presale redeployments and rollback

Launchpad and presale routes are permanent. Check `BLAST_SOCIAL_ENABLED` and
`BLAST_TRADING_ENABLED` before release or rollback. Both `true` and `team`
enable their respective surface publicly. Keep the bridge at its existing disabled setting.

Deployments retain their environment snapshot. Verify the snapshot before using
Instant Rollback. Verify a private candidate on a protected preview backed by
isolated data. Check public routes, sign-in and a page that requires an account.

<a id="step-4-web-migrations-through-0104"></a>

## Application migration rehearsal and release

Command: `npm run db:migrate` (`apps/web/scripts/mission-control.ts migrate`). It runs on the primary's **direct** endpoint as the migration login, under a session advisory lock. It needs:

- `DATABASE_MIGRATION_URL` (_secret_): the direct primary endpoint, migration login, `sslmode=verify-full`;
- `DATABASE_URL` (_secret_): the pooled runtime URL. It is used to check that both name the same primary and database with different logins.

Run migrations locally before opening a PR, and record the database target and
result in its evidence. Rehearse on a disposable loopback PostgreSQL database
using the procedure below. Before deploying schema-dependent code, apply pending
migrations to that release's database from the owner's machine. A failed migration
blocks the release until resolved. Repeat the command to confirm nothing is pending;
the runner skips applied migrations and serializes concurrent runs with an advisory lock.
A disposable database's superuser may hand objects to any role, so that rehearsal cannot
catch ownership or grant failures. For a migration that changes either, also run
`runtime-roles.integration.test.ts`. It replays every migration after `0117` as a non-superuser
owner login with production's current privileges.

Vercel runs the frontend build and its configured partner API release checks,
not database migrations. Keep the direct migration credential on the owner's machine; the web deployment needs its runtime database
credentials. Migrations must remain compatible with the app still serving;
a failed build or code rollback does not undo successful migrations.

Use the same migration command from the PR or release commit's root
(`npm ci --ignore-scripts` with npm 12 first).

1. **Rehearse locally.** Create a disposable PostgreSQL database on loopback and seed the native indexer schema fixture required by the selected release. Run against it:

   ```bash
   DATABASE_MIGRATION_URL='<loopback migration URL>' DATABASE_URL='<loopback runtime URL>' npm run db:migrate
   ```

   It must apply every migration registered by the release commit, including `0127_partner_key_tiers` for the partner-policy release. A second run must print `Mission Control database is already current.`

   [release-checklist.md](../presale/runbooks/release-checklist.md) step 3 asks for this rehearsal because `0030` changes grants on existing Mission Control tables. Check that Mission Control still reads and writes under its runtime login on the branch.

2. **Production.** Run the same command with the production URLs, then again to confirm nothing is pending. Do it before deploying schema-dependent code. Check compatibility with the deployment that remains live while migration and application rollout proceed.
3. **Grants** (once both apps have migrated):

   ```sql
   GRANT blast_web TO blast_app;
   GRANT blast_replica TO blast_reader;
   GRANT blast_watcher TO blast_watch;
   ```

**Rollback:**

- The migration command runs forward migrations. A schema rollback is a Neon restore into a new branch, with the endpoints switched to it. That loses the writes made since.
- Prefer rolling forward. Check each release migration and its rollback instructions; do not assume every historical migration is reversible or additive.

## Worker packaging

The final stack runs `blast-keeper`, `vault-rewards`, `rewards-planner` and `vault-buyback` from `apps/workers/Dockerfile`, plus the separate `social` process. Each starts with `/app/apps/workers/start.sh <name>`. Follow [the worker contract and approved go-live checklist](workers.md). A source PR authorizes no Render changes. The live service configuration is declared in [render.yaml](../../render.yaml). Preserve account data, signer custody and human release evidence during the chain-only cutover.

## Release boundaries

Keep the bridge disabled and preserve the intended values of the four launch
flags. Follow the presale runbooks for day-zero republication, signer fencing,
custody and journal reconciliation,
release-gate records and recovery. A platform redeploy is not permission to
reset a database or repeat an on-chain action.
