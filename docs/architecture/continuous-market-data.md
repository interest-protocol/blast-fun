# Continuous coin charts

The coin detail chart consumes committed trades through the same-origin
`/api/launchpad/market/stream` SSE route. It offers `1s`, `1m`, `5m`, `15m`,
`1h`, `4h`, `1d` and `1w` candles. A one-second interval describes the bucket,
not a guaranteed one-second delivery deadline: updates arrive after the Rust
engine commits the relevant checkpoint. No trade means no new candle. Wall
clock time never creates or closes a candle.

## Ownership and sharing

The browser sends one or two canonical `pool` parameters, for the curve and
the venue recorded by its committed migration, and `activity=true`. The
isolated hints process authenticates the existing private gateway proof and
owns one shared market WebSocket per process. Its pool subscriptions are
shared by viewers. It also subscribes to activity hints on that socket.

Named `market` events carry validated market frames. Named `hint` events carry
only the existing sanitized hello, pong, activity and presale-lifecycle hints.
Hints remain refresh signals; they never supply a price or a candle. Existing
hint coalescing, reader admission, reconnect catch-up and visibility policy
remain intact.

Once the market handshake is usable, hint consumers release their legacy SSE
connection and use the chart's carrier. They retain their existing connection
while the chart is connecting and recover it when the market carrier fails or
unmounts. The carrier retains only hello/pong for a late subscriber; it never
replays activity or treats a market cursor as an activity cursor. Ownership
generations prevent a previous chart from clearing its replacement's carrier.
There is one established browser stream in the healthy combined case. A
recovery handshake may briefly overlap the healthy hint fallback; stream
admission, connection deadlines and retry backoff still apply.

## History and exact updates

Each pool has an independent committed subscription fence. The chart subscribes
first, buffers a finite tail, and reads its validated candle history over HTTP.
The HTTP checkpoint must cover both the subscription fence and any accepted
stream checkpoint. Buffered frames covered by that complete checkpoint are
discarded; subsequent trades are applied once in numeric cursor order.

Prices stay decimal strings and volumes stay bigint. A trade updates the
forming candle in the chosen interval; its open is the preceding close.
Missing intervals stay gaps. If the bounded page does not establish that open,
the chart requests authoritative history instead of inventing it. Rust's closed
candles replace matching native intervals. A stream discontinuity, migration
change, invalid provenance, missing anchor or buffer overflow requires recovery.
Curve and venue histories remain separate through migration.

Every accepted trade is aggregated. Chart and shared header-price publication
are coalesced to animation frames. The header receives the accepted raw quote
price and applies the coin's existing decimal conversion; no USD price is
inferred. A partial trade from the header's complete HTTP checkpoint cannot
replace that HTTP price. A validated durable candle baseline can correct the
same checkpoint. Disconnects mark a retained streamed header price paused.

HTTP history remains the initial read, recovery authority and existing
15-second visible-tab freshness check. Hidden charts release the stream and
timers. Source/deployment/control changes invalidate previous asynchronous work.
The original history-only URL parser remains compatible; the live coin page
uses the parser that also accepts `1s`.

## Bounds and operation

The market relay holds at most 64 distinct pool topics per process and two
pools per browser stream. It has a 128 Ki-character upstream frame bound,
16 KiB emitted market-frame bound and 64 KiB downstream queue per client.
Hints retain their existing 1 KiB emitted bound. The browser's recovery tail
is limited to 128 frames and 64 Ki characters. Saturation returns a retryable
503 or closes a slow stream; HTTP history remains readable. A representative
50-trade snapshot from the Rust contract is below the input bound; unusually
large snapshots can still require degraded recovery.

Market and legacy hints share the existing native transport stream permits,
maximum 512 per process. The relay's additional upstream socket is explicitly
included in the fleet envelope; the legacy activity socket remains budgeted for
other clients. This is process-local fan-out, not a distributed subscription
directory or evidence of capacity for 10,000 distinct pools.

Homepage Coins adds at most 20 visible coin types to the same browser stream.
Each hints replica reads up to 128 distinct coin prices in one committed USD
snapshot every two seconds while subscribed. This adds zero browser requests per
price update and at most 16 reader requests per second across 32 hints replicas,
including with 10,000 visible tabs. Each `prices` event carries only changed
observations and its applied checkpoint. The homepage applies these to the price
column and keeps the ranked list on its regular read and refresh path. A full
price subscription budget leaves that tab on its regular list reads while its
other stream subscriptions stay connected.

Roll out the compatible committed reader before applying its display-price
view grant. Enable the updated hints process once the view is available, then
ship the web client.

To enable locally or in a separately approved deployment:

- Configure the dedicated hints origin and distinct gateway secret on the Web
  adapter. The market route refuses fallback to the ordinary API process.
- Set `BLAST_BACKEND_MARKET_STREAM_ENABLED=true` on the hints process, with an
  explicit `BLAST_NETWORK=mainnet` and `BLAST_DEPLOYMENT_FINGERPRINT`.
- Set fleet `hints.marketStream=true` and declare `marketSubscribedTabs`; the
  fleet settings must match the running process and provider resource budgets.
- Existing envelopes conservatively add market subscribers to activity tabs.
  To describe this combined browser profile, explicitly set
  `hints.sharedBrowserStream=true` and `legacyMarketStreams` to the reserved
  count for older clients and overlapping reconnects. This mode budgets visible
  tabs plus that explicit reserve; it never silently assumes zero overlap.
  Market tabs cannot exceed visible tabs. The existing after-one-failure
  utilization check still applies. These are declarations about the supported
  browser profile, not discovered client counts or measured capacity.
- Retain real topology, per-process pool diversity, Redis, proxy buffering,
  reconnect-storm, RSS and browser freshness measurements before making any
  hosted capacity or latency claim.

The stream is read-only and uses the existing Rust protocol. No ingestion,
schema, chain or provider operation is authorized by this feature. Ingestion
and combined ingestion/read acceptance remain **BLOCKED** pending coordinator
decision.
