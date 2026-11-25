# Live data delivery and serving topology

Decision record, 2026-10-27. Source: the 10,000-user backend review
(`audits/backend-capacity-2026-10-27/` in the workspace) and the owner's
requirements below. Nothing here is a capacity measurement; numbers marked
*proposed* are planning inputs, not evidence.

## Requirements

- Charts, prices and important information (new activity, presale lifecycle
  changes) update live in the browser.
- Everything else may refresh periodically.
- Partners read fast.
- The backend stays efficient: no work per viewer that can be shared.

## What is live and what polls

| Data | Delivery | Owner |
| --- | --- | --- |
| Coin chart candles and header price | Continuous market stream (`/api/launchpad/market/stream`), committed trades as they land | Bun hints role, `MarketStreamRelay` |
| Opening-round bidder count | The same market stream's `opening_round` frames (at most one per pool per checkpoint, never replayed); the page's `router.refresh()` (`refreshIntervalMs`: 30 s, 10 s while a section is stale, 5 s on a conflict) stays as the fallback | Bun hints role, `MarketStreamRelay` |
| New activity, presale lifecycle, coin identity changes | Hint frames on the same stream ("look now"), then the surface's own coalesced read | Bun hints role |
| Holders, coin activity tab, feeds, rankings | Visible-tab poll (15–30 s) plus hint-triggered reads; CDN keys shared per checkpoint | Existing routes |
| Wallet, portfolio, viewer state | Private no-store reads on lifecycle signals and user actions | Bun API |
| Quotes and trade submissions | Request/response, admission-reserved (below) | Bun API |
| Partner reads | `/v1` request/response through the partner boundary | Bun API, committed reader |

Hints never carry balances, prices or financial state. Hidden tabs hold no
stream and no retry timer.

## One browser stream role: the isolated Bun hints process

Every browser stream goes to the isolated hints process
(`apps/backend-api/src/hints-main.ts`) through the same-origin relay, which
signs it with `BLAST_BACKEND_HINTS_GATEWAY_SECRET` for
`BLAST_BACKEND_HINTS_ORIGIN`. Without that pair the relay answers 503 and tabs
stay on their polls; it never falls back to the API process.

Why this one:

- It is the only role that carries the continuous market stream, so a coin
  page needs one browser stream for candles, price and hints
  (`continuous-market-data.md`, `hints.sharedBrowserStream`).
- It reuses the private gateway's signed proof, replay burn, quota identity,
  stream permits, backpressure, drain and fleet arithmetic, and it never
  shares the API's connection ceiling, admission or database pools.
- The browser keeps one first-party origin: no CORS surface, and no ticket in
  a query string.

Accepted cost: each browser stream holds one web-function invocation for up to
its 270 s lifetime, so web-function concurrency equals visible subscribed tabs.
If that concurrency or its cost becomes the binding limit, the next step is an
authenticated direct connection from the browser to the hints process, after a
security review. That review is the next section; the connection is being built
behind a flag (2026-11-25).

Retired on 2026-10-27, after the hints process went live on develop: the
`live-hints` worker and its Render service, the ticket route
(`/api/social/activity/hints/token`) with its token signer and the browser's
ticket client, the coin-topic `coin_market` hints only that worker produced
(and the coin page's hint-driven reads of them), and the API process's own
activity stream. Coin pages keep their 15 s poll; a chart's trades and its
header price arrive on its market stream.

## Direct browser socket: security review (2026-11-25)

Proposal: a tab opens one WebSocket to the hints process at
`wss://live.blast.fun/v1/socket` and receives the same events the SSE route
sends, one SSE event block per message. The Vercel route stays for one release
as the rollback. Wire details: `handoffs/realtime-tonight/protocol.md` in the
workspace. Status: **awaiting Jose's sign-off**; the flag stays off until then.

What changes: the hints service is already a public Render web service, but
every route that does work needs the signed gateway proof. `/v1/socket` is its
first unsigned route that does work. It must not become a free fan-out, an
amplifier, a way to starve other tabs, or a way to read anything the public SSE
stream does not already show.

What it carries: only public market data (trades, candles, prices, presale
fills, activity hints) for the pools the URL names. No account, no wallet, no
write path. A leaked frame is not a confidentiality loss.

### Admission, in this order

Each step runs only if the one before it passed, so unauthenticated requests
never write to Redis and a ticket is never burned on a refusal.

1. `Host` is `live.blast.fun` (or the configured live host) and `Origin` is
   exactly the site origin. Otherwise **403 before upgrade**. Only a
   cross-site page or a script sees this, and neither needs a reason.
2. Upgrade with `Sec-WebSocket-Protocol: blast-live.v1` set explicitly, so the
   ticket entry is never echoed. Every later refusal **accepts and then closes**
   with a code. A browser cannot read a pre-upgrade status or `Retry-After`; it
   only sees `error` and 1006.
3. Ticket HMAC and `exp` → close 4401.
4. Query (same parsers as SSE, plus `resume`) → close 4400.
5. Per-instance pool and coin limits per IP → close 4429.
6. Global capacity → close 4503.
7. One Redis step: fleet-wide per-IP sockets and opens → close 4429, then burn
   the ticket nonce → close 4401 if reused. Redis down → close 4503 (fail
   closed).

Clients treat a handshake that never opens like 4503: wait a random 1–30 s.
After 3 failures in a row, the tab uses SSE for 10 minutes.

### Controls

| Risk | Control |
| --- | --- |
| Anyone opens sockets | A **ticket** from `POST /api/launchpad/market/ticket`. The route is behind the first-party API gate. It has no per-IP quota: web routes carry no rate limits (founder ruling). The gate cookie costs one page GET, so the ticket is a **cost, not authentication**. The socket limits below are the real bound. Ticket: `key = HMAC(gateway secret, "blast-live-ticket-v1")`, then `HMAC(key, payload)`. The payload is `{v, exp, n, o}`. A ticket lives 60 s and is **single use**: its nonce is burned with `SET NX PX <remaining life>` under its own `live-ticket:` prefix in the private-replay Redis. |
| Ticket leaks through logs, history or Referer | The ticket travels only in `Sec-WebSocket-Protocol`, never in the URL. Surfaces that must not record it: Render request logs (they record the path only), error and trace reporters, and refusal close reasons. A test checks that no refusal echoes it. |
| Another site embeds the socket | Exact `Origin` match, and the ticket binds `o`. The server never reads `Cookie`. The gate cookie is `__Host-` (host-only); sign-off checks that no first-party cookie uses `Domain=blast.fun`. |
| One client starves the shared tables | Limits per IP across the fleet: **8 open sockets** and **20 opens a minute** (resumes count). One Redis script on the private-replay store checks both, then burns the ticket, so the count holds at any instance count. Closes remove their entries in one batched command per address; a failed removal is retried every 2 s and once more at drain. An entry also expires after the longest socket life plus 5 minutes (65 min), so a crashed instance frees its slots by then. Per IP, per instance: **4 distinct pools** and **40 distinct price coins** across that IP's sockets, because they guard that process's own tables. The key is `ClientAddress.rateKey`, a /64 for IPv6. Global tables per process: 64 pool topics and 128 price coins (`MARKET_STREAM_BUDGET`). A socket whose new topics or coins would not fit is refused with 4503; tables never fill silently. A pool the engine never snapshots frees its slot after 10 s. |
| Process exhaustion | Sockets and SSE streams share the relay's client ceiling: the configured `BLAST_BACKEND_MAX_HINT_STREAMS`, at most 1,024 per instance (`ACTIVITY_HINT_STREAM_BUDGET.maxClients`, a 64 MiB queue budget per relay; activity SSE has its own relay with the same cap). Fleet capacity is instances × the configured value. The rollout percent keeps expected sockets under 70% of that. Measured locally on 2026-11-25: about 60 KB a socket under traffic, CPU before memory; raising the configured value needs a Render memory and CPU reading first. One upstream reader socket per process, never one per browser. |
| Expensive subscriptions | Topics are fixed at connect, using the SSE parsers (`marketStreamPools`, `marketStreamPriceCoins`, `marketStreamPresale`, `marketStreamActivity`): ≤ 2 pools, ≤ 20 price coins, ≤ 1 presale. `resume=<pool>~<cursor>` is allowed at most 2 times. Its pool must match `POOL_KEY`, appear in `pool=` and not repeat; its cursor must match `EVENT_CURSOR`. Otherwise 4400. The browser cannot send subscribe messages. |
| Client messages | The only accepted message is `{"op":"ping","t":<int>}`: at most 128 bytes and 1 a second. Anything else, binary or over the rate closes 1008. `maxPayloadLength` is 1 KiB and `perMessageDeflate` is off. |
| Slow readers | The relay queue (64 KiB a client) is the control: overflow closes 4408. Bun's `backpressureLimit` is 256 KiB with `closeOnBackpressureLimit`, as a backstop only. |
| Liveness | Heartbeat every 4 s, sent only while upstream is confirmed alive (PR #31). The hub watchdog clears prices after 9 s. Bun `idleTimeout` is 60 s and `sendPings` is on, so a socket stays open through an upstream reconnect; heartbeats are not what keeps it open. |
| Resume ring | Per pool: the last 2 minutes, at most 256 frames and 64 KiB. A replay is at most 32 KiB, under the 64 KiB queue; anything larger gets a normal fence and the browser refetches. The ring dies with its topic when the last subscriber leaves, so it pins no topics or upstream subscriptions. |
| Long-lived sockets | Each socket closes 1000 after a random 30–60 minutes and reconnects with a fresh ticket. So turning the flag off, rotating the secret, or changing a limit reaches every socket within an hour. |
| Reconnect storms after a deploy | Drain closes with 1012, spread over 5 s. Clients wait a random 1–30 s before reconnecting. Prices may clear (9 s watchdog), and the screens' 15 s CDN poll covers the gap. A resume from the ring avoids a history refetch per tab. |
| Data integrity | Frames are the reader's frames after the same checks: an explicit type allowlist with a validator per type, `parseInfraProvenance`, cursor and deployment fingerprint. New frame types (for example `coin_stats`) are added to the allowlist with a validator. The socket adds no data source. |
| Spoofed client IP | The hints service runs `trusted-proxy` ingress, so `render.yaml` declares `BLAST_BACKEND_TRUSTED_PROXY_CIDRS`. `ingressAddress` keys on the last `X-Forwarded-For` entry, the one Render appended; client-sent entries before it are ignored. Measured 2026-11-25: Render's proxies sit in 10.24.0.0/13 and append to a forged header (2 entries arrive). Null means refuse; it never falls back to the peer address. |
| Transport | TLS ends at Render's proxy (managed certificate). `wss` only. CSP `connect-src` adds the live origin from configuration per environment, checked by `assertPlainSources`. `/v1/socket` is served only on the live host. |

### Residual risks

- A stolen, unused ticket gives one public market stream for up to 60 s,
  nothing more.
- A client with many IPs can still hold sockets up to the global cap. The cap
  and the per-IP limits bound the cost, and Render's network is the DDoS
  layer. Cloudflare is added only if a measurement shows the need.
- Pre-existing: the global tables can already be exhausted through SSE by
  scripts that hold a gate cookie. The per-IP pool and coin limits above
  apply to sockets only.
- Unsigned routes on the service: `/v1/socket`, plus the existing liveness
  (`/v1/live`), `/v1/health` and readiness.
  The last two are bounded by a 5 s cache and 8 requests in flight.

### Sign-off

- [ ] Jose: controls accepted, flag may go on.
- [ ] Render `X-Forwarded-For` test recorded: two client IPs get separate keys, and neither a forged leading entry nor a second `X-Forwarded-For` line changes the key, on `live.blast.fun` and the onrender.com host.
- [ ] No first-party cookie uses `Domain=blast.fun`.
- [ ] Load test: memory per socket, the chosen cap and the instance count recorded here.

## Rollout on develop (applied 2026-10-27)

1. **Hints process** `blast-backend-hints`: the backend image, Docker
   command `bun run src/hints-main.ts`, seven starter instances, shutdown
   allowance 20 s, environment per `apps/backend-api/hints.env.example` plus
   `BLAST_BACKEND_MARKET_STREAM_ENABLED=true`, `BLAST_NETWORK=mainnet` and
   `BLAST_DEPLOYMENT_FINGERPRINT`.
2. **Web app** (custom develop environment): `BLAST_BACKEND_HINTS_ORIGIN` and
   `BLAST_BACKEND_HINTS_GATEWAY_SECRET` (distinct from the API secret), then a
   rebuild.
3. **API** `blast-backend-api`: the image's default command behind
   Render's edge (no proxy), four instances, `BLAST_BACKEND_FLEET_CONFIG`.

On 2026-10-27 both moved to Render's Production environment under these names,
replacing the `-dev` services with identical settings. The same services serve
blast.fun after develop merges to main (`docs/deploy/RENDER.md`).

The evidence and per-step log are in the workspace
(`outputs/verification/2026-10-27-backend-capacity-10k/rollout-log.md`).
Rollback of step 2 leaves streams failing closed (pages poll); it does not
restore an API stream path.

## Reads: the committed reader

The writer is the only read server today; a restart produced 963 × 503 over
124 s. The committed reader (`blast-infra read`) already serves the
market/presale catalogue and `/v1/ws` (activity, feed, coin, pool topics) with
a 30 s staleness refusal and no writer fallback. Every caller now selects it
the same way, through `BLAST_INFRA_READ_MODE=committed-markets` and
`BLAST_INFRA_READ_ORIGIN` (`blastInfraReadOrigin`): Bun API and web reads via
`blastInfraFetch`, and server sockets, including the hints process's, via
`blastInfraSocketUrl`.

Rehearsal before routing: two reader processes with a least-privilege login
on the hosted database; restart the writer at low load and record reader 503s
and maximum watermark age. If ingestion pauses beyond 30 s, choose a shorter
handoff or a different bound explicitly; do not serve stale data.

## API profile and partner reads

The deployed API is one development instance behind the dev Nginx; that
profile caps every caller, partners included, at 100 r/s. Production runs
the image's default command (`bun run src/main.ts`) directly behind Render's proxy
(`BLAST_BACKEND_INGRESS_MODE=trusted-proxy`), at least two replicas, with
`BLAST_BACKEND_FLEET_CONFIG` so startup checks the fleet arithmetic.

Partner reads stay fast by construction: authenticated at the regional
boundary, counted in their own reservation (`partnerReservedInflight`), served
from the shared public read cache (`cachedMarketUpstream`) and, with reader
mode, from the committed reader rather than the writer.

## Trading admission

Quotes run on the executor's two warm workers, each started once and
terminated on a timeout, oversize answer, failure or exit; every quote still
has its own single-use bridge and the worker no environment. Two more quotes
may wait up to 1 s for a worker; beyond that, `quote_busy`. The quote lane is
therefore four permits, the two running ones reserved; trade submissions
keep their four permits, two reserved (one per lane in turn on small replicas),
inside the unchanged eight-work aggregate, so slow
provider reads (wallet 60 s, creator earnings 300 s), uploads and renders can
no longer starve trading (`apps/backend-api/README.md`). This changed pinned
admission assertions; the owner approved the policy on 2026-10-27.

## Node and sponsor bounds

- Server-side mainnet reads (trading, wallets, sales, intents, vesting,
  health, wallet challenges, launch reads, social worker) use
  `mainnetNodeUrl`: the existing `PRESALE_SUI_GRPC_URL` under presale's
  validation, else the public fullnode; a refused value fails closed. Point it
  at a provisioned provider before scale (paid; approval).
- The gas pool admits at most `GAS_POOL_MAX_IN_FLIGHT_EXECUTIONS` (64) per
  instance and aborts abandoned provider calls (blast-gas-pool#15). Each Bun
  process already holds at most eight sponsor calls (its long-work and trade
  lanes), so keep `8 × API replicas ≤ 64 × pool instances`; a busy answer
  otherwise follows the existing unknown-outcome recovery.

## Bursts and memory

- Browser tabs spread plain activity, connect and resync looks over up to
  1 s (`HINT_SPREAD_MS`): one hint reaches every tab at once, and the
  synchronized re-reads were refused at the API's in-flight bound (1.1 % of
  reads locally) until spread.
- Bun spreads connected-stream closes over its drain (30 s API, 5 s hints).
- Bun's activity and market relays still close **every** stream when their
  engine socket fails or resyncs, and browsers reconnect within about a second
  (activity 0–1 s full jitter, charts 0.5–0.75 s): one process's tabs reconnect
  together. Reader routing removes the writer restart as a trigger; the fix is
  follow-up 1.

## Fleet budget (proposed inputs, unmeasured)

Proposed mix: 10,000 users × 1.2 tabs × 70 % visible ≈ 8,400 subscribed tabs;
30 % on coin pages; 10 % trading at one quote per 10 s ≈ 100 quotes/s.

- Hints: `(R − 1) × 512 × 0.8 ≥ 8,400` → R ≥ 22 hints processes.
- Quotes: two warm workers per API process; at most two more quotes wait up
  to 1 s for one. Starting a worker took 270–720 ms locally (bundled or not,
  Bun 1.4.2, loaded host), which every quote paid before; now only the first
  on each worker does. With quotes arriving at random, two workers and two
  waiting places refuse about 2.5 % at 5 quotes/s per process and under 1 %
  at about 3–4/s (a 150 ms provider; the local 1,000-user runs measured 2.6 %
  and 0.6 %). Size API processes at about 4 quotes/s each: about 25 for
  100 quotes/s, more if the hosted provider is slower. Provider latency, not
  streams, drives quote capacity.
- Database clients per API replica: primary 10 + auth 2 + verifier 2 +
  reporting 2; replica 10 + 2. Observed `max_connections` is 3,604 with 35 in
  use; database CPU, I/O and pooler limits are unknown.

## Follow-ups, in order

1. Keep relay streams open across an engine reconnect: send `resync` as a
   hint, paced (128 streams every 100 ms worked in the retired worker), and
   reconnect upstream in the relay,
   instead of closing every client. Changes the pinned close-on-failure tests
   (`hint-relay.test.ts`, `market-stream.test.ts`); own PR.
2. Gas-pool busy → "not submitted": an explicit `submitted → reserved`
   rollback so a busy pool answer is retried at once.
3. Native journal retention design with provenance (no deletion as a fix).
4. Hosted measurements when authorized: browser p95/p99 and freshness,
   quote throughput per process, stream RSS, reconnect bursts, writer
   replacement under reader routing, overload recovery.
