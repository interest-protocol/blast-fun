# BLAST.FUN

Blast is a launchpad on Sui. This repository contains the Next.js web app, the
Bun and Effect backend, TypeScript workers, and shared protocol and server code.

## Start locally

Use Node 24.18 or newer within Node 24 and npm 12.0.2 or newer within npm 12.
Backend development and tests also use Bun 1.4.2. Run these commands from the
repository root:

```sh
npm ci --ignore-scripts
BLAST_DEPLOYMENT_TARGET=local NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000 npm run dev -w @blast/web -- --hostname 127.0.0.1
```

Open [the local app](http://127.0.0.1:3000). Features that depend on configured
services may be unavailable. For local configuration, see the examples for
the [web](apps/web/.env.example), [API](apps/backend-api/.env.example) and
[workers](apps/workers/.env.example). Keep credentials in ignored local files
or your own environment. Every `NEXT_PUBLIC_*` value is public configuration.

## Check a change

```sh
npm run lint
npm run typecheck
npm test -w @blast/web
```

Replace `@blast/web` with the affected workspace. `npm test` runs unit tests
across the repository. Use Docker for the integration harness's disposable
loopback PostgreSQL and Valkey services. Run one integration file from the
repository root by passing its path to the integration harness.

```sh
node scripts/test-integration.mjs apps/backend-api/test/physical.integration.test.ts
```

Run `npm run gate` for the full local gate.
See [backend local verification](apps/backend-api/README.md#local-verification)
for its service requirements.

To verify that the production build excludes developer routes and test fixtures:

```sh
BLAST_DEPLOYMENT_TARGET=local NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000 npm run build -w @blast/web
CHECK_PRODUCTION_BUILD=1 node --no-warnings --import ./scripts/test-tsx-hooks.mjs \
  --test --test-concurrency=1 --experimental-strip-types apps/web/test/production-boundaries.test.ts
```

## Rehearse database migrations

With dependencies installed and Docker running, run this from the repository
root before opening a code PR:

```sh
BLAST_DEPLOYMENT_TARGET=local bash scripts/with-disposable-postgres.sh \
  bash -c 'npm run db:migrate && npm run db:migrate'
```

The harness creates and seeds a disposable PostgreSQL database on loopback,
sets both database URLs and removes the database on exit. The first run lists
applied migrations. The second prints `Mission Control database is already current.`
For changes to grants or ownership, also run the
[`runtime-roles` integration test](packages/core/src/modules/database/runtime-roles.integration.test.ts).

## Find the code

| Workspace | Responsibility |
| --- | --- |
| [`@blast/web`](apps/web/package.json) | Next.js UI and browser-facing HTTP adapters |
| [`@blast/backend-api`](apps/backend-api/README.md) | Effect HTTP contracts, private and public API routing, and transport |
| [`@blast/workers`](apps/workers/README.md) | Background jobs and process entry points |
| [`@blast/core`](packages/core/package.json) | Shared protocol, persistence and route contracts |
| [`@blast/server`](packages/server/README.md) | Server workflows, provider integrations and persistence operations |

Each workspace's `package.json` lists its commands. See the
[contribution guidance](AGENTS.md) for platform and architecture boundaries and
the [security policy](SECURITY.md) for reporting vulnerabilities.

## License

Blast's first-party web app, API, workers, and the shared code that supports them
are licensed under [Apache 2.0](LICENSE).

Third-party code and assets carry their own terms. See the
[web software notices](apps/web/public/software-notices.txt), the
[analytics fonts](apps/web/analytics/public/fonts/README.md), the
[server fonts](packages/server/assets/mission-control/fonts/LICENSE.txt), and the
[Zod backport](vendor/zod-v3/README.md). The pinned Blast SDK packages are covered
by the [SDK 0.3.0 license grant](https://github.com/interest-protocol/blast-v2-sdk#license-for-sdk-030).
Forks that use the wallet integrations through Privy are subject to the
[Reown AppKit](apps/web/public/licenses/reown-appkit.md) and
[WalletConnect](apps/web/public/licenses/walletconnect.md) terms for those components.
The code license grants no rights to Blast trademarks.

The [Blast Move contracts](https://github.com/interest-protocol/blast-v2-contracts)
are maintained separately under their
[Business Source License](https://github.com/interest-protocol/blast-v2-contracts/blob/main/LICENSE).
