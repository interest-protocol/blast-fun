# 2,000 active logged-in users: isolated HTTP test

Run on a dedicated Linux host with Node 24, the repository's locked dependencies,
Docker and at least 6 GiB free disk for the build. The wrapper acquires one of the
shared heavy-job slots and checks expected memory plus a 4 GiB reserve and PSI.
Exit 75 means resources are insufficient; do not bypass it. Next builds use the
repository's one-worker configuration.

From the repository root:

```sh
bash apps/web/loadtest/active-users/run.sh smoke
bash apps/web/loadtest/active-users/run.sh build
bash apps/web/loadtest/active-users/run.sh run
```

Use a clean worktree and rebuild after source changes. The existing isolated build
helper refuses to replace another build directory. It generates disposable signing
keys and configuration; only the build's font downloads can leave loopback.
The production servers and generator use the newly created disposable database.
The runner refuses an existing application schema, remote databases and URL options.
The database container is removed on exit. Test-owned child servers are stopped.
No production environment file is read; there is no external target-URL option.

The default run starts four real production Next.js processes, with primary and
replica roles and pools of ten each. It seeds 10,000 accounts and wallets, indexed
holdings, six presales spanning their lifecycle, and 100 public trader candidates
with 1,000 activity rows each. Every test account has distinct cash atoms.
Prices and watermarks are refreshed locally during the run.

The generator ramps through 250, 500, 1,000 and **2,000 distinct authenticated
identities**, then holds 2,000 for an hour. Each identity keeps its own signed JWT
and stable IP. All perform the shell's account/presale/notification reads; equal
groups use Home/Traders, Portfolio/Coins, presale discovery and Feed.
Scheduled work is independent of response latency. There are no automatic client
retries. The 256-request in-flight ceiling records admission drops as failures;
latency includes scheduler delay. This is active read traffic, not idle sockets.

Checks include missing/invalid authentication, private/no-store responses,
request IDs, per-account cash isolation and a nonempty trader leaderboard.
Acceptance requires every active identity to complete work, zero dropped requests,
zero unexpected errors, and steady-state per-route p95 below 500 ms / p99 below
1.5 seconds. Results include each stage and route; failures retain reports.
The small smoke uses the real route modules over a lightweight HTTP adapter and
does not assert capacity latency thresholds. It explicitly excludes the Next proxy.

Outputs default to `apps/web/loadtest/.data/active-users/`: `results.json`,
application logs, an egress log, and an ownership record. Build keys in
`build/app-env.json` and `build/signing.pem` are test-only secrets; do not commit
them. Override `ACTIVE_LOAD_DIR` with an absolute path to keep artifacts elsewhere.

Useful overrides:

```sh
# Short production-Next diagnostic; not the hour-long acceptance run.
ACTIVE_LOAD_HOLD_SECONDS=120 bash apps/web/loadtest/active-users/run.sh run
# Headroom step after the target passes.
ACTIVE_LOAD_USERS=3000 bash apps/web/loadtest/active-users/run.sh run
```

This test is deliberately isolated: local PostgreSQL does not certify Neon compute
or replica lag; local Next has no CDN, TLS or Vercel cold starts. No SSE, wallet
signing, quote RPC, sponsored execution or worker ingestion throughput is modeled.
Those require separate provider-approved tests and the existing wallet/worker soak
in `../WALLET-HTTP.md`. No result here certifies whole-app production capacity.
Real browsers are still needed for rendering and polling behavior.

The default is public-launch mode with no CDN, so each request reaches origin.
Team-mode privacy/cache-control behavior is covered by route integration tests;
gated deployment capacity needs its own authorized staging run.
Redis is not used or required.
