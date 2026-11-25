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
`wss://live.blast.fun/v1/live` and receives the same events the SSE route
sends, one SSE event block per message. The Vercel route stays for one release
as the rollback. Wire details: `handoffs/realtime-tonight/protocol.md` in the
workspace. Status: **awaiting Jose's sign-off**; the flag stays off until then.

What changes for an attacker: today a stream costs them a gated page load and a
Vercel function, and the hints process only accepts requests signed with
`BLAST_BACKEND_HINTS_GATEWAY_SECRET`. The direct socket opens a public listener
on the hints process. It must not become a free fan-out, an amplifier, or a
way to read anything the public SSE stream does not already show.

What it carries: only public market data (trades, candles, prices, presale
fills, activity hints) for the pools the URL names. No account, no wallet, no
cookie, no write path. A leak of a frame is not a confidentiality loss.

### Controls

| Risk | Control |
| --- | --- |
| Anyone opens sockets without loading the site | A **ticket** from `POST /api/launchpad/market/ticket`, behind the existing first-party API gate (gate cookie from a page load). HMAC-SHA256 with the existing gateway secret under the label `blast-live-ticket-v1` (no new secret); payload `{v, exp, n, o}`; 60 s life; **single use** (nonce burned with `SET NX PX` in the private-replay Redis the gateway proof already uses). Checked before upgrade: bad, expired or reused → 401. |
| Ticket leaks through logs, history or Referer | Sent only in `Sec-WebSocket-Protocol` (`blast-ticket.<t>`), never in the URL. Server echoes only `blast-live.v1`. Request logs must not record that header. |
| Another site embeds the socket (cross-site WebSocket) | `Origin` must equal the configured site origin (`siteOrigin`), exact match, before upgrade → 403. The ticket also binds `o`. The `Cookie` header is ignored, so there is no ambient authority to hijack. |
| One client opens many sockets | Per-IP cap of 16 open sockets and 30 opens per minute per instance → 429 + `Retry-After`. The ticket route keeps its own per-IP quota identity. The client IP is the single `X-Forwarded-For` address from Render's proxy (`trusted-proxy` ingress); **verify before the flag goes on that Render overwrites the header rather than appending a client value**, or a client could choose its own bucket. |
| Process exhaustion | Global stream cap `BLAST_BACKEND_MAX_HINT_STREAMS` per instance (set from the load test's memory per socket, starter plan 512 MB) → 503 + `Retry-After`. One upstream reader socket per process, never per browser. |
| Expensive or broad subscriptions | Topics are fixed at connect from the query, parsed by the same `marketStreamPools`, `marketStreamPriceCoins`, `marketStreamPresale` and `marketStreamActivity` as SSE (≤ 2 pools, ≤ 20 price coins, ≤ 1 presale). A malformed query → 400. No subscribe messages from the browser. |
| Client messages as a vector | The only accepted message is `{"op":"ping","t":<int>}`, ≤ 128 bytes, ≤ 1 per second; anything else, binary, or over the rate closes 1008. `maxPayloadLength` 1 KiB. |
| Slow readers hold memory | Bun `backpressureLimit` 64 KiB and `closeOnBackpressureLimit`; the relay's per-client queue budget (64 KiB) closes 4408. Idle timeout 30 s, with heartbeats every few seconds keeping healthy sockets open. |
| Reconnect storms after a deploy | Drain closes with 1012 spread over 5 s; clients wait a random 1–30 s before reconnecting after 1012 or 503, with jittered backoff otherwise. Resume from a 2-minute ring avoids a history refetch per tab. |
| Data integrity | Frames are the reader's frames after the same envelope checks (`parseInfraProvenance`, cursor, deployment fingerprint). The socket adds no data source. |
| Transport | TLS ends at Render's proxy for `live.blast.fun` (managed certificate). `wss` only. CSP `connect-src` adds exactly `wss://live.blast.fun`. |
| Secret reuse | The ticket key derives from the gateway secret with a distinct label, so a ticket can never verify as a gateway proof or the reverse. Rotation of the gateway secret rotates both. |

### Residual risks

- Ticket replay inside its 60 s window is blocked by the single-use burn; a
  stolen unused ticket gives one public market stream, nothing more.
- A determined client with many IPs can still hold up to the global cap. The
  cap and the per-IP limits bound the cost; Render's network is the DDoS layer.
  Cloudflare is added only if a measurement shows the need.
- The hints process becomes internet-facing. Its other routes keep requiring
  the signed gateway proof; only `/v1/live` (and `/v1/health`) accept unsigned
  requests.

### Sign-off

- [ ] Jose: controls above accepted, flag may go on.
- [ ] Render `X-Forwarded-For` behaviour verified on `live.blast.fun`.
- [ ] Load test: memory per socket and the chosen stream cap recorded here.

## Rollout on develop (applied 2026-10-27)

1. **Hints process** `blast-backend-hints`: the backend image, Docker
   command `bun run src/hints-main.ts`, two starter instances, shutdown
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
