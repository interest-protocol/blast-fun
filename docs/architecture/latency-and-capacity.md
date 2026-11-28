# Latency and capacity for 10,000 simultaneous users

This is the workload and delivery policy for the next architecture checkpoint.
It does not establish hosted capacity or authorize deployment. Ingestion and
combined ingestion/read acceptance remain blocked pending coordinator decision.

## Deliver changes according to the data

| Data | Delivery | Authoritative answer |
| --- | --- | --- |
| New activity and presale lifecycle changes | Hints on the shared market socket while a tab has visible subscribers | Existing bounded feed, Happening and lifecycle reads |
| Feed pages, discovery rankings and public market summaries | Cacheable reads; hints trigger coalesced refreshes | Original producer checkpoint and clock |
| Wallet, portfolio and viewer state | Private reads on relevant lifecycle/catch-up signals and user actions | Existing authenticated, no-store reads |
| Trade quotes | Request/response while the trade view needs them; bounded busy recovery | Validated route and fullnode results |
| Financial actions and balances used for a transaction | Explicit authenticated operation and subsequent authoritative read | Existing financial rules and chain state |

Hints never supply balances, quote prices or financial state. One exception,
cue only, never data: a priced buy or sell hint's quote amount and dollar value
draw Home's passing trade pop on the coin's row without a Home list read. The pop
is never a balance, a price or an input to a trade; a priced trade's rank, volume
and counts wait for the thirty-second poll, and prices keep moving rows through
the price stream. Every other hint still triggers a read. Hidden tabs own
no hint connection or retry timer. A hidden tab keeps a socket that watches
pools or prices (a coin chart, Home) for fifteen seconds, so a quick return
costs no ticket or reconnect; screens still run their catch-up read, since
hints are not delivered while hidden. A hints-only socket closes at once. A process fans out one upstream subscription;
its clients share one heartbeat timer. Each client retains its own deadline,
backpressure limit and cancellation ownership.

Keep the five-second minimum between freshness reads and the thirty-second
visible polling fallback. Public discovery permits ten seconds of edge freshness
and twenty seconds of stale revalidation; private answers retain no-store.
The service health answer is shared for at most five seconds since it was
checked: by the process, then by the edge for what is left less one second for
the trip (no stale revalidation, nothing kept in the browser). Its
fifteen-second visible poll from 10,000 tabs is about 667 browser requests/s.
Function and backend requests fall from the same 667/s to short bursts per edge
region every few seconds (unmeasured; an answer more than three seconds old is
not shared); the infra probe stays at one per process every five seconds at most.
This policy deliberately does **not** promise three-second fresh discovery.
Lifecycle query invalidation already spreads requests over up to one second.
Changing these limits needs an explicit freshness/cost decision and matching
assertions; a source optimization must not silently change them.

`refresh_completed` measures refresh completion with freshness unverified.
Neither a successful HTTP answer nor the next animation frame proves that a
particular hinted update reached the screen. Verify that separately with a known
committed activity/lifecycle update, its returned data and a browser observation.
The sampled, capped analytics stream cannot supply exhaustive counts or unbiased
population percentiles.

## Size the whole topology

Use connected **visible subscribed tabs**, including multiple tabs per person,
for stream demand. Use route frequency for request demand. For example, two
thirty-second polls from 10,000 visible tabs produce about 667 browser requests/s
before hints, navigation and quotes; edge hits determine origin demand.

The backend defaults to 200 connected hint streams per process and permits at
most 1,024. The existing partner-capacity contract permits at most 32 **API**
replicas. A separate hints role has its own maximum of 32 replicas and never
participates in partner reservations. The 200-stream default cannot cover
10,000 simultaneously subscribed visible tabs within either 32-process role:
32 × 200 = 6,400. No default or admission cap is changed by this checkpoint.

For a selected process stream limit `C`, replica count `R`, and planned maximum
utilization `U`, require `(R - 1) × C × U >= visibleSubscribedTabs` to reserve one
process failure, then verify actual routing skew. For illustration, 26 processes
at 512 and 80% planned utilization cover 10,240 streams after losing one process;
14 processes at the maximum 1,024 cover 10,649. This is arithmetic, **not** a
deployment recommendation or proof of memory, CPU, proxy, upstream or database
capacity.

API processes own database/Redis clients, partner reservations, ordinary work
and quote workers. A hints-only process owns quota/replay Redis clients and at
most one infra subscription, with no database pool or quote worker. Budget both
roles alongside writers, admin and recovery work. Do not multiply API processes
or raise limits merely to make stream-count arithmetic pass.

## Run hints independently

The existing API command remains `bun run src/main.ts`. The separate command
`bun run src/hints-main.ts` (package script `start:hints`) reuses the existing
transport, signed proof, replay burn, quota identity, stream permits, backpressure
and drain. Only the exact GET/HEAD `social.activity.hints` contract is allowed;
other private contracts are refused before body work, replay or business dispatch.
There is no partner recognition/recovery, general private owner, quote handler,
cron or operator handler in this role. Shared inert SQL helper definitions may
be imported through existing rate-limit helpers; no pool is constructed.

Use `apps/backend-api/hints.env.example` as the clean process environment.
Keep its dedicated `BLAST_BACKEND_HINTS_GATEWAY_SECRET` out of the main API
process, and omit main API, SQL, partner and operator credentials from hints.
The frontend holds the separate hints secret and `BLAST_BACKEND_HINTS_ORIGIN`.
Only the exact hints contract selects that pair. An incomplete/invalid pair
fails closed; it never falls back to the API host or API secret. With neither
new variable set, the existing routing remains compatible. Redirects remain
manual and the existing signed origin/IP/namespace and nonce rules apply.

Startup checks infra URL/key configuration without opening an upstream socket.
Readiness probes only quota and replay Redis; it does not certify a live infra
handshake or SQL health. Streams still validate the existing infra handshake.
Process drain cancels owned streams and closes its Redis clients within the
existing finite deadline. No new cache exists. A quote asks the Cetus
aggregator with a plain `fetch` on the main thread (`cetus-route.ts`); the
private quote lane bounds how many run at once.

## Validate a declared fleet envelope

Set the same `BLAST_BACKEND_FLEET_CONFIG` JSON in both roles. It is required
by hints startup; legacy API startup without it remains compatible and makes
no claim about a checked two-role fleet. API startup with an envelope checks
its actual pool sizes, ordinary in-flight setting, cache/reporting configuration
and existing partner replica allowance. Hints startup checks its actual stream
cap. Each returns a stable envelope fingerprint for configuration comparison.

The envelope has `evidence` (a reference, not an assertion of measured capacity),
`visibleSubscribedTabs`, `utilizationPercent`, `api`, `hints`, `reserved` and
`ceilings`. `api` contains `replicas`, `primaryPoolMax`, `replicaPoolMax`,
`maxInflight`, `cacheRedis` and `defillama`; `hints` contains `replicas` and
`maxHintStreams`. Both resource objects use these exact keys:

| Resource key | Demand derived from role settings |
| --- | --- |
| `primaryClients` | API replicas × (primary max + auth 2 + verifier 2 + reporting allowance) |
| `replicaClients` | API replicas × (replica max + reporting allowance) |
| `reportingClients` | API replicas × reporting allowance (2 when configured, otherwise 0) |
| `quotaRedisClients` | 2 × (API replicas + hints replicas), for quota and replay |
| `cacheRedisClients` | API replicas when cache Redis is configured, otherwise 0 |
| `infraHintSockets` | Hints replicas × (1 + market stream enabled): only hints processes hold engine sockets |
| `quoteWorkers` | API replicas × the existing two-worker executor limit |

Reporting may alias the primary, replica or another database, so its two
connections are conservatively charged to all three database ceilings. These
are client ceilings, not a claim about PgBouncer backend concurrency or database
CPU. The `reserved` counts cover external processes, deployment overlap,
recovery and other consumers; each derived demand plus reserve must fit its
explicit `ceilings` value. The caller supplies reviewed ceilings; no provider
limit is discovered or invented. Stream arithmetic must also cover the declared
visible tabs after losing one hints process at the chosen utilization.

The synthetic test fixture demonstrates 4 API + 26 hints processes at the
512-stream setting and 80% utilization: 10,240 streams after one hints
process fails, 56 primary/40 replica clients, 60 quota/replay clients, 30 possible
infra hint sockets and 8 quote workers before external reserves. This is a
test of arithmetic, **not a deployment recommendation or measured envelope**.
Hints replicas never multiply SQL pools, quote workers or partner reservations.

This validation cannot discover the actual number of running processes, enforce
an orchestrator's replica maximum, verify declared provider ceilings, detect
different JSON deployed to another process, or prove CPU/RSS/transaction/RPS
capacity. Operators must check the deployed counts, configuration fingerprints,
external reserves and provider limits. Hosted measurements remain required.

## Keep exact SQL while reducing sort width

Top-coins uses one materialized, unique coin-to-bigint mapping internally.
Distinct account counts group by the smaller key, then map back to unchanged
coin identities, null/zero rules and ranking. On one local 64-coin fixture,
three alternating pairs reduced median execution from 360.571 to 156.490 ms
and temporary blocks from 837 read/839 written to zero, with unchanged
`work_mem`. Sort width fell from 95 to 24 bytes. The one-eligible-coin median
increased from 79.780 to 105.267 ms; this is a disclosed growth-workload tradeoff,
not a universal speedup. Exact aggregate cost and sparse feed scanning still
depend on source data size. No index, maintained projection or ingestion change
was introduced.

## Evidence required before a capacity claim

Record the exact activity mix, subscribed tabs, quote/exact-out frequency,
dataset size, launch flags, topology, effective limits and target percentiles.
Measure browser and origin demand separately, including cache hits/misses/age,
per-process streams and reconnects, actual database connections and pool waits.

On the intended hosted topology, run one agreed steady phase at 10,000 users,
one correlated hint/visibility-return burst, and bounded quote overload/recovery.
Include a process drain/failure and slow consumers. Capture route percentiles,
errors/refusals, verified update visibility, CPU/event-loop delay, RSS and
database/Redis work. Record load-generator limits and observation loss.

Use representative SQL plans and matched-RTT profiles to choose further query
or quote changes. Local fixtures can prove result equality and removed
work; they cannot establish hosted tail latency or capacity. Retain the existing
physical gate failure and outstanding release evidence independently of any
architecture score.
