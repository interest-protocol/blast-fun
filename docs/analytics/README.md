# Analytics foundation

This is source-only recovery of the warehouse and private summary API from the
closed, unmerged PR402. It does not activate a service. It is deliberately absent
from worker boot, Render/Vercel manifests, product requests and browser bundles.
The bounded collector now reads the independently versioned private source export.
The old dashboard and account telemetry are not recovered here. Do not reopen or
deploy the old drafts unchanged.

## Ownership and permissions

`apps/workers/src/modules/analytics/warehouse.sql` bootstraps a **new, empty,
separate database**, in one transaction, as its owner. It refuses existing user
tables and indexer schemas. This is not a product database migration. Apply it
once; future changes need a forward warehouse migration, never edits to applied
history or a destructive automatic reset.

| Process                  | Database role                                  | Permission                                                                                        |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Manual collector         | `blast_analytics_writer`                       | Read/insert/update warehouse facts, dimensions, state and snapshots; no access-code access        |
| Collector source session | `blast_analytics_source` on a physical standby | Read the private export, policy, headers and coverage; execute `require_cut`; no raw-table access |
| Summary API              | `blast_analytics_reader`                       | Select the single precomputed snapshot only                                                       |
| Future dashboard login   | `blast_analytics_access`                       | Execute the atomic code-redemption function only; cannot list/mint codes or read snapshots        |
| Local operator           | Warehouse owner                                | Apply schema and mint codes; never pass this credential to an API/dashboard                       |

The group roles have no login. Create separate login roles and grant only the
corresponding group to each one. Do not use an owner, source or product database
URL for a runtime. Existing role names and default privileges need owner review
before a release; a local superuser rehearsal does not certify provider grants.

## Exact aggregate contract

`GET /v1/summary` requires a server-to-server `Authorization: Bearer …` token.
Only `GET /live` is public; it reports process liveness without touching storage.
No query parameters, arbitrary paths, writes, per-wallet reads or per-request
aggregation are supported. Authentication precedes snapshot access. Responses
use no-store/nosniff; errors have fixed bodies without database details. A missing,
malformed or unreadable snapshot returns 503 `snapshot_unavailable`.

Version 2 keeps integer counts/checkpoints/atom amounts and USD decimals as exact
strings. `contract.ts` rejects extra fields and numeric substitutes. The summary
adds ISO `generatedAt` and `stale`; either the source cut or publication older than
one hour, a future time or an unsafe source timestamp is stale. The source cut,
coverage start, backlog flag, pricing policy and transaction scope remain visible.

- `totals` count canonical launched coin types and distinct successful product
  digests separately from receipt counts. Presale lifecycle/fundraising stays
  separate from `trade_volume`.
- Native quote totals are integer strings. Each source-validated registered-pool
  execution/hop is one `trade` fact. The warehouse does not infer a receipt from
  a balance change, price an event or claim source validation has happened.
- `pricedUsd` is the exact sum of available receipt prices. The audited total is
  null unless every receipt is priced. Half-open rolling windows end one
  millisecond after the source cut; daily rows cover the last 30 UTC dates.
- Wallets are distinct HMAC identities within declared chain coverage. They are
  separate from accounts and do not establish unique humans.
- `accountActivity`, `users.productDau` and `users.productMau` are always null in
  this foundation. No collection means unavailable, never a confirmed zero.
  DAO metrics have no canonical source and are not published.
- Since-coverage totals are not lifetime totals. Missing archive reconciliation
  cannot be repaired by relabeling the coverage start.

The source-neutral writer accepts at most 5,000 facts / 16 MiB per call. Initialize a
scope that pins the source network, deployment, export/pricing policy, exclusions, coverage and
wallet hash key, then serialize collection using advisory lock `(198401,1)`.
`importBatch` also locks the state row: completed cuts cannot rewind, partial cuts
must finish with the same digest/time, future/out-of-coverage facts are rejected,
and completed-cut retries cannot add unseen fact IDs. Facts, dimensions, totals
and cursor commit atomically. Publication uses one SQL statement and leaves the
last snapshot untouched while a cut is partial. Retries do not double count.

Source history remains an immutable operational contract. Changing an existing
fact under the same ID is not a supported correction mechanism. Reconcile and
explicitly rebuild a new warehouse scope for corrected history; there is no
unbounded historical rescan or automatic source correction detector here.

## Manual commands and configuration

`npm run analytics:refresh -w @blast/workers` performs one bounded run. It reads
nothing unless `ANALYTICS_ENABLED=true`. When enabled it requires:

| Variable                           | Meaning                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `ANALYTICS_SOURCE_DATABASE_URL`    | Direct physical-standby login holding only `blast_analytics_source`                    |
| `ANALYTICS_WAREHOUSE_DATABASE_URL` | Separate, initialized warehouse login holding only `blast_analytics_writer`            |
| `ANALYTICS_NETWORK`                | Exact source deployment network                                                        |
| `ANALYTICS_DEPLOYMENT_FINGERPRINT` | Exact 64-character lowercase hexadecimal deployment fingerprint                        |
| `ANALYTICS_FIRST_CHECKPOINT`       | Canonical nonnegative PostgreSQL bigint coverage start                                 |
| `ANALYTICS_WALLET_HASH_KEY`        | Private HMAC key of at least 32 characters; changing it requires a new warehouse scope |

The source must expose `current-lineage-receipts-v1` from blast-infra's
`2026-12-18-000000_analytics_export` migration. Every batch uses one repeatable-read,
read-only transaction on a server where `pg_is_in_recovery()` is true. It verifies
all three intake/market/presale coverage rows, deployment identity, projection and
registered-pool faults, unread archive boundaries, and completed/pending header
digests and timestamps. `require_cut` validates the native cut in that same
snapshot. Exclusion, export, pricing, hash-key or configured-coverage changes
cannot silently reuse the warehouse scope.

Each query covers at most 10,000 checkpoints and returns at most 5,001 facts.
Oversized ranges shrink; an oversized single checkpoint imports 5,000 facts and
resumes with a checkpoint-pinned fact ID using bytewise ordering. Empty ranges
advance. One warehouse session owns advisory lock `(198401,1)` until it closes.
A competing collector returns `busy` without source work. Each run stops after
20 batches or a soft 30-second budget; a query/transaction already started may
finish after that budget. The shared pool keeps 10s statements, 12s query waits,
1s lock waits and one connection per database. SIGINT/SIGTERM stop between source
reads and warehouse writes. Imported batches stay durable, but errors and cancellation leave the
last published snapshot intact. Partial checkpoints never publish. A retry
resumes its durable cursor without duplicate totals.

Only fixed metric/outcome labels are logged. Raw actors exist transiently in
the source batch and become HMAC identities before warehouse insertion. This
command has no scheduler, default worker boot hook or provider manifest. Running
it manually does not certify release load, archive reconciliation or source TLS.

`npm run analytics:api -w @blast/workers` reads only
`ANALYTICS_READ_DATABASE_URL`, `ANALYTICS_API_TOKEN` (32–4096 non-whitespace
characters) and optional `PORT` (default 8080). Configuration is parsed once at
process boot. No product process invokes this command. The pool has one connection,
ten queued reads, 10s statements, 1s locks and bounded connection/query/request
waits. Remote URLs require direct endpoints and `sslmode=verify-full`; duplicate
query keys and custom connection options are rejected. Idle-driver and boot
failures emit fixed categorical messages. A release still requires real TLS tests.

`npm run analytics:access-code -w @blast/workers` reads only
`ANALYTICS_ACCESS_ADMIN_DATABASE_URL`. It prints a fresh 256-bit base64url code
once for private sharing. Only its SHA-256 hash is stored, with one-hour expiry
measured by database time. Concurrent redemption atomically admits one caller;
expired, used or unknown codes fail. Keep command output out of public logs.
This command does not create a login route or session. The separately approved
four-hour encrypted Secure/HttpOnly/SameSite=Strict origin-bound dashboard cookie
still belongs to the future dashboard bundle.

## Local checks and remaining acceptance

Run from the repository root, using task-owned dependencies:

```sh
node --no-warnings --import ./scripts/register-runtime-types.mjs --test --test-concurrency=1 --experimental-strip-types apps/workers/src/modules/analytics/api.test.ts
node scripts/test-integration.mjs apps/workers/src/modules/analytics/warehouse.integration.test.ts
npm run typecheck -w @blast/workers
```

The integration runner creates disposable loopback PostgreSQL. The test creates
its own empty warehouse database there, exercises restricted login roles, exact
large decimals/windows, atomic rollback/retry/progress, HTTP outage/overload and
concurrent one-time redemption, and denies the product/chain fixture database.
The ordinary product `npm run db:migrate` rehearsal remains a separate PR gate.

The collector has a separate manual cross-repository proof. Supply explicit
local checkouts and full commit IDs; no sibling checkout or inherited database
URL is assumed. With the current infra export committed and the pinned Sui
dependency present, run from the repository root:

```sh
npm run analytics:test-collector -w @blast/workers -- \
  /absolute/path/to/blast-infra <infra-export-full-commit> \
  /absolute/path/to/sui 4bf6ff1e2b6d33c8cdd700728574dbf4d3a1dfc7
```

The script requires Python 3.11 or newer and local PostgreSQL 16 binaries (override
`ANALYTICS_PG_BIN` if needed). It checks the refs and dependency pin, applies the complete current
framework and infra migrations, prints export/fixture hashes, then owns three
disposable loopback clusters: primary, real physical standby and separate
warehouse. A 640 MiB Node heap runs one test at a time through the private summary
API and collector/warehouse interfaces. No test is skipped and recovery is never
mocked. The manual entry is intentionally outside automatic integration discovery
because its source contract lives in another repository. All three clusters are
removed on exit. Budget 2 GiB memory plus the 4 GiB reserve, and 2 GiB disk plus
the 8 GiB reserve, accounting for concurrent work before launching it.
