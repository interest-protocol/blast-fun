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
| Coin chart candles and header price | The direct market socket (`wss://live.blast.fun/v1/socket`), committed trades as they land | Bun hints role, `MarketStreamRelay` |
| Blast Mode Discover | Initial HTTP read and later pages over HTTP. The existing market socket replaces the first New and Almost graduated pages, including their pagination tokens. | Committed reader and Bun hints role |
| Compact coin trade tape | Initial history over HTTP. Committed fills and bounded reconnect catch-up on the same market socket. | Bun hints role, `MarketStreamRelay` |
| Opening-round bidder count | The same market stream's `opening_round` frames (at most one per pool per checkpoint, never replayed); the page's `router.refresh()` (`refreshIntervalMs`: 30 s, 10 s while a section is stale, 5 s on a conflict) stays as the fallback | Bun hints role, `MarketStreamRelay` |
| New activity, presale lifecycle, coin identity changes | Hint frames on the same socket ("look now"), then the surface's own coalesced read; a tab without a market subscription opens an activity-only socket (`?activity=true`) | Bun hints role |
| Holders, coin activity tab, feeds, rankings | Visible-tab poll (15–30 s) plus hint-triggered reads; CDN keys shared per checkpoint | Existing routes |
| Wallet, portfolio, viewer state | Private no-store reads on lifecycle signals and user actions | Bun API |
| Quotes and trade submissions | Request/response, admission-reserved (below) | Bun API |
| Partner reads | `/v1` request/response through the partner boundary | Bun API, committed reader |

Hints never carry balances, prices or financial state. Hidden tabs hold no
stream and no retry timer.

## One browser stream role: the isolated Bun hints process

Every browser stream is a WebSocket to the isolated hints process
(`apps/backend-api/src/hints-main.ts`) at `/v1/socket` on the live host. The
tab first asks the web app for a single-use ticket (`POST
/api/launchpad/market/ticket`), signed with
`BLAST_BACKEND_HINTS_GATEWAY_SECRET` for the site origin. It never falls back
to the API process.

Why this one:

- It is the only role that carries the continuous market stream, so a coin
  page needs one browser stream for candles, price and hints
  (`continuous-market-data.md`).
- It never shares the API's connection ceiling, admission or database pools.
- It holds no web-function invocation per tab.

The kill switch is `BLAST_LIVE_SOCKET_URL` on the web app: unset, the ticket
route answers 204, tabs have no stream and stay on their polls, and they ask
again after 30 minutes.

Retired on 2026-11-25: the Vercel SSE relays (`/api/launchpad/market/stream`
and `/api/social/activity/hints`), their signed SSE routes on the hints
process, the browser's relay fallback and the socket rollout percent. The
market stream path stays as the socket's query shape (`MARKET_STREAM_PATH`).

Retired on 2026-10-27, after the hints process went live on develop: the
`live-hints` worker and its Render service, the old hint ticket route
(`/api/social/activity/hints/token`) with its token signer and the browser's
ticket client, the coin-topic `coin_market` hints only that worker produced
(and the coin page's hint-driven reads of them), and the API process's own
activity stream. Coin pages keep their 15 s poll; a chart's trades and its
header price arrive on its market stream.

## Direct browser socket: security review (2026-11-25, `set` added 2026-11-26)

A tab opens one WebSocket to the hints process at
`wss://live.blast.fun/v1/socket` and receives its events as SSE event blocks,
one per message. Wire details: `handoffs/realtime-tonight/protocol.md` in the
workspace. The SSE relay that was the rollback is retired; the rollback is now
unsetting `BLAST_LIVE_SOCKET_URL` (tabs poll).

What changes: the hints service is already a public Render web service, but
every route that does work needs the signed gateway proof. `/v1/socket` is its
first unsigned route that does work. It must not become a free fan-out, an
amplifier, a way to starve other tabs, or a way to read anything the public
pages do not already show.

Revision of 2026-11-26: an open socket may now change what it streams with one
client message, `set`, instead of closing and opening a new socket with a new
ticket. A `set` opens nothing, burns no ticket and makes no Redis call; it is
bounded by its own per-socket rate, the per-IP limits of this instance and the
process tables. The sections below cover both.

What it carries: only public market data (trades, candles, prices, presale
fills, activity hints) for the pools, price coins and presale the socket holds:
the ones its URL named at connect, then whatever each `set` left it holding:
an accepted `set` names it exactly, and a refused one may still have removed
some of it (removals apply first). At any moment that is at most 2 pools,
20 price coins and 1 presale.
No account, no wallet, no write path. A leaked frame is not a confidentiality
loss.

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
4. Query (the market stream parsers, plus `resume`) → close 4400.
5. Per-instance pool and coin limits per IP → close 4429.
6. Global capacity → close 4503.
7. One Redis step: fleet-wide per-IP sockets and opens → close 4429, then burn
   the ticket nonce → close 4401 if reused. Redis down → close 4503 (fail
   closed).
8. Global capacity again, since another socket may have filled the tables
   while Redis answered → close 4503 (the ticket is already burned). Nothing
   awaits between this check and joining the relay.

Clients treat a handshake that never opens like 4503: wait a random 1–30 s.
After a 4429, or 3 sockets in a row that close before their first frame, the
tab asks for no ticket for 60–90 s (`LIVE_BACKOFF_MS`, times a random 1–1.5).
Meanwhile the hub reports the stream unavailable and charts, prices and feeds
keep their polls; then the socket is tried again.

### A `set` on an open socket, in this order

`{"op":"set","seq":<int>,"pools":[…],"price_coins":[…],"presale":<id>|null,"discovery":<bool>}`
replaces the whole wanted set; `activity` stays as the socket opened, so a
client that may `set` a presale opens with `activity=true` (without it the
socket gets presale frames but no `presale_checkpoint` hint). The optional
`discovery` field defaults to false. The browser sends it after the gateway
advertises `discovery: true` in its hello. When a Discover page exceeds its
socket frame budget, the gateway sends an unavailable page at that revision
and the browser reads the view over HTTP until a usable live page arrives. The
server answers each `set` it does not close on with one
`event: set` block: `{"seq","ok":true,"held":{…}}`, or
`{"seq","ok":false,"reason","retry_ms","held":{…}}`. `held` is what the socket
streams after the answer. A refusal never closes the socket.

1. Frame: a string of at most 8 KiB, JSON, the five required keys and the optional
   boolean `discovery`, `seq` a
   safe integer, and pools, coins and presale that pass the same market stream
   parsers as the URL (≤ 2 pools, ≤ 20 coins, no repeats, valid keys).
   Otherwise **close 1008**.
2. State: a `set` before admission finished (no relay handle yet) or while the
   socket is closing → **close 1008**. While the instance drains → `busy`,
   retry in 5 s (the drain close follows).
3. Rate: at most **10 `set`s a minute per socket** → `rate`, retry when the
   oldest leaves the window. A `set` refused for rate does not count.
4. Removals always apply: pools, coins or the presale the new set drops are
   released from this socket's per-IP share and from the relay. A changed
   presale counts as a removal of the old one.
5. Per-IP, per-instance tables after the additions: **4 distinct pools** and
   **40 distinct price coins** → `per_ip`, retry in 60 s.
6. Per-IP churn: at most **40 added pools a minute per address** on this
   instance → `churn`, retry when the window frees. The history is kept apart
   from the sockets, so closing every socket and reopening does not reset it.
7. Process tables (`fits()`: 64 topics, 128 coins; no client-count term, the
   socket already holds its client slot) → `busy`, retry in 5 s.
8. Answer `ok`, then the relay joins the added pools, so the answer always
   comes before their catch-up frames. Additions are all or nothing.

### Controls

| Risk | Control |
| --- | --- |
| Anyone opens sockets | A **ticket** from `POST /api/launchpad/market/ticket`. The route is behind the first-party API gate. It has no per-IP quota: web routes carry no rate limits (founder ruling). The gate cookie costs one page GET, so the ticket is a **cost, not authentication**. The socket limits below are the real bound. Ticket: `key = HMAC(gateway secret, "blast-live-ticket-v1")`, then `HMAC(key, payload)`. The payload is `{v, exp, n, o}`. A ticket lives 60 s and is **single use**: its nonce is burned with `SET NX PX <remaining life>` under its own `live-ticket:` prefix in the private-replay Redis. |
| Ticket leaks through logs, history or Referer | The ticket travels only in `Sec-WebSocket-Protocol`, never in the URL. Surfaces that must not record it: Render request logs (they record the path only), error and trace reporters, and refusal close reasons. A test checks that no refusal echoes it. |
| Another site embeds the socket | Exact `Origin` match, and the ticket binds `o`. The server never reads `Cookie`. The gate cookie is `__Host-` (host-only); sign-off checks that no first-party cookie uses `Domain=blast.fun`. |
| One client starves the shared tables | Limits per IP across the fleet: **8 open sockets** and **20 opens a minute** (resumes count). One Redis script on the private-replay store checks both, then burns the ticket, so the count holds at any instance count. Closes remove their entries in one batched command per address; a failed removal is retried every 2 s and once more at drain. An entry also expires after the longest socket life plus 5 minutes (65 min), so a crashed instance frees its slots by then. Per IP, per instance: **4 distinct pools** and **40 distinct price coins** across that IP's sockets, on every trusted site together (Redis counts are per site), because they guard that process's own tables; a `set` is checked against them after its removals and refused `per_ip`. Per IP, per instance: at most **40 pools added by `set` a minute**, since each new pool can cost the reader one snapshot; this history outlives the address's sockets. The key is `ClientAddress.rateKey`, a /64 for IPv6. Global tables per process: 64 pool topics and 128 price coins (`MARKET_STREAM_BUDGET`). A socket whose new topics or coins would not fit is refused with 4503, and a `set` whose additions would not fit is refused `busy` (the socket stays open with its kept set); tables never fill silently. The reader snapshots every pool it streams, tracked venue pools included; the relay drops a pool's frames until its snapshot. A pool fault never closes a socket: see [Pool recovery](#pool-recovery). |
| Process exhaustion | Sockets share the relay's client ceiling: the configured `BLAST_BACKEND_MAX_HINT_STREAMS`, at most 1,024 per instance (`ACTIVITY_HINT_STREAM_BUDGET.maxClients`, a 64 MiB queue budget per relay). Fleet capacity is instances × the configured value; size it so expected sockets stay under 70% of that. Measured locally on 2026-11-25: about 60 KB a socket under traffic, CPU before memory; raising the configured value needs a Render memory and CPU reading first. One upstream reader socket per process, never one per browser. |
| Expensive subscriptions | At connect and on every `set`, the same market stream parsers (`marketStreamPools`, `marketStreamPriceCoins`, `marketStreamPresale`; `marketStreamActivity` at connect only) bound a socket to ≤ 2 pools, ≤ 20 price coins and ≤ 1 presale. A `set` replaces the whole set, so a socket never holds more than one URL's worth. `resume=<pool>~<cursor>` is allowed at most 2 times, at connect only. Its pool must match `POOL_KEY`, appear in `pool=` and not repeat; its cursor must match `EVENT_CURSOR`. Otherwise 4400. A pool added by `set` gets a fresh fence, or catches up at once from a pool the process already holds. The upstream cost of a `set` is bounded by the 10-a-minute socket rate and the 40-pools-a-minute address churn. |
| Client messages | Two messages are accepted. `{"op":"ping","t":<int>}`: at most 128 characters and 1 a second. `set` (above): at most 8 KiB and 10 a minute; the first `set` over the rate is answered `rate` and the socket stays open, and another before the window frees closes 1008. Anything else, binary, a ping over its rate, or a malformed `set` closes 1008. `maxPayloadLength` is 8 KiB and `perMessageDeflate` is off. |
| Slow readers | The relay queue (64 KiB a client) is the control: overflow closes 4408. Bun's `backpressureLimit` is 256 KiB with `closeOnBackpressureLimit`, as a backstop only. |
| Liveness | Heartbeat every 4 s, sent only while upstream is confirmed alive (PR #31). The hub watchdog clears prices after 9 s. Bun `idleTimeout` is 60 s and `sendPings` is on, so a socket stays open through an upstream reconnect; heartbeats are not what keeps it open. |
| Resume ring | Per pool: the last 2 minutes, at most 256 frames and 64 KiB. A replay is at most 32 KiB, under the 64 KiB queue; anything larger gets a normal fence and the browser refetches. The ring dies with its topic when the last subscriber leaves, so it pins no topics or upstream subscriptions. |
| Long-lived sockets | Each socket closes 1000 after a random 30–60 minutes and reconnects with a fresh ticket. So turning the socket off, rotating the secret, or changing a limit reaches every socket within an hour. |
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
- The `set` churn limit is per instance. One address whose sockets land on
  N instances can add up to 40 × N pools a minute fleet-wide. Each instance's
  reader cost is still bounded by its own limit and its 64 topics.
- `set` frames: 10 accepted a minute per socket averages about 1,667 a second
  at 10,000 sockets. The window allows bursts: each socket can send its 10 at
  once, plus one `rate` refusal (also parsed and answered), so a synchronized
  burst is up to 11 frames per socket. Each is parsed in memory with no I/O; a
  socket that keeps sending past the rate is closed.
- Unsigned routes on the service: `/v1/socket`, plus the existing liveness
  (`/v1/live`), `/v1/health` and readiness.
  The last two are bounded by a 5 s cache and 8 requests in flight.

### Sign-off

Redone on 2026-11-26 for `set`: the earlier review covered URL-only topics.

- [ ] Jose: controls accepted, including the `set` message (2026-11-26), `BLAST_LIVE_SOCKET_URL` may be set.
- [ ] Render `X-Forwarded-For` test recorded: two client IPs get separate keys, and neither a forged leading entry nor a second `X-Forwarded-For` line changes the key, on `live.blast.fun` and the onrender.com host.
- [ ] No first-party cookie uses `Domain=blast.fun`.
- [ ] Load test: memory per socket, the chosen cap and the instance count recorded here.
- [ ] `set` measured on dev (PR 2): tickets, opens and `set`s per tab over 5 minutes, before and after.

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
Rollback of step 2 leaves tabs without a stream (pages poll); it does not
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

## Pool recovery

The market relay (`MarketStreamRelay`) closes a browser's socket only for a bad
hello or another deployment's frame. Everything else is recovered in place.
Each line is the `status` a browser gets.

- **One pool lost its fence** (no fence 10 s after its subscribe, a failed or
  too old resume, an `error` naming the pool, `not_ready`, a
  `snapshot_unavailable` with reason `unavailable`, or a bad, oversized or out
  of order frame for it, which is dropped): `{state: "recovering", pool_key}`
  once. The relay unsubscribes and subscribes the pool again, at once, then
   after 5 s, 10 s and every 30 s, and sends `live` with the new fence. Charts
   refetch as usual. The compact tape refetches when the fence cannot prove
   coverage past the browser's last trade.
- **The reader does not know the pool** (`snapshot_unavailable`, reason
  `not_found`): `{state: "unavailable", pool_key}` once. The relay frees the
  reader's topic and asks again every 60 s.
- **The upstream dropped, or sent a frame no pool can be blamed for:**
  `{state: "recovering"}` with no pool, heartbeats for 30 s (older tabs then
  fall back on their own), and `{state: "fresh"}` once a new upstream is ready.
  Fenced pools resume by cursor.
- **No market progress for 30 s** (no market frame and no rise in a pong's
  `market_checkpoint`): `{state: "stale"}`, then `{state: "fresh"}`. Only a
  reader whose pongs carry `market_checkpoint` can make the stream stale; a
  quiet market on an older reader is not a fault.
- An oversized hint is dropped.

Older browser hubs ignore `recovering`, `stale` and `fresh`.

### Discover and trade tape

Each reader produces one pair of first pages from the same committed PostgreSQL
snapshot. It runs the existing newest and bonding-progress queries on demand
after a relevant market change. Each gateway shares one reader subscription and
broadcasts only when the page or its pagination token changes. Almost graduated
starts at 60%, with the same sorting and threshold as HTTP. While the socket
is unavailable, first-page browsers retry the shared HTTP route every 25–35 s.
Older pages use the HTTP pagination token. Verified badges come from HTTP.

For the compact tape, resume uses the same gateway's bounded replay ring when
it covers the cursor. A different gateway can recover from the reader's last
50 committed fills, provided it finds the exact last cursor and the response
fits the socket's byte budget. Otherwise the browser reads classified history
at the new fence. Opening full activity loads history as needed. Normal fills
on an already connected tape cause no browser request or per-viewer database
read.

### Local 10,000-tab rehearsal

Use an isolated PostgreSQL 16 listening at `127.0.0.1:55410` with database
`live_discover_run`, owner `live_load`, password `disposable-fixture` and
`shared_preload_libraries=pg_stat_statements`. Use a disposable Valkey at
`127.0.0.1:55411`. The [reader fixture documentation](https://github.com/interest-protocol/blast-infra/tree/main/loadtest)
describes how to combine the pinned framework and reader migrations. Create
`blast_infra` and the `pg_stat_statements` extension, apply the roles and
migrations with `search_path=blast_infra`, then apply
`apps/backend-api/test/live-discovery-load.sql` as the local database owner.
Start the built reader from the companion change with:

```sh
env -i PATH="$PATH" \
  DATABASE_READ_URL=postgres://live_load_reader:disposable-reader@127.0.0.1:55410/live_discover_run \
  INFRA_API_KEYS=local-fixture-only-live-socket-api-key \
  BLAST_DEPLOYMENT_FINGERPRINT=$(printf 'a%.0s' {1..64}) \
  READER_MAX_LAG_MS=120000 READER_WS_CONNECTIONS=32 HTTP_MAX_CONNECTIONS_PER_PEER=64 \
  /path/to/blast-infra read --listen-address 127.0.0.1:55412 --metrics-address 127.0.0.1:55413
```

Run this from the Blast web and gateway checkout:

```sh
bun --no-env-file apps/backend-api/test/live-discovery.load.ts 10000 3600
```

The test starts twelve loopback gateways and a local ticket issuer on port
55414. It counts 6,000 Discover subscribers, 3,000 tabs on three busy pools,
and 1,000 spread across the other seeded pools. It checks live row order, trade
continuity, filter changes, a killed gateway, and a fleet-wide reconnect during
commits. It also checks a burst of commits and reports p95 receive time, the
slowest reconnection, ticket requests, PostgreSQL statement calls, gateway CPU
and memory. Pass `1` as the third argument to put all 3,000 busy-pool tabs on a
single pool. The harness checks that all tabs recover within 45 s and that no
fixture trades are missing or duplicated. It also flags socket receipt above
1 s at p95. Measure the product target of 1 s at p95 from commit to paint in a
browser against the same fixture.

## Bursts and memory

- Browser tabs spread plain activity, connect and resync looks over up to
  1 s (`HINT_SPREAD_MS`): one hint reaches every tab at once, and the
  synchronized re-reads were refused at the API's in-flight bound (1.1 % of
  reads locally) until spread.
- Bun spreads connected-stream closes over its drain (30 s API, 5 s hints).
- The market relay keeps every stream open when its engine socket fails: it
  sends `status recovering`, keeps heartbeats for 30 s and reconnects upstream
  (see [Pool recovery](#pool-recovery)). Only a bad hello or another
  deployment's frame still closes every stream.

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

1. Done: relay sockets stay open across an engine reconnect
   ([Pool recovery](#pool-recovery)).
2. Gas-pool busy → "not submitted": an explicit `submitted → reserved`
   rollback so a busy pool answer is retried at once.
3. Native journal retention design with provenance (no deletion as a fix).
4. Hosted measurements when authorized: browser p95/p99 and freshness,
   quote throughput per process, stream RSS, reconnect bursts, writer
   replacement under reader routing, overload recovery.
