# Authenticated portfolio soak

Run from a dedicated web worktree on a Linux host with PostgreSQL 16, PgBouncer
1.22+ and Node 24. The companion infra test runs the production wallet and
metadata workers against loopback provider simulators. No deployed service
receives load.

```sh
export WALLET_SCALE_HTTP_DIR=/absolute/path/to/isolated-run
node apps/web/loadtest/wallet-http-build.mjs > "$WALLET_SCALE_HTTP_DIR/build.log" 2>&1
```

Create the run directory before redirecting output. The build script requires a
separate `.next` directory and generates fresh P-256 credentials and secrets.
Only the build can reach Google Fonts; running apps allow loopback egress only.
Do not rebuild while a run is active. Install dependencies before building.

In the infra worktree, with a dedicated disposable PostgreSQL cluster:

```sh
DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres \
BLAST_SCALE_WEB=/absolute/path/to/web-worktree \
WALLET_SCALE_HTTP_DIR=/absolute/path/to/isolated-run \
WALLET_SCALE_HTTP_SECONDS=1800 \
WALLET_SCALE_REPORT=/absolute/path/to/isolated-run/results.json \
cargo test wallet_metadata_portfolio_scale -- --ignored --nocapture
```

The harness rejects non-loopback databases and requires the infra test's
`blast_test_*` database name. It grants login to the **isolated cluster's**
`blast_web` role. Reserve ports 39170–39177 and 55440–55441. PgBouncer runs in
transaction mode with 24 server connections and protocol prepared statements;
eight production Next.js instances each use `DATABASE_POOL_MAX=20`.
The existing TCP proxy adds 10 ms round-trip database delay. Worker/provider
concurrency stays at eight for each worker.

Each request traverses Next's proxy, API gate, JWT signature or persisted wallet
session validation, shared PostgreSQL rate limiter, account and linked-wallet
resolution, and the owner portfolio handler. Requests alternate JWT and wallet
sessions across all instances. Private test accounts have unique atomic
balances, checked on every response to detect cross-account data leaks. Test IPs
model distinct clients behind the trusted edge; a separate shared-IP preflight
verifies the real limit is enforced across instances. Missing/invalid/expired
auth, revoked sessions, missing gate and cross-origin requests must be refused.

The open-loop generator offers 500 requests/second for thirty one-minute
windows, counting scheduler delay in latency. It caps outstanding requests at
250 and reports every admission drop. Every window must complete all 30,000
requests with no errors or drops and p95 below 500 ms. The default run has
900,000 measured requests, in addition to preflight checks. Use a multiple of
60 seconds from 60 through 3600 for diagnostic runs; retain failed reports.

Fixture: 50,000 private accounts (20% Mission Control members), 100,000 linked wallets, 10,000 starting coin
types, 500,000 eventual balances, 2,000 presales, 200,000 positions/activity rows,
and seven daily snapshots per account. Initially 2,000 wallets and 1,000 coin
types need discovery. During HTTP load the generator introduces five fresh
metadata types and schedules up to fifty completed wallets for refresh every
five seconds. It does not reset failed workers' retry backoff. Checkpoint deltas
race snapshot installation; the final balance must include every delta exactly
once. Providers have 25 ms latency, 1% 1.5-second tails and an injected 15-second
outage; normal retries must recover.

Read `results.json`, the test stdout, app logs, PgBouncer statistics and
`runtime-egress.jsonl` together. Linux CPU/PSS sampling includes the generator,
app children, workers and dedicated PostgreSQL processes; PSS excludes database
files. Keep secrets (`app-env.json`, `signing.pem`, session tokens) out of evidence
and commits. Cleanup stops only child processes started by this run; the infra
fixture drops its disposable database.

Limits: self-hosted production Next.js over loopback HTTP does not measure TLS,
Vercel cold starts/edge overhead, browser rendering or provider login issuance.
Signed tokens and persisted sessions are test credentials validated by unchanged
production authorization code. Simulated network delay and local storage do not
certify remote database I/O or real provider quotas. Report hardware, storage,
contention and cardinalities with the measured capacity.

Use a dedicated machine for capacity acceptance: the shared development host
also runs unrelated builds. The isolated soak machine has 16 vCPUs and 24 GB
RAM, with PostgreSQL pinned to four CPUs, 128 MB shared buffers, and fsync and
synchronous commit enabled. Keep planning instrumentation off during load;
EXPLAIN and normal query timing still capture the query plans and costs.
The completion gate checks metadata values and confirmed absence, not merely
that a lookup created a row: transient failures must finish their retries.
