# Mission Control capacity record

The [shared Neon runtime](#shared-neon-runtime) still describes the roles and
connection paths used by the app. The campaign capacity notes preserve the
original test conditions and results. Use the current [release runbook](../deploy/RENDER.md)
and [local load tests](load-testing.md) for operational instructions.

## Campaign region co-location (historical)

Decided 2026-09-25: **production** runs entirely in **US East**: functions in
Vercel **iad1** (pinned in `apps/web/vercel.json`), the database in a Neon project in
**aws-us-east-1** (its pooler lives with it), and the card-image Blob store in
iad1.

An older development profile used **eu-west-2** (London) with functions in
iad1; the historical load tests measured about 75 ms per cross-Atlantic round
trip. Treat that as a historical profile, not the current deployed target.
Preserve each local database identity and inspect the selected environment
before drawing latency conclusions. Never load-test the development deployment.
US East also keeps Privy and X,
which the claim and share flows call, close to the functions. Pages and card
images are served from Vercel's CDN worldwide either way.

If a database ever moves region, move `regions` with it in the same release.

### Original production setup in US East

Neon's connection pooler (PgBouncer) comes with every Neon endpoint; there is
nothing to enable. Each endpoint has two connection strings: the **pooled**
one (host contains `-pooler`, "Connection pooling" on in Neon's Connect
dialog) for the app, and the **direct** one for migrations and copies.

1. Create a Neon project in **AWS us-east-1** on **Postgres 18**, the major
   version the database suites and the load test run on.
2. Apply the migrations over the **direct** URL as the migration login:
   `DATABASE_MIGRATION_URL=<direct URL> DATABASE_URL=<pooled URL> npm run
   db:migrate`, and run it again to confirm nothing is pending (see
   [Shared Neon runtime](#shared-neon-runtime) for the logins and roles).
3. In Vercel's **Production** environment: `DATABASE_URL` = the **pooled**
   primary URL, `DATABASE_REPLICA_URL` = the replica's **pooled** URL and
   `BLAST_INFRA_ORIGIN` = blast-infra's origin and `BLAST_INFRA_API_KEY` = its
   key (both server-only, never `NEXT_PUBLIC_`); create the Blob store in iad1 and connect it to the project (it adds
   `BLOB_READ_WRITE_TOKEN`); `CARD_IMAGE_BLOB_ACCESS=private`; `CRON_SECRET`;
   and the production Privy, SocialData, and official X credentials. Never set
   the load-test mock origins (`PRIVY_API_BASE_URL`, `X_AVATAR_ORIGIN`,
   `SOCIAL_DATA_API_BASE_URL`, `X_API_BASE_URL`).
   Browsers never talk to blast-infra: the coin page reads Holders, the chart
   and Activity through this app's `/api/launchpad/market/*` routes
   ([coin-page.md](../launchpad/coin-page.md#market-routes)), which send the
   key in `x-blast-infra-key`. blast-infra needs no CORS allowance for this
   site, and the page CSP's `connect-src` names no blast-infra origin. Once
   `BLAST_INFRA_ORIGIN` is set, remove the deprecated
   `NEXT_PUBLIC_BLAST_INFRA_ORIGIN` (no longer read; delete it from every deployment).
4. Deploy, then run the checks below.

### Carrying development's members into production (only if wanted)

Use the **direct** hosts for both databases.

1. Stop writes on the development database so nothing is lost during the copy,
   as its owner: `ALTER ROLE <app role> SET default_transaction_read_only = on;`
   then end the app's open sessions (`SELECT pg_terminate_backend(pid) FROM
   pg_stat_activity WHERE usename = '<app role>' AND pid <> pg_backend_pid();`).
   Sign-ups answer "unavailable" until the cut-over; pages keep reading.
2. Copy the data into the migrated production database with the Postgres 18
   client tools (`pg_dump --version`; an older `pg_dump` refuses a newer
   server): `pg_dump
   --format=custom --data-only --no-owner <dev direct URL> | pg_restore
   --data-only --no-owner --disable-triggers --single-transaction -d <prod direct URL>`.
   Sequences come across with their values; the crew-number sequence must be
   at or above the highest crew number.
3. Check the copy: row counts of the `mission_control_*` tables match, and
   `PGOPTIONS='-c default_transaction_read_only=on' psql <prod direct URL> -X -f
   loadtest/verify-invariants.sql` reports every invariant at 0.

Verify after deploying:
`curl -sI <site>/api/mission-control/season-zero | grep x-vercel-id`. The
second segment must be the region you chose. Then compare the `db.transaction`
`durationMs` for `label=completion` before and after the move.

## Database connections

- `DATABASE_URL` for the app **must be Neon's pooled endpoint** (host contains
  `-pooler`). Each function instance keeps up to `DATABASE_POOL_MAX` client
  connections, and Fluid compute can run dozens of instances. The pooler
  (PgBouncer in transaction mode) accepts up to 10,000 client connections and
  multiplexes them onto a backend pool of about 0.9 × the compute's
  `max_connections`. A direct host fails with `53300 too_many_connections` as
  soon as instances × pool max exceeds the compute's limit (about 112 at
  0.25 CU, 225 at 0.5 CU, 450 at 1 CU; check your plan).
- Run **migrations against the direct endpoint** (the same host without
  `-pooler`). `db:migrate` uses a session-level advisory lock, which a
  transaction-mode pooler does not tie to one session.
- Every route shares `primaryPool()` (`database/pool.ts`), one pool per
  instance, registered with `attachDatabasePool`. That keeps a suspending
  instance alive until idle clients have closed. The cost is up to
  `DATABASE_POOL_IDLE_TIMEOUT_MS` of extra wall time per invocation, which is
  not billed as active CPU. The pool lives on `globalThis`
  (`lib/process-singleton.ts`): Next.js loads `pool.ts` once for route
  handlers and again for page rendering, and before this each copy kept its
  own pool, so an instance could hold twice `DATABASE_POOL_MAX` (66
  connections across 4 instances of 10 in the first browse run).
- `withTransaction` sets `statement_timeout`, `lock_timeout` and
  `idle_in_transaction_session_timeout` with `SET LOCAL` in the same round trip
  as `BEGIN`, which works through PgBouncer's transaction pooling. `pg`'s
  client-side `query_timeout` (statement timeout + 2 s) bounds a query that the
  pooler queues before PostgreSQL starts timing it.
- A transaction costs at least three round trips (BEGIN with the timeouts, the
  statement, COMMIT), so the hot single-statement reads skip it:
  `autocommitRead` sends one SELECT with no BEGIN or COMMIT. At READ COMMITTED
  a lone statement sees what it would have seen inside a transaction; it gives
  up only the SET LOCAL lock and idle timeouts, and the statement budget is
  enforced on the client instead. It refuses row and advisory locks. The same
  holds for `autocommitWrite`, used for the rate-limit upsert, the abuse
  decision audit, admission failures, the wallet challenge, the
  member-session refresh, and the card-image catalog row. Reads
  that take locks or must agree with another statement stay in transactions.
- The admission GET serves the sticky configuration from a per-instance
  cache for 60 s (`StickyConfigurationCache`), one read per instance a minute
  instead of one per visitor. Sticky codes cannot change once seeded (trigger
  and `seed-sticky` conflict), the response carries no enabled or consumed
  state, and a failed read (codes not seeded yet) is never cached, so the
  codes appear as soon as they are seeded.
- A backend that dies mid-transaction rejects that transaction and never
  crashes the instance. BEGIN on a stale pooled connection retries once on a
  fresh one, and so does an autocommit read. Neither is resent after it ran
  into its timeout: that is a saturated pooler, and a second send would
  double the load.
- When the database cannot serve a claim step (no free pool connection
  within `DATABASE_CONNECT_TIMEOUT_MS`, a lost connection, a statement or lock
  timeout, contention past its retries), the route answers 503 with
  `Retry-After: 5`, never 500 (`database/availability.ts`). The onboarding
  client resends the same request at most twice after that wait plus up to
  1 s of jitter (`components/mission-control/claim-retry.ts`); completion
  resends reuse the Idempotency-Key, so they return the same claim.

| Variable | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `DATABASE_POOL_MAX` | 10 | 1–50 | Connections per function instance |
| `DATABASE_CONNECT_TIMEOUT_MS` | 5000 | 250–30000 | Wait for a free pool connection |
| `DATABASE_POOL_IDLE_TIMEOUT_MS` | 10000 | 1000–120000 | Close idle connections after |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 8000 | 500–120000 | Per statement, server side |
| `DATABASE_LOCK_TIMEOUT_MS` | 3000 | 100–60000 | Per lock wait, server side |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 15000 | 1000–120000 | Abort a transaction left idle |

Sizing the pool:

Fresh partner grants use a dedicated primary login and one process-wide pool
(`blast-partner-verifier`) with at most two connections per backend API process.
Budget those connections alongside the primary pool and any reporting, worker
or other dedicated connections. Acquisition is bounded at 1,000 ms, statements
at 500 ms, client queries at 750 ms and verifier lock waits at 100 ms.
Monitor acquisition failures alongside waiting counts. Partner admission and
verified-key endpoint quotas use Redis. PostgreSQL counters remain available
for other durable budgets and for eligible first-party reads when Redis is unset.
First-party unversioned paths reject partner keys and retain their own IP
controls. Other primary work uses the normal pool's longer budgets. Product
reads and upstream requests still have separate budgets;
a fast auth failure does not establish an end-to-end two-second failure bound.

- **Client connections.** Instances × `DATABASE_POOL_MAX` must stay under the
  pooler's 10,000. At the default of 10 that is 1,000 instances; 4 instances
  use 40 and 50 instances use 500. Even the upper bound, 50, leaves room for
  200 instances. Client connections are cheap: an idle one holds no backend.
- **Backends.** A client connection holds a PostgreSQL backend only while a
  statement or transaction runs, so what counts is how many run at once
  across all instances. Keep that below about 0.8 × the pooler's backend
  pool (0.9 × `max_connections`): about 80 at 0.25 CU, 160 at 0.5 CU, 320 at
  1 CU. When more run at once the pooler queues them (no error), and
  `query_timeout` bounds the wait. Instances × pool max is the worst case: 4
  instances × 10 is 40 backends, within even 0.25 CU; 50 × 10 is 500, which
  needs 2 CU if every connection were busy at once.
- **Hold time.** A request holds its connection for every round trip it makes
  on it. At today's ~75 ms, a three-round-trip transaction holds a connection
  about 225 ms, so 10 connections serve at most about 44 such transactions a
  second per instance, or about 133 single-statement reads. The 2026-09-25
  local flash-crowd run (4 instances × 5 connections, about 5 transactions per
  arrival) queued 130–150 requests per instance for 1.3–1.5 s while
  PostgreSQL had 0–1 active backends: the connections sat idle in transaction,
  waiting on the app between statements. Each round trip removed is one such
  wait fewer, and in production each is also a 75 ms network round trip.
  Co-locating the functions with the database (see above) cuts a round trip
  to a millisecond or two and remains the biggest lever; fewer round trips and
  a larger pool only soften the distance.

Watch `db.pool` (`waiting`, `maxWaitMs`) and `db.acquire` in the logs, and
`db.read_retry` for reads resent after a dead connection.

### Round trips per claim step

Measured by `completion/claim-round-trips.integration.test.ts` against a local
PostgreSQL, with the steps wired as the app routes wire them. Each round trip
is about 75 ms on development (iad1 to eu-west-2) and a millisecond or two
once co-located. The claim transaction holds its connection and locks for 22
of the fresh claim's round trips (BEGIN, 20 statements, COMMIT; one more with a
referral).

| Step | Before (1dd8fbf) | Now | Where the difference comes from |
| --- | --- | --- | --- |
| Admission POST | 8 | 7 | capacity read and audit insert autocommit; the code lookup and attempt insert stay one transaction (the lookup decides the write) |
| Callsign check | 7 | 4 | admission lookup autocommit; availability read in the attempt-count statement |
| Wallet challenge | 7 | 4 | admission lookup and challenge insert autocommit; one more for the per-IP `wallet_ip` limit (0e2b24bc) |
| Wallet proof | 8 | 7 | admission lookup autocommit (verify stays a locking transaction); one more for the per-IP `wallet_ip` limit (0e2b24bc) |
| Completion, fresh claim | 34 (27 in the transaction) | 25 (22) | events in one INSERT, both identities in one INSERT, admission lookup and stored-proof check autocommit |
| Completion, replay | 13 | 9 | admission lookup and stored-proof check autocommit |

Locks and the reads that must see the previous lock holder's commit stay
separate statements (idempotency lock then lookup, claim locks then conflict
check, season lock then cutoff read): under READ COMMITTED a statement's
snapshot is taken when it starts, so a read merged into the lock statement
could miss that commit.

### Neon settings for the launch window

- Disable scale-to-zero (suspend) on the production primary.
- The planning baseline is primary autoscaling at 1–4 CU. A historical
  2026-10-23 provider observation recorded 1–8 CU; approval of that higher
  cost ceiling is unconfirmed. This record does not change provider settings.
  Raise the minimum to 2 CU only if the
  Neon-branch load test shows CPU above 70% at the target claim rate.
- Keep the replica warm at a 1 CU minimum with suspend off for the window
  (see [Shared Neon runtime](#shared-neon-runtime)).
- Keep the `-pooler` hosts in `DATABASE_URL` and `DATABASE_REPLICA_URL` and
  the direct host in `DATABASE_MIGRATION_URL` only.

## Shared Neon runtime

The launchpad adds blast-infra, the Rust checkpoint indexer, to the same
database. There is still one Neon project, one production branch and one
logical database: blast-infra writes the chain tables, the web app writes its
own tables, and both read through it. What is new is a same-region **read
replica** that takes the terminal's chain joins off the primary.
`packages/core/src/modules/database/topology.ts` validates endpoint identity
and region (`NEON_REGION`, beside `VERCEL_REGION`). The compute table below is
the planning baseline; nothing in code provisions or enforces compute size.
A dated observation (2026-10-23) saw the primary at up to 8 CU, with the
cost-ceiling approval unconfirmed; it is historical and was not rechecked
during local-only work.

### Computes and region

| Compute | Endpoint use | Autoscaling | Scale to zero |
| --- | --- | --- | --- |
| Primary (read-write) | blast-infra ingestion and migrations (direct); web writes, consistency-sensitive, social and moderation reads (pooled); the watcher (its own small pool); web migrations (direct) | 1–4 CU planning baseline; historical 1–8 CU observation requires cost approval | off |
| Read replica | web chain joins: search and thesis over blast-infra's `chain_read_v1` views (pooled) | 0.5–4 CU | allowed outside launch windows |

- Both computes are in Neon **aws-us-east-1**, beside Vercel **iad1**
  (`apps/web/vercel.json`) and blast-infra's host. In a production deployment identity
  the web app refuses an endpoint that is not a Neon host in that region.
- **Launch-window condition.** For a launch window, and from 30 minutes
  before it, set the replica's minimum to **1 CU** and turn its scale to zero
  off, so the first chain joins do not wait for a cold or undersized replica.
  Return it to 0.5 CU afterwards.
- Primary and replica scale independently; so do their pools
  (`DATABASE_POOL_MAX`, `DATABASE_REPLICA_POOL_MAX`, each 1–50, default 10)
  and blast-infra's (`DATABASE_POOL_MAX` plus 16 history reads on the
  primary's direct endpoint). Keep blast-infra's direct connections plus the
  pooler's backend pool under the primary's `max_connections`.

### Endpoints

| Variable | Endpoint | Used by |
| --- | --- | --- |
| `DATABASE_URL` | primary, pooled (`-pooler`), `sslmode=verify-full` | `primaryPool()`: `databaseFor("write" \| "consistent-read" \| "social" \| "moderation")`, and a thesis join's primary fallback |
| `DATABASE_REPLICA_URL` | read replica, pooled, `sslmode=verify-full` | `replicaPool()`: `databaseFor("search" \| "thesis-join")`, through `readChainJoin` |
| `DATABASE_MIGRATION_URL` | primary, direct, a different login, `sslmode=verify-full` | `npm run db:migrate` and `db:reset` |
| `BLAST_INFRA_ORIGIN` | blast-infra's origin, server-only: one bare http(s) origin, https in production, naming a DNS host or IP address; a wildcard or other host character is refused (`NEXT_PUBLIC_BLAST_INFRA_ORIGIN` is no longer read) | every server read of `/v1` (`defaultMarketDataDependencies`, the market routes, the presale readers) |
| `BLAST_INFRA_API_KEY` | secret: 32 to 512 printable characters, sent as `x-blast-infra-key` to `BLAST_INFRA_ORIGIN` only (`blastInfraFetch`) | every server and worker request to blast-infra |
| `WATCHER_DATABASE_URL` (the watcher's own process) | primary, pooled, `sslmode=verify-full`, the watcher login | the watcher only; see [The watcher](#the-watcher) |

`WORKLOAD_ROUTES` (`modules/read-routing/resources.ts`) is the one table of
which workload goes to which compute or to blast-infra; `databaseFor` takes
pools from it and nowhere else.

Application Node pools and the partner release gate's cleanup pool send exactly
one `sslmode=verify-full` for Neon, including direct operator/migration connections. Legacy sealed URLs with exactly
one `sslmode=require` are normalized in memory before validation and driver
construction; their stored secrets, endpoint, region, database and login are
preserved. This pins certificate and hostname verification instead of relying on
the driver's changing interpretation of `require`. Hostname-blind `verify-ca`,
`prefer`, `disable`, `no-verify`, duplicate TLS modes, `uselibpqcompat` and query
parameters overriding the URL's host, port or login are refused. New operator
URLs should explicitly use `verify-full`. Local PostgreSQL fixtures need no TLS.

Each accessor fails closed: a missing endpoint throws, and so does one that is
the wrong kind (a direct host in `DATABASE_URL`, a pooler in
`DATABASE_MIGRATION_URL`), that names the primary as the replica, another
database, another region or endpoint, or plaintext. Nothing falls back to
another endpoint, and messages name the variable, never the URL. None of the
database variables has the `NEXT_PUBLIC_` prefix, so none reaches a client
bundle; metrics carry error labels only. Without live Neon credentials every
database accessor stays unconfigured and throws.

### Logins and roles

blast-infra's `2026-09-30-000000_database_roles` and the web app's
`0030_runtime_roles` create the same NOLOGIN roles; logins hold them:

| Role | May | Login that holds it |
| --- | --- | --- |
| `blast_indexer` | own the chain tables, write them, create each month's partitions (CREATE on `public`) | blast-infra's engine login (`blast_engine`) |
| `blast_migration` | holds `blast_indexer`: chain schema changes | the migration login (`blast_migrator`), which also owns the web tables it created |
| `blast_web` | read and write every `mission_control_*` table but the worker's and draw crew numbers; read blast-infra's `chain_read_v1` views. The launchpad's social tables (`0036_launchpad_social`) are insert-only: a post's visibility is its only updatable column, and only search rows can be deleted | the web runtime login in `DATABASE_URL` |
| `blast_replica` | read the `chain_read_v1` views for the thesis and search joins' launch identity. `0036_launchpad_social` also grants it SELECT on the launchpad's posts and search rows, which no read uses any more: posts, visibility and search rows are read on the primary (see [social](../launchpad/social.md#public-reads)); revoking that grant needs a migration (follow-up). Never the social author identities | the login in `DATABASE_REPLICA_URL` |
| `blast_watcher` | read the `chain_read_v1` views; read and write the operational worker's tables (`0035_operational_worker`: leases, job state, Coin Registry registrations), which no other role may use | the watcher login (`blast_watch`) in `WATCHER_DATABASE_URL` |
| `blast_social` | read the `chain_read_v1` views. Unused: social writes go through the launchpad mutation guard on the web runtime's pool, so the social tables are `blast_web`'s (see [social](../launchpad/social.md)) | no login holds it yet |

Nothing else is granted: the web, replica, watcher and social roles cannot
read or write a chain table (blast-infra's migration
`2026-09-30-100000_chain_read_views` grants them only its views), create a
table, TRUNCATE or ALTER, or read the migration ledger, and blast-infra
cannot read a web table. `runtime-roles.integration.test.ts` checks each role
against PostgreSQL. A migration that adds a web table grants it to
`blast_web` (`SELECT, INSERT, UPDATE, DELETE`); the same test fails until it
does. The web migration never revokes `blast_indexer`'s CREATE on `public`.

Once, as the migration login (Neon: the database owner):

```sql
CREATE ROLE blast_app LOGIN PASSWORD '<generated>';     -- DATABASE_URL
CREATE ROLE blast_reader LOGIN PASSWORD '<generated>';  -- DATABASE_REPLICA_URL
CREATE ROLE blast_watch LOGIN PASSWORD '<generated>';   -- WATCHER_DATABASE_URL
-- after both apps have migrated once:
GRANT blast_web TO blast_app;
GRANT blast_replica TO blast_reader;
GRANT blast_watcher TO blast_watch;
```

Roles and logins are cluster-wide, so the replica has them too.

### The watcher

The watcher is its own process, not a Next.js route, so it never shares the
web runtime's login or pool. It connects to the **primary**, never the
replica: what it watches must see the latest commit.

- Endpoint: the primary's **pooled** endpoint in `WATCHER_DATABASE_URL`, as
  `blast_watch` (holds only `blast_watcher`), `sslmode=verify-full`.
- Pool: at most 2 connections (`WATCHER_DATABASE_POOL_MAX`, 1–2, default 2),
  the same statement, lock and idle-in-transaction timeouts as the web runtime
  (`DATABASE_*_TIMEOUT_MS`), and no session state (transaction-mode pooler):
  its leases are rows, not advisory locks.
- The watcher today is the operational worker (`npm run worker -w @blast/workers -- blast-keeper`,
  [docs/launchpad/operational-worker.md](../launchpad/operational-worker.md)).
  One process per signer key is active; a second is an idle standby (a lease
  row keyed by the signer), so it adds no connections in use.
  `watcherPooledUrl` and `watcherPoolSettingsFromEnvironment` read its
  endpoint and pool; the web app never does.
- If a watcher ever needs session state (LISTEN, a session advisory lock), it
  moves to the primary's **direct** endpoint with one connection, and that
  connection counts against the primary's `max_connections` beside
  blast-infra's.
- Its responses and endpoints are never public-cacheable (`watcher` class
  below).

### chain_read_v1 views

blast-infra publishes and owns the versioned chain read views (its migration
`2026-09-30-100000_chain_read_views`, its `docs/deploy.md`), and they are the
only chain relations the web app reads:

- `chain_read_v1.coins`: coin type, Coin Registry name, symbol, description
  and icon, decimals, launcher, creator, current pool, creation checkpoint
  and time;
- `chain_read_v1.pools`: pool key, venue, pool id, coin, quote, lifecycle,
  creation checkpoint and time;
- `chain_read_v1.watermark`: the indexed network and SDK deployment
  fingerprint, the chain id, the committed checkpoint and its timestamp, the
  database's observation time and the lag. Every chain read takes its
  provenance from it, on the replica or the primary.

Market numbers (reserves, supply, prices) are not in the views: they come
from blast-infra's `/v1`, and the web app never recomputes them in SQL.
`assertChainReadThroughViews` (`database/modules.ts`) refuses a chain join
that names a blast-infra table, and PostgreSQL refuses it too.

The web app's own `chain_v1` views, which earlier releases created after
migrating, are retired: migration `0034_chain_read_views` drops them, and
`npm run db:migrate` no longer creates views.

**Rollout order across the two repositories.**

1. blast-infra first: set `BLAST_NETWORK` and `BLAST_DEPLOYMENT_FINGERPRINT`
   on its host, then redeploy it (blast-infra `docs/deploy.md`); its migration
   `2026-09-30-100000_chain_read_views` publishes `chain_read_v1`. The old web
   release keeps reading `chain_v1`, whose views run as the migration login
   that created them.
2. Then the web release that reads `chain_read_v1`, with `npm run
   db:migrate` (`0034_chain_read_views` drops `chain_v1`).

A web release with `0034` deployed before blast-infra's migration finds no
`chain_read_v1`, and every search and thesis join fails with 42P01 until
blast-infra migrates. **Rollback reverses the order:** first roll the web app
back to a release without `0034` and run its `npm run db:migrate`, which
recreates `chain_v1` through the migration login (`0034`'s down restores
nothing); then roll blast-infra's `chain_read_views` back. Rolling blast-infra
back first leaves a web release with `0034` without any chain contract. A breaking view change ships
from blast-infra as `chain_read_v2` beside `chain_read_v1`; the web app moves
to it, then blast-infra drops `chain_read_v1`.

### Read routing

`modules/read-routing` decides where each read goes (`WORKLOAD_ROUTES`).
Freshness is chain time: how long ago the source's committed checkpoint was
produced. That age includes blast-infra's own delay. When the replica is
outside a resource's policy, the rule is exactly:

- **Replica lag** (`replica-lag`): the primary's checkpoint is strictly ahead
  of the replica's **and** the primary itself is within that resource's
  policy. Only then may a chain join move to the primary.
- **Indexer lag** (`indexer-lag`): every other case with both reachable: the
  primary's checkpoint is equal, or ahead but the primary is also outside the
  policy (blast-infra lagging, catching up or halted). The join stays on the
  replica, stale; the primary gets no chain-join query.
- `primary-unavailable` when the primary cannot be probed or fails the join
  (the replica answers, stale), `replica-unavailable` when the replica
  cannot answer, and `no-checkpoint` before blast-infra's first checkpoint.

| Resource | Host | When the host lags or fails |
| --- | --- | --- |
| discovery market facts, market reads, live updates | blast-infra `/v1` | lag above 30 s (the answer's own `provenance`): **Stale** with the lag and checkpoint; starting (`not_ready`), unreachable, 5xx, no checkpoint yet, an answer without a valid `provenance`, or one about another deployment (`BLAST_NETWORK`, `BLAST_DEPLOYMENT_FINGERPRINT`): **Unavailable** |
| search | replica for chain identity; primary for the theses group's posts and search rows | chain identity: checkpoint older than 10 s: **Stale** on the replica with its age and reason (`replica-lag`, `indexer-lag` or `primary-unavailable`), up to 120 s; beyond that or before the first checkpoint: **Unavailable** with the reason; replica down: **Unavailable** (`replica-unavailable`); the chain join never runs on the primary. Theses group: its posts and search rows are read on the primary (a hidden post stops matching at once), so a primary outage makes that group alone **Unavailable** (`social-unavailable`) while the launch groups answer |
| thesis join | replica for chain identity; primary for posts | chain identity: checkpoint older than 5 s with `replica-lag` (primary strictly ahead and itself within 5 s): a **fresh primary** read; with `indexer-lag` or `primary-unavailable`: the replica's answer, **Stale**; replica down: a primary read marked `replica-unavailable` (**Stale** if the primary is older than 5 s); before the first checkpoint: **Unavailable**. A launch's posts and their visibility are always read on the primary, so a hidden post leaves at once; a primary outage makes the list **Unavailable** (`social-unavailable`, 503 with `Retry-After`) |
| social, moderation, consistency-sensitive reads | primary | database unavailability: 503 with `Retry-After` |

Every result carries its provenance (`Provenance`, the launchpad contract's
shared shape): source, `network`, `deployment` (the canonical SDK's
deployment fingerprint), `checkpoint` and its `timestampMs`, when the source
observed it (`observedAt`), its age (`lagMs`), and the reason for any
degradation. blast-infra puts it in every `/v1` answer and WebSocket frame;
a database gives it through `chain_read_v1.watermark`. With `BLAST_NETWORK`
and `BLAST_DEPLOYMENT_FINGERPRINT` set, an answer about another deployment is
Unavailable. An Unavailable result has no
data: never a zero, an empty list, or a value recomputed in SQL. There is no
Next.js fallback for market data.

A database's position is one pooled statement: `pg_is_in_recovery()` and
`chain_read_v1.watermark` (network, deployment fingerprint, checkpoint, age on that database's clock),
cached per instance for a second. A replica whose WAL receiver or replay has
stopped keeps its old checkpoint, so its age grows past the policy even when
PostgreSQL reports everything received as replayed
(`replica-streaming.integration.test.ts`, `npm run test:integration -w @blast/server -- src/modules/read-routing/replica-streaming.integration.test.ts`).
A replica endpoint that is not in recovery is a configuration error.
A `/v1` refusal (4xx) has no body provenance and takes the engine's from
`/v1/status`, read once per origin per second.

**For T-034 to measure (indexer lag against the policies).** Because
freshness includes blast-infra's delay, its normal provider and commit delay
counts against the 5 s thesis and 10 s search policies: measure that delay
(`blast_checkpoint_lag_seconds`, `chain_read_v1.watermark` age on the primary) and
how often each policy trips on indexer lag alone. During a long blast-infra
halt search is Stale until its checkpoint is 120 s old and then Unavailable,
and thesis joins stay Stale on the replica; confirm those outcomes and
thresholds are acceptable to the product, or change the policies.

### CDN caching

`withCachePolicy(request, class, response)` sets `Cache-Control` on the web
app's responses. Only an anonymous (no cookie, no `Authorization`) GET or
HEAD of `chain-derived` data answered 200 without `Set-Cookie` gets `public,
max-age=0, s-maxage=10, stale-while-revalidate=30`. Social, authenticated,
moderation, mutation, watcher and preflight responses, errors and outages get
`private, no-store`. blast-infra's `/v1` keeps its own headers (`no-store`,
or `public, s-maxage=3600` for settled candles); the web app does not proxy
or rewrite it.

The CDN keys a cacheable response by deployment and URL. A route that returns
public chain-derived data therefore puts in its path or query everything its
body depends on: a representation version (for example `/api/launchpad/v1/...`)
so a changed body shape never serves an old one, and no per-viewer input. The
body carries its provenance (checkpoint, age, status), so a Stale answer is
marked as such for as long as the CDN keeps it (10 s plus 30 s of
revalidation). Nothing cached can authorize a transaction: mutations, their
preflights and anything carrying identity are `private, no-store`.

### Initial replay and backfill

- blast-infra's initial replay from the launch checkpoint runs, and
  `/v1/health` answers `ok`, **before** the web app admits users to the
  launchpad. Until then market reads are Unavailable (`not_ready`).
- A later catch-up or backfill runs through the same engine into the same
  database, on the primary's direct endpoint: set blast-infra's
  `INGEST_CONCURRENCY` (for example 4) for its duration, start it outside
  launch windows, and unset it afterwards. blast-infra refuses a migration
  URL on another server or database. Never point a second engine or a
  scratch copy at the web app's readers: there is one canonical store.

### When to split the database

One Neon project stays. A split into separate projects (for example chain
data apart from social data) is considered only when all of these hold:

1. **Preconditions are in place.** Chain joins already run on the replica
   (and more replicas were tried), and the slow queries behind the signal
   were tuned (plans, indexes, round trips) and measured again.
2. **A measured signal persists** on production-shaped load (T-034's capacity
   runs, or production metrics over a launch window) against the approved
   social and indexer SLOs, with the evidence recorded beside the decision:
   - primary saturation: CPU or memory at the 4 CU maximum while social
     write latency (`db.transaction` p95) misses its SLO;
   - WAL volume: blast-infra's commit rate drives replica lag past the
     search and thesis policies at the replica's maximum, where replica lag is
     the real replication delay: Neon's replica lag metric for the read
     replica. Not the `chain_read_v1.watermark` age, which also counts indexer
     delay, and not a chain-time gap between the two checkpoints, which
     grows with blast-infra's catch-up speed;
   - backfill: a throttled blast-infra catch-up (`INGEST_CONCURRENCY`) still
     pushes social writes past their SLO, or cannot finish in its off-peak
     window;
   - vacuum: autovacuum on the chain tables cannot keep up (dead tuples,
     wraparound margin) without hurting social writes;
   - write contention: social writes wait on locks, I/O or connections that
     indexer commits hold (`blast_commit_seconds` beside `db.transaction`).
3. **Or a policy requires it, independently of load:** chain and social data
   need different restore points or recovery objectives, different
   retention, or a security or compliance boundary that one database with
   role grants cannot meet.

Numbers such as "70% CPU for 15 minutes" or "p95 doubling during ingestion"
are examples of how to state a signal, not the thresholds; the SLOs decide.
A split would also split the roles, grants and `chain_read_v1` contract above.

## Campaign claims (historical)

`POST /api/mission-control/completion` runs one READ COMMITTED transaction.
Its guarantees rest on explicit locks and constraints, not on SERIALIZABLE:

| Guarantee | Mechanism |
| --- | --- |
| Idempotency | Advisory lock on the idempotency key hash, then a check of `mission_control_completion_idempotency` (primary key) |
| Single-use code | `FOR UPDATE` on the admission attempt and the code (a racing claim waits, then sees `consumed_at`); final `UPDATE … WHERE consumed_at IS NULL` must affect one row |
| One membership per identity, wallet or callsign | Sorted advisory locks on the callsign, Privy, Sui and X claim keys (one statement), then the conflict check; unique constraints behind them |
| Season cutoff | Shared advisory lock `season-schedule:<season>` in the claim, exclusive in `announceCutoff` |
| Unique crew number | `nextval` on the season's sequence (migration 0022) plus the `(season_id, crew_number)` unique constraint |

Deadlocks and serialization failures re-run the whole transaction with
full-jitter backoff (up to 4 attempts); a lock timeout gets one retry.
`claim` and `db.transaction label=completion` metrics record duration,
attempts and error codes.

**Crew-number gaps.** `nextval` is never rolled back, so a claim that aborts
after drawing leaves a gap. The draw happens after every check that can reject
a claim, so gaps come from infrastructure faults and from one lock wait after
the draw: `claimSeedCreator` locks the seed-creator row for the member's X
handle (`FOR UPDATE`). If that waits past `lock_timeout` (another claim for
the same handle at the same moment, or an operator transaction on that row),
the whole claim is retried and draws a new number. It cannot move before the
draw without splitting `createImmutableMembership`: it records `profile_id`,
a foreign key to the profile row that is inserted just before the draw.
Crews #69 (Manifest), #123
(Countdown), #256 (8-Bit), #503 (Sui) and #727 (Blast Launch Day) are one-of-one
editions (`cardEditionForCrew` in `card-renderer/editions.ts`; keep this list in
step with it). After launch, check that none was skipped:

```sql
SELECT n AS skipped_edition
FROM (VALUES (69), (123), (256), (503), (727)) AS editions(n)
WHERE n < (SELECT last_value FROM pg_sequences
           WHERE sequencename = mission_control_crew_sequence_name('season-zero'))
  AND NOT EXISTS (
    SELECT 1 FROM mission_control_season_memberships
    WHERE season_id = 'season-zero' AND crew_number = n);
```

Card records are immutable (enforced by a trigger), so a skipped edition can
only be reassigned by a reviewed one-off migration.

### Season member cap

Season Zero accepts at most 9,999 successful memberships. Migration 0029
backfills the season's committed member count and installs a deferred database
trigger that claims the final seat at commit. Concurrent requests can do their
normal work in parallel, but only one can commit seat 9,999; every overflow
transaction rolls back in full. Once the counter reaches the cap, admission
GET reports the full state and admission POST refuses every launch code before
lookup or rate limiting. Existing members can still restore access.

### Rolling out migration 0022

1. Apply migrations first (`npm run db:migrate` against the direct endpoint).
   The migration takes a brief `SHARE ROW EXCLUSIVE` lock on
   `mission_control_seasons` and waits for in-flight claims. A trigger makes
   the old code's `next_crew_number + 1` update draw from the same sequence, so
   old and new deployments can overlap.
2. Deploy the new code.
3. Rollback: redeploying the old code alone is safe while 0022 is applied (the
   legacy trigger keeps numbers unique). To remove 0022, apply
   `0022_crew_number_sequence.down.sql` manually against the direct endpoint
   (`psql -X -v ON_ERROR_STOP=1 -f …`). It moves `next_crew_number` past the
   highest number the sequence issued and drops the sequences, functions and
   triggers. It runs as one transaction (its own BEGIN and COMMIT) and holds
   `ACCESS EXCLUSIVE` on `mission_control_seasons` from its first statement:
   every claim reads its season before it draws, so the script waits for
   claims in flight and holds new ones until it commits. Do not run its
   statements one at a time: between them a claim could take a number the
   restored counter hands out again. Do this only after the old code is
   deployed.

## Projections

This section records the retired campaign projection job.

The public crew counter reads the truthful telemetry projection
(`telemetry/projection.ts`), which is built from campaign events. Claims and
shares append the events and schedule a catch-up from `after()`; the cron
`/api/mission-control/maintenance/projection` runs one every minute with a
25 s budget. A catch-up applies batches, one transaction each, under the
projection's advisory lock. An instance that finds the lock held skips at once
and retries twice, 1 s apart; the holder keeps going until it is caught up.

### Cost of a batch

A batch is nine statements whatever its size (default 500 events, 10 s budget
per scheduled catch-up): BEGIN, the lock, the checkpoint, the pending list, one
`INSERT … SELECT FROM unnest(…) ON CONFLICT DO NOTHING RETURNING` that claims
every event's delivery, one insert of all blastoff facts, one upsert of each
season's summed counters, the checkpoint, COMMIT. Only claimed events are
applied, so a replay or a racing instance never counts an event twice.
Corrections (`telemetry.corrected.v1`) can subtract, so each one is applied on
its own between the batched runs of the other events.

Before, each event had its own claim and up to two telemetry writes: a 50-event
batch took about 80 sequential round trips while it held the lock and a pooled
connection, and the pending list anti-joined every event ever appended.

Measured on local PostgreSQL behind `apps/web/loadtest/lib/latency-proxy.mjs` at 75 ms
per round trip (iad1 to eu-west-2), 12,000 synthetic members, 64,000 events:

| | Before | After |
| --- | --- | --- |
| Round trips per batch | about 80 for 50 events | 9 for up to 500 |
| Catch-up throughput | 6.9 events/s (1.3 claims/s) | 603 events/s (113 claims/s) |
| Pending list at 65,000 events | 345 ms, growing with the history | 18–33 ms, growing with the watermark window |

At 1.3 claims/s a 5,000-member rush left the counter about an hour behind. A
batch now takes about 0.8 s at that distance, so the counter stays within a
batch or two of the claims.

### Pending scan and the low watermark

Sequences can commit out of order: a claim draws its event sequences, then
commits later, so a lower sequence can become visible after a higher one was
projected. The checkpoint (highest sequence applied) is therefore never a
cursor. The pending list reads undelivered events above a **low watermark**
that trails it:

- A batch that listed fewer events than its limit saw every pending event
  visible to it. After such a batch, if the recorded candidate checkpoint is at
  least one **watermark window** old, the candidate becomes the low watermark
  and the current checkpoint the next candidate. The watermark trails the
  checkpoint by one to two windows of events. The window is 5 minutes
  (`PROJECTION_WATERMARK_WINDOW_MS`) unless the timeouts below call for more.
- **Why it is safe.** An event at or below the new watermark has a lower
  sequence than the candidate, so it was drawn before the candidate's event
  committed, which was at least one window before this batch listed. If it was
  not visible to the listing, its transaction had stayed open more than a
  window after drawing the sequence. Everything visible below the watermark
  is already delivered.
- **The window against the timeouts.** Every runtime transaction sets
  `statement_timeout` (8 s by default) and
  `idle_in_transaction_session_timeout` (15 s), so a transaction whose client
  stalls or dies rolls back within one idle limit, and one still working
  finishes each statement within the statement limit. A claim, the longest of
  the writers, appends all its events in one statement and then sends four
  more: the member session, the code consumption, the idempotency record and
  COMMIT (shares, X rewards, Telegram and the cutoff append theirs last).
  Counting the insert, it commits within 5 × (statement + idle) of drawing its
  sequences, even if every statement nearly times out and every gap nearly
  hits the idle limit: 5 × 23 s ≈ 1.9 minutes at the defaults. In practice it
  takes well under a second. A transaction that rolls back never shows its
  events.
- **The window is derived from the pool.** `projectionWatermarkWindowMs`
  (`read-model/runner.ts`) takes the larger of 5 minutes and that bound plus
  1 minute, from the timeouts of the pool the projection runs on; a
  deployment's runtime pools share one environment, so they are the writers'
  timeouts. At the defaults the window stays 5 minutes. Raising
  `DATABASE_STATEMENT_TIMEOUT_MS` and `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS`
  widens it: 30 s each gives 6 minutes, and both at their 120 s maximum give
  21 minutes. A wider window keeps more events in the pending scan.
- Transactions without those limits (the operator CLI's pool) can outlast the
  window, and `projection:run`, whose pool has no runtime timeouts, keeps the
  5-minute floor. Their events are still applied, by the sweep below.
- The list matches deliveries to events by sequence and reads both in order
  from their indexes (the deliveries index is migration 0027), so its cost
  follows the window, not the history: 6 ms for the last 1,000 events, 30 ms
  for the last 20,000 (EXPLAIN, local).

### Backstop sweep

When the projection cron has caught up and the last complete sweep is at least
15 minutes old (`PROJECTION_SWEEP_INTERVAL_MS`), it anti-joins every event at
or below the watermark and applies any that are undelivered: about 50 ms at
65,000 events. `swept_at` in `mission_control_projection_checkpoints` records
the last complete sweep, so a skipped cron run delays it by at most a minute.
Only the cron sweeps; scheduled catch-ups never do.

### Metrics to watch

- `projection.catch_up`: one line per projection per catch-up, with
  `applied`, `batches`, `delivered`, `durationMs` and `outcome` (`caught-up`,
  `contended`, `budget`, `failed`). Cron runs add `swept` when a sweep ran.
  `budget` on consecutive cron runs means the projection is falling behind.
- `projection.sweep`: one line per sweep batch, with `applied`, `delivered`
  and `outcome` (`swept`, `partial`). Any `applied` above zero means a
  transaction committed more than a watermark window after drawing its
  sequence: look for a long operator session, or a `projection:run` next to
  raised runtime timeouts.

Current backlog:

```sql
SELECT (SELECT MAX(sequence) FROM mission_control_campaign_events)
         - last_sequence AS behind_head,
       last_sequence, low_watermark, updated_at, swept_at
FROM mission_control_projection_checkpoints
WHERE projection_name = 'campaign-truthful-telemetry-v1';
```

### Rolling out migration 0027

1. Apply migrations first: the new code reads the new checkpoint columns.
   0027 adds them without a table rewrite and builds the deliveries index,
   which holds projection batches for about 0.1 s per 60,000 deliveries.
   Claims and telemetry reads never wait for it.
2. Deploy the new code. Existing checkpoints start with the watermark at 0, so
   for about 10 minutes the pending list still scans the whole history (60 ms
   at 65,000 events with the new index), then the watermark moves up.
3. Rollback: the old code ignores the columns and the index, so redeploying it
   alone is safe. `0027_projection_watermark.down.sql` drops them.

### Removing migrations by hand

The down scripts (0022–0027) run by hand, newest first, against the direct
endpoint with `psql -X -v ON_ERROR_STOP=1 -f …`. A down script does not touch
`mission_control_schema_migrations`, so after each one delete its row, or
`db:migrate` treats it as applied and never runs it again:

```sql
DELETE FROM mission_control_schema_migrations WHERE name = '0027_projection_watermark';
```

Checked on Postgres 18 (2026-09-25): migrate to 0027, down 0027 through 0022
with their rows deleted, migrate again; the schema dump matched the first one
exactly and nothing from 0022–0027 was left in between.

## Card images

Two routes serve card PNGs through one `CardImageService` per function instance
(`card-images/service.ts`):

- `GET /card/<id>/image`: the share image of a published card, public, for link
  previews.
- `GET /api/mission-control/owner/card`: the owner's own card in either format,
  including before it is published. `Cache-Control: private, no-store`.

Each render is keyed by card, format and a digest of the canonical record plus
`CARD_RENDERER_VERSION`. A request is served from this instance's memory, then
from the object store (found through the `mission_control_card_images`
catalog), and only then rendered, written to the store and catalogued.
Concurrent requests for one key on an instance share one load. Store and
catalog failures are logged as `card.image.store_error` and degrade to serving
the fresh render without persisting it.

### Store selection

| Variable | Default | Meaning |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | unset | Use Vercel Blob. Wins over `CARD_IMAGE_DIRECTORY` |
| `CARD_IMAGE_BLOB_ACCESS` | `private` | Access for written blobs: `private` or `public` |
| `CARD_IMAGE_DIRECTORY` | unset | Use a local directory (development and load tests) |

With neither store set, renders live only in each instance's memory and every
new instance renders again.

Keep `CARD_IMAGE_BLOB_ACCESS=private` in production. Each blob's URL is stored
in `mission_control_card_images.url`, and the owner route persists previews of
cards that are not published yet. With `public`, anyone who learns a blob URL
can fetch that image without a session. Private blobs are read server-side with
the token and their URLs never reach clients. Blob reads time out after 5 s,
writes after 10 s.

### Per-instance limits

| Variable | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `CARD_IMAGE_MEMORY_CACHE_BYTES` | 67108864 (64 MiB) | 0–1073741824 | PNG bytes kept in memory, least recently used out first; 0 disables |
| `CARD_RENDER_CONCURRENCY` | 2 | 1–8 | Renders running at once |
| `CARD_RENDER_QUEUE` | 16 | 0–64 | Renders allowed to wait for a slot |

A render costs about 2 s of CPU on one vCPU and produces 0.6–2.4 MB of PNG from
an SVG that can embed an avatar of up to 5 MB. Only renders take a slot; memory
and store hits never wait for one. A render is shed when every slot is busy and
the queue is full, or when it has waited 10 s without starting. Both routes then
answer `503` with `Retry-After: 5` and `Cache-Control: no-store`, and
`card.render.shed` logs `reason` (`queue_full` or `wait_timeout`), `active` and
`waiting`. `card.render` logs `waitMs` next to the render's `durationMs`.

Raise `CARD_RENDER_CONCURRENCY` only with the function's vCPU count: more
renders than cores share the CPU and each one takes longer. Raise
`CARD_RENDER_QUEUE` when sheds come in short bursts that the instance would
clear within a few seconds.

The public route also remembers, per instance, the record digest of each card
it has served as published (up to 20,000 ids, least recently used out first,
about 5 MB). Publication is never undone and card records are immutable, so a
remembered card whose image is still in memory is served without a database
query. Unknown and unpublished ids are never remembered: they are looked up on
every request.

### CDN headers

- A published card's image: `Cache-Control: public, max-age=86400,
  s-maxage=31536000, immutable`. The CDN keeps it a year, browsers a day.
- Not found (unknown or unpublished) and 503: `no-store`, so publishing a card
  or recovering from a shed takes effect on the next request. Every 503, shed
  or not, also sends `Retry-After: 5`.

The app emits the public URL as `/card/<id>/image?v=<CARD_RENDERER_VERSION>`
(`publicCardImagePath`) in the card page's Open Graph and Twitter metadata and
its `<Image>`. The route ignores the query, and the proxy and route policy match
on the pathname only. The CDN caches by the full URL, so a new renderer version
is a new cache entry.

### Taking down a published card image

The public image is cached hard: the CDN keeps
`/card/<id>/image?v=<version>` for a year (`immutable`), browsers for a day,
and each instance serves a card it remembers as published from memory. To
take one down:

1. Unpublish the card: `UPDATE mission_control_cards SET published_at = NULL
   WHERE card_id = '<id>';` (the card record is immutable; `published_at` is
   not). The card page then answers 404 and stops linking the image, and the
   image route answers 404 on every instance that does not remember the card.
   The member's next Share on X publishes it again.
2. Redeploy, so no instance still serves it from memory.
3. Purge the image path, `/card/<id>/image` with each `?v=` it was served
   under, in the Vercel dashboard (Caching). Until then the CDN keeps serving
   it without reaching the app. Bumping `CARD_RENDERER_VERSION` is no
   substitute: it changes the URL the app links for every card, but the CDN
   still answers the old URL.

Copies X and other sites fetched for link previews, and browsers' day-long
copies, are outside Blast's control.

### Changing the card artwork

1. Change the artwork, edition backgrounds, SVG layout, fonts or rasterizer
   settings.
2. Bump `CARD_RENDERER_VERSION` in `card-renderer/version.ts`, for example to
   `season-zero-card-renderer/3`. `npm test` fails until you do: the "renderer
   inputs are pinned to the renderer version" test fingerprints those inputs.
   Record the new fingerprint and version in that test.
3. Deploy. Every digest changes, so each card renders again on its first
   request, within the render slots. Expect `card.render` and some
   `card.render.shed` for a while after the deploy. Old store objects and
   catalog rows stay behind and are no longer served.
4. Card pages served after the deploy point at `?v=<new version>`, so the CDN
   and crawlers fetch the new image. Posts already on X link to the card page;
   X picks up the new image when it next reads that page's metadata.

## Campaign X verification (historical)

Follow checks are queued jobs (`mission_control_x_verification_jobs`).
A request records the job and returns 202. A worker then asks the relevant
provider: right after the response (the "kick"), and in the per-minute cron
drain. Follow checks use `SOCIAL_DATA_API_KEY` first and fall back to the
official X API with Blast's OAuth 1.0a user-context credentials when SocialData cannot answer. No
member tokens are stored, and sharing a card is not verified.

### Provider budgets are shared by every member

Confirm the request budgets in the SocialData and X developer plans before
launch.

| Check | Endpoint | Limit per app | Sustained rate |
| --- | --- | --- | --- |
| Follow primary | SocialData exact ID-to-ID relationship | Confirm with the SocialData plan | One request per healthy check |
| Follow fallback | `GET /2/users/:id?user.fields=connection_status` | Confirm with the X developer plan | One request only when SocialData cannot answer |

The server credentials mean these are budgets for all members together, not
per member. Anything else that uses the same credentials spends the same
budget. A healthy follow check is one SocialData request and a fallback is one
official user lookup, so size launch capacity against the lower provider
quota. Members see "X is busy" copy while the queue waits, and their checks
finish on their own.

### Queue behaviour

- **Oldest first.** Jobs are claimed by due time, then creation time. A kick
  from a member's request or status poll runs the oldest due job, not
  necessarily that member's, and pressing verify again returns the same job,
  so nobody moves ahead by polling or resubmitting. The claim reads the
  claim-order index from migration 0026, so it stops at the first job it can
  take instead of sorting the whole backlog.
- **Kicks never wait or pile up.** A kick runs only if its instance has a free
  slot at that moment (4 per instance, shared with the drain). Otherwise it
  returns at once without touching the database, and the next poll or the cron
  drain carries on. A burst of polls therefore starts at most as many checks
  as the instance has free slots. With no backlog, the member's own check
  still runs straight after their request. A kick's check stops after 30 s, so
  it finishes well inside the route's 60 s limit.
- **Pacing.** When an X response reports `x-rate-limit-remaining` of 1 or less,
  the worker pauses that kind of check for every instance until
  `x-rate-limit-reset`, plus up to 2 s of jitter, so instances stop before X
  answers 429. A 429 pauses it the same way, using `Retry-After` or
  `x-rate-limit-reset` (60 s when neither is sent). Every pause lasts at least
  1 s, even when X's hint is zero or already past, and none lasts longer
  than 15 minutes. Pauses live in `mission_control_provider_backoff`
  (`x-follow`, `x-post`).
- **Paused jobs keep their place.** Queued jobs of a paused kind move to the
  pause end in their existing order, and new jobs queue behind them. The
  status API reports such a step as
  `{ "status": "pending", "queued": true, "retryAt": "<pause end>" }`; the
  owner card still stops polling after about two minutes and says the check is
  queued.
- **Rate limits never use attempts.** A job that hit a pause or a 429 goes back
  to the queue with its attempt count unchanged. Only genuine failures count
  (5xx, timeouts, network errors, unreadable responses): after 6 of them the
  job fails with `X_UNAVAILABLE`.
- **An outage pauses the queue briefly.** A 5xx or a failed connection still
  uses the job's attempt, and also pauses that kind for every instance for
  15 s (`X_OUTAGE_PAUSE_MS`, reason `server_error` or `network`). Without it,
  every instance worked through the whole due backlog during an outage, one X
  call and one database write per job: in the x-faults run, 2,579 failing
  calls in a minute, and pooled connections held long enough to push the
  verify acknowledgement's p95 past 500 ms. With it, each kind probes X about
  once per 15 s until X answers. Timeouts are left alone: each already holds a
  lane for the 8 s request timeout.
- **A refused provider credential pauses the queue; it never fails a member.**
  Every call carries a Blast-owned server credential, so a 401 or 403 is
  Blast's problem, not the member's. The worker pauses that kind
  for every instance for 5 minutes (`X_CREDENTIAL_PAUSE_MS`, reason
  `unauthorized` or `forbidden`) and requeues the job with its attempt given
  back, as for a 429. The queue waits until the token or the app's access is
  fixed; jobs keep their 6-hour deadline. SocialData failures first try the
  official fallback. A valid negative SocialData answer, or an official user
  lookup without `followed_by`, fails the follow check with
  `X_NOT_FOLLOWING`.
- **The drain's own budget never uses attempts either.** A drain lane claims a
  job only while at least 15 s of its budget remain, one X request (8 s) plus
  room to record the result, and checks again once it holds a slot. If the
  budget still runs out mid-check, the
  job goes back to its place in the queue with its attempt given back
  (`last_error = drain_deadline`).
- **Neither does a database that cannot record X's answer.** When X confirmed
  a step but recording it fails because the database is unavailable (no free
  connection, a lost connection, a timeout), the job goes back to its place
  with its attempt given back (`last_error = record_failed`), and a drain lane
  that meets this stops rather than ask X again at once. The next run asks X
  again. Any other failure to record (a bug) still uses an attempt.
- **Deadline.** A job still queued 6 hours after it was created
  (`X_VERIFICATION_DEADLINE_MS`) fails with `X_UNAVAILABLE`, and the member
  sees "X is busy right now. Try verifying again in a few minutes." At the
  rates above, 6 hours covers about 7,200 follow checks and 10,800 post checks
  queued at once. No job runs after its deadline, but only the cron drain
  writes the failure (kicks never do, so polling costs no writes). Until the
  next drain, up to a minute later, the status API still reports such a job as
  `pending`, and pressing verify returns that same job. Each drain fails up to
  500, so if thousands expire together this can take a few minutes.
- **A running job is failed only once its worker is surely gone.** Past the
  deadline, a running job is failed only after its lease has been expired for
  another full lease (90 s). A worker that overran its lease can still record
  X's answer, and the answer counts once.

### Cron

`/api/mission-control/maintenance/x-verifications` runs every minute
(`apps/web/vercel.json`) and drains due jobs for up to 45 s, claiming new ones during
the first 30 s. Set `CRON_SECRET` (at
least 16 characters) in the environment: Vercel sends it as a bearer token, and
without it every cron request is refused. Without the cron, queued checks move
only when some member submits or polls, so a backlog stalls once members stop
watching. A per-minute schedule needs the Vercel Pro plan.

### Metrics to watch

- `x.request`: one line per provider call, with `provider` (`socialdata` or
  `x`), `endpoint` (`following` or `tweet`), `status` (HTTP status, `timeout`
  or `network`), `durationMs` and `remaining`. A steady run of official-X
  `status=429` means pacing is not holding, for example because another
  system uses the same token.
- `x.verification`: one line per job run, with `kind`, `outcome` (`succeeded`,
  `failed`, `retried`, `rate_limited`, `interrupted`, `stale`), `attempts` and
  `failureCode`. `rate_limited` covers every refused call that paused the
  kind, credential refusals included (the job's `last_error` says which).
  `interrupted` means the drain's budget ended mid-check, or the database
  could not record X's answer.
  A rise in `failureCode=X_UNAVAILABLE` means X is failing or jobs are reaching
  the deadline.
- `x.backoff`: one line per pause, with `kind`, `reason` (`window_spent`,
  `rate_limited`, `unauthorized`, `forbidden`, `server_error` or `network`),
  `delayMs`, and `deferred` (jobs moved to the pause end). A steady stream of
  `server_error` or `network` pauses means X is down for Blast.
- **Alert** on any `x.backoff` with `reason=unauthorized` or
  `reason=forbidden`: a provider refused Blast's server credential, and that
  `kind` of check is paused for every member until it is fixed. `x.request`
  shows the refused `status` (401 or 403) and `provider`. Check
  `SOCIAL_DATA_API_KEY` or the four X OAuth 1.0a variables accordingly.
  The pause renews every 5 minutes while X keeps refusing, at one X call per
  kind; queued jobs still fail at their 6-hour deadline.
- `x.verification.drain`: one line per cron run, with counts of `claimed`,
  `succeeded`, `failed`, `retried`, `rateLimited`, `interrupted`, `deferred`
  and `expired`.
- `x.verification.kick`: `outcome=skipped` with `skipped`, the number of kicks
  this instance skipped because every slot was busy. It is logged by the next
  kick on that instance that finds a free slot, so skipped kicks never add a
  log line each. A steady high count means polls far outpace the slots, which
  is expected while X is the bottleneck.

Current backlog:

```sql
SELECT kind, COUNT(*) AS queued, MIN(created_at) AS oldest
FROM mission_control_x_verification_jobs
WHERE status IN ('pending', 'running')
GROUP BY kind;
```
