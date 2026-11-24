# Permanent coin page

`/coin/{coinType}` uses the Sui coin type as the public coin identity. It
accepts short package addresses and uses the normalized type for its canonical
URL. The indexed Blast origin selects the original bonding-curve launch or
the existing presale page, including after either graduates. A coin without
a Blast origin uses its own metadata.

Existing `/coin/{launchId}` URLs still render the exact launch, including
query parameters for chart settings and activity. Their canonical URL uses the
coin type once the launch identifies it. Keep using the launch-ID URL right
after publication, when the node can already read the object but the index may
need time to map its coin type.

An indexed presale also accepts `/coin/{presaleId}` as an alias. It redirects
to `/presale/{presaleId}` with the original query parameters. The private
coin-page read checks the presale index only when the web app asks for alias
resolution and the launch read did not confirm a launch.

Release the backend before the web app so the existing private coin-page route
can accept type tags before the web app sends them. Legacy backend callers keep
their response. No database migration is required. A type-keyed render adds one
10-second cached identity lookup. It adds no browser polling. At 10,000 tabs
with one navigation per tab per minute and a 30-second launch refresh, that
is about 500 identity reads per second before cache hits and coalescing.
A 5-second lifecycle-conflict refresh would raise that to about 2,167 per
second if all tabs were affected. Hosted hit rates and capacity are unmeasured.

## Blast UI presentation

The route lives under `(app)/(social)/coin/[coinKey]`. `BondingCoinScreen`
composes the existing chart, execution, holders, activity and theses slots,
with a boundary around each slot and one execution mount at every width.
The quote coin appears as its logo in new coin-page figures. The optional
`CoinPageTransfer.details` projection adds the published launch's cover,
tagline and validated website, X, Telegram, docs and audit links; older backend
responses remain compatible. The public read selects only rows with the exact
`published_launch_id` and never exposes private draft or publication state.

## Reads

`readCoinPage` (`packages/server/src/modules/launchpad-coin/read.ts`) composes, server-side,
through the validated `/v1` client:

1. `GET /v1/pools/blast_curve/{launch_id}`: identity, lifecycle, immutable
   launch settings and launch facts (`public_start_ms`, `partner`,
   `migration`), curve economics. Kept after migration as the curve history.
2. `GET /v1/coins/{coin_type}`: creator, current pool, supply, market cap,
   holders and windows across the coin's pools.
3. After migration, `GET /v1/pools/{venue}/{pool_id}` of the recorded venue
   pool (`migration.pool_key`, else the coin's `current_pool`).
4. The launch object, fresh from the node through the SDK (`getLaunch`,
   `launchMigrationRoute`), in parallel with the curve read. The read has a
   2.5 s deadline (`FRESH_READ_TIMEOUT_MS`) and is aborted at it; a node that
   does not answer in time is Unavailable, so nothing waits on a stalled node.

The `/v1` shapes (coin summary, venue pool, plan, split, windows) are parsed
in `launchpad-contract/coin.ts`, beside T-024's launch summary.

Every indexed section keeps blast-infra's provenance. A lagging answer is
Stale; a starting, failing or unreachable engine serves the last answer this
process saw as Stale (`createLastGood`), else Unavailable. Nothing is
recomputed from SQL. Starting economics and progress come from the SDK
(`deriveLaunchEconomics`, `launchProgressBps`) over the indexed settings.

## Browser reads

The browser never talks to blast-infra (WP2): every `/v1` and `/v1/ws`
request needs a server-only key (`BLAST_INFRA_API_KEY`, sent as
`x-blast-infra-key`), and the page is never handed blast-infra's origin. The
chart, Holders and Activity read the same way
(`apps/web/src/components/launchpad/blast-infra-browser.ts` and `use-market-poll.ts`):
the validated `/v1` client builds and checks each read (provenance,
deployment, contract), but its fetch goes to this app's same-origin
`/api/launchpad/market/*` routes (`marketRoute`: `/v1/<path>?<query>` becomes
`/api/launchpad/market/<path>?<query>`), with a 3 s timeout
(`browserMarketDependencies`). Each route relays exactly one `/v1` read and
returns blast-infra's status and JSON body unchanged, so the parsers are the
same. There is no live socket (Vercel cannot relay a WebSocket): each
destination re-reads at once and every 15 s while the tab is visible
(`POLL_MS`), and when the tab is shown again.

### Market routes

`packages/server/src/modules/launchpad-market/routes.ts`, one handler behind route files
under `apps/web/src/app/api/launchpad/market/`. Each request counts in its route's rate
bucket per client IP (`launchpad_market_*`, `packages/core/src/lib/web-security/rate-limits.ts`;
429 with `Retry-After` when full, 503 when the limiter cannot count), then its
parameters are checked strictly (canonical IDs and coin types, only the query
keys the page sends, each once, through the validated client's own path
builders; else 400 `invalid_parameter`), then blast-infra is read once with
the key.

| Route | blast-infra | Bucket (per IP) | CDN cache of a 200 |
| --- | --- | --- | --- |
| `GET /api/launchpad/market/coins/{coin_type}/holders?view=snapshot&limit&cursor` | `/v1/coins/{coin_type}/holders` | `launchpad_market_holders`, 240/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/launches/{launch_id}/activity?view=classified&limit&cursor` | `/v1/launches/{launch_id}/activity` | `launchpad_market_activity`, 240/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/pools/blast_curve/{launch_id}` | `/v1/pools/blast_curve/{launch_id}` | `launchpad_market_pool`, 240/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/pools/{venue}/{pool_id}/candles?interval&from&to&limit` | `/v1/pools/{venue}/{pool_id}/candles` | `launchpad_market_candles`, 480/min | 5 s; a page ending (`to`) at or before blast-infra's committed checkpoint 5 min, then 1 h stale |
| `GET /api/launchpad/market/pools/{cetus or bluefin}/{pool_id}/trades?before&limit` | `/v1/pools/{venue}/{pool_id}/trades` | `launchpad_market_trades`, 240/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/status` | `/v1/status` (a refusal's provenance) | `launchpad_market_status`, 120/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/launches/{launch_id}/rewards` | `/v1/launches/{launch_id}/rewards` | `launchpad_market_rewards`, 240/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/wallets/{address}/launch-rewards?limit&cursor` | `/v1/wallets/{address}/launch-rewards` | `launchpad_market_wallet_launch_rewards`, 120/min | never: `private, no-store` |
| `GET /api/launchpad/market/wallets/{address}/vault-rewards?limit&cursor` | `/v1/wallets/{address}/vault-rewards` | `launchpad_market_wallet_holder_rewards`, 120/min | never: `private, no-store` |
| `GET /api/launchpad/market/wallets/{address}/launches?limit&cursor` | `/v1/wallets/{address}/launches` | `launchpad_market_wallet_launches`, 120/min | never: `private, no-store` |
| `GET /api/launchpad/market/creator-claims?recipient={address}` or `?account={commitment}`, `&limit&cursor` | `/v1/creator-claims` | `launchpad_market_creator_claims`, 120/min | never: `private, no-store` |
| `GET /api/launchpad/market/partners?limit&cursor` | `/v1/partners` | `launchpad_market_partners`, 120/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/partners/{partner_id}` | `/v1/partners/{partner_id}` | `launchpad_market_partner`, 120/min | 5 s, then 5 s stale |
| `GET /api/launchpad/market/launchpad/policy` | `/v1/launchpad/policy` | `launchpad_market_policy`, 60/min | 5 s, then 5 s stale |

The wallet vault-rewards response includes launch and presale allocations.
The coin's payout detail uses the unified vault journal. The indexer exposes
rounds by vault ID in its [current vault rewards API](https://github.com/interest-protocol/blast-infra/blob/647e23cfdb303784a01faa2c73e629cd3b82a5ad/docs/api.md#get-v1vaultsvault_idrewards).

Everything but a 200 is `private, no-store`, and so is a wallet's or a recipient's 200: it is a reader's own page. blast-infra's refusals (4xx) and
engine errors (5xx, such as `503 not_ready`) are relayed as they are; an
unreachable or slow engine is `502 unreachable`, a body that is not JSON
`502 bad_gateway`, and a refusal of this server's key (401/403)
`502 unavailable`, so a reader never sees the key or blast-infra's words
about it. Unconfigured (`BLAST_INFRA_ORIGIN` unset) is `503 unconfigured`.
Outside a production build with no
`RATE_LIMIT_SUBJECT_PEPPER` (the fixtures' `next dev`), nothing is counted.

The chart takes the launch's venue side from one rule (`venueRoute` in
`coin/coin-view.ts`): the venue pool the curve summary's committed `Migrated`
recorded, even while the coin summary still names the curve, else the page's
venue source; and that `Migrated` cursor, null when the curve's record is
unavailable. Activity needs no venue of its own: blast-infra merges the venue
pool's swaps into the classified list.

## Chart

The chart slot (`apps/web/src/components/launchpad/chart/`) reads each source pool's
own candles in the browser, through the candles route
(`GET /v1/pools/{venue}/{pool_id}/candles` through the validated `/v1` client,
`launchpad-contract/browser-chart.ts`): the curve pool `blast_curve:<launch_id>`
and, after migration, the venue pool the committed migration recorded. The
coin-merged `/v1/coins/{coin_type}/candles` is never read, and nothing is
computed from SQL or on the server.

- **Sources.** The curve and the venue are separate series (curve candles
  solid, venue candles outlined) and separate tables, each with its own
  provenance and state. An unavailable venue leaves the curve's history and the
  marker on screen. A migration whose pool blast-infra does not track says so.
- **Migration marker.** The curve summary's committed `Migrated` (cursor and
  checkpoint time) is drawn as a dashed line and stated in words. In the
  bucket that holds it, the curve's candle is drawn before the line and the
  venue's after it, so no candle crosses it; its label has a band of its own
  above the candles. A page that
  names another migration is Unavailable (`route-mismatch`). When the curve's
  page names a migration the server read did not know of, the chart adds the
  venue pool it recorded.
- **Gaps.** Candles are drawn at their own buckets from their raw OHLC and
  volume; nothing joins or smooths them. Intervals without trades are hatched
  on the chart and listed in the table as "No trades, no candle".
- **Direction.** One exact price order (`comparePrices`) decides it for the
  drawing and the table. Besides colour, a tick on each candle's right marks
  its close (top after a rise, bottom after a fall); an unchanged candle is
  drawn in the ink colour with a level tick on both sides. The table names it
  (Up, Down, Unchanged).
- **Controls.** Interval (`1m` to `1w`; `1s` is not offered) and range (1 h to
  30 d, or all history) live in the URL (`?interval=…&range=…`), so a refresh
  or a direct link reads the same indexed history. Each read is one bounded
  page per source (at most 2,000 candles, the newest); a note says so only
  when the range holds more than a page and the page is full. Each source can
  be hidden from the chart and its table; hiding all of them says so.
- **Freshness.** It re-reads every 15 s while visible, and says so
  ("Refreshes every 15 s while this tab is open."; never "Live"). An outage
  keeps each source's last candles under a Stale label with their provenance;
  without them it is Unavailable. Controls changes never show another
  interval's candles: an answer read for other controls than the chart's is
  dropped.

The production prerequisites are the Holders destination's (below).

## Holders

The Holders destination (`apps/web/src/components/launchpad/holders/`) reads the coin's
native holder snapshot in the browser, through the holders route
(`GET /v1/coins/{coin_type}/holders?view=snapshot` through the validated `/v1`
client, `holders.ts`), for the deployment the server hands it. It
shows the snapshot's checkpoint and completeness, the holder count, the held
supply (the denominator of every share), the largest holder's and the top
ten's shares, and the holders a page of 25 at a time. Every count and share is
blast-infra's whole-coin aggregate at that checkpoint, never summed from the
loaded rows or inferred from trades.

- `incomplete`: Unavailable, with its checkpoint: no count, no zero.
- `behind`, a lagging engine, or a failed refresh: the last verified facts
  under a Stale label, with their provenance and the cause. Without verified
  facts it is Unavailable.
- A genuine zero is a complete count of 0.
- It re-reads the first page every 15 s while visible; with more than one
  page shown, a newer snapshot is offered rather than replacing the rows.
- No wallet label (`creator`, `whale`, `top_trader`) is shown: the snapshot
  has none.
- Amounts (held supply, top-holder amounts, balances) are cut to two decimal
  places, as the page says; shares are floored to 0.01%.
- The header's and overview's "Indexed holders" is the coin summary's
  `holders` (addresses with a balance, no completeness or checkpoint stated);
  only this destination's count is checkpointed and complete.

Production prerequisites: `BLAST_INFRA_ORIGIN` and `BLAST_INFRA_API_KEY` on
the web app (server-only; see `apps/web/.env.example`), and `RATE_LIMIT_SUBJECT_PEPPER`
for the routes' buckets. The reads are same-origin, so blast-infra needs no
CORS allowance for this site, and the page CSP's `connect-src` names no
blast-infra origin.

## Activity

The Activity destination (`apps/web/src/components/launchpad/activity/`; on mobile it
sits in the Theses view) reads, in the browser, through the market routes and
the validated `/v1` client (`launchpad-contract/browser-activity.ts`):

1. `GET /v1/launches/{launch_id}/activity?view=classified`: the launch's
   completed events, newest first by chain position, 25 a page with
   blast-infra's launch-bound page token (`activity.ts`). After migration the
   venue pool's swaps are rows of the same list, merged by blast-infra in
   position order, so there is one list and one cursor.
2. `GET /v1/pools/blast_curve/{launch_id}`: the curve summary's windows' flow
   fields (`readCurveFlow`): net Quote flow, buyers and sellers for 5m, 1h,
   6h, 24h and all time.

- Each row has its kind (Buy, Sell, Pre-share buy, Opening-round join,
  Settlement: pot buy, Settlement: round closed, Opening-round delivery,
  Lifecycle, Migration, Migration allocation, Creator fees claimed, Protocol
  fees claimed, Venue buy or sell), its source (a venue swap's pool, or the
  address a protocol claim or an allocation paid), its actor or Unavailable
  (the settlement, lifecycle, migration, allocation and protocol claim name
  none; a curve or venue trade's actor is its executing signer, a creator
  claim's the signer who presented the fee capability), checkpoint, time, every amount of
  its kind as display units and exact atoms, and its transaction, linked to
  the configured explorer (`explorerTransactionUrl`) when there is one. The
  settlement's pot buy is an Opening-round settlement row, never a Buy.
- Flow is blast-infra's, per window, with the window and checkpoint stated;
  the web computes none of it. It never counts the opening-round settlement or
  deliveries, and venue swaps are not part of it.
- Pages join by position, so an equal-time group split across pages appears
  once, in order. A refresh that reaches the loaded rows adds the newer ones;
  one that cannot (a gap) is offered beside several loaded pages.
- It re-reads the first pages and the flow every 15 s while visible.
- A lagging engine or a failed refresh keeps each section's last rows Stale,
  with their provenance and the cause; without rows it is Unavailable.
- No wallet label is shown: the classified rows have none, and the trade
  parser drops `labels`.

**Durable links.** `/coin/{launch_id}?activity=<checkpoint>:<tx>:<event>:<sub>`
(a row's `position`, a venue swap's included; every row's Record links to its
own) opens Activity at that record, and is the form chart timeline links must
use (none exist yet). The list starts at it (`listStart`, through
`activityAnchor`: the page token just newer than it). A list cut at a link says
so and links to the newest: "from the linked record back"
when a shown row has the position (marked `aria-current`), "no … has
position X; showing … before it" when none does, "nothing at or before
position X" when the cut leaves no rows, and, while the list loads or is
Unavailable, where it "is read from", never "no activity yet". The record, or that note, is
scrolled into view once the list first answers, and kept in view while sections
above it still load (on mobile the Theses list renders above Activity), until
the reader scrolls, taps or types, or 15 s pass (`anchor-keeper.ts`). A parameter that is not one
position is ignored.

**Deploy order.** The validated client admits the five kinds blast-infra's
LP-07 adds (`venue_buy`, `venue_sell`, `creator_fees_claimed`,
`protocol_fees_paid`, `migration_allocation`). It normalizes the protocol fee
payment to `protocol_fees_claimed` for activity views. An unknown kind is a
contract violation. Deploy this web change before that blast-infra release.
Between the two, a migrated coin's Activity shows no venue swaps: the separate
venue list is gone, and blast-infra does not merge them yet.

## Fees

**Fees and payouts**, the Overview's last group (`apps/web/src/components/launchpad/fees/`),
reads `GET /v1/launches/{launch_id}/rewards` in the browser, through the market
route and the validated client (`launchpad-contract/browser-rewards.ts`), and
re-reads it every 15 s while visible, like Activity and Holders:

- **Bonding curve** (until migration, after it): the creator's and Blast's
  shares, each earned, claimed and unclaimed in Meme and Quote, and Blast's SUI
  creation fee as its own row. Blast's share also takes its one-time migration
  fee. On a partnered launch, what the partner was paid sits under its own
  label, and Blast's claimed includes it.
- **Migration vault** (after migration): the LP fees collected, the creator's
  and Blast's shares, the partner's pay, and what the vault returned to holders
  and the coin: rewards set aside and reserved in rounds, liquidity set aside
  and added, buyback set aside and bought back and burned, recipients paid.
  The vault's protocol-owned migration residual is not an LP-fee share and is
  not shown.
- The two ledgers are never added together. Amounts are cut to display units as
  Overview and Holders cut them; unknown decimals show exact atoms. A failed
  read keeps the last figures Stale, else Unavailable, with Refresh fees.
- Portfolio → Rewards uses the same words (Earned, Claimed, Unclaimed) for a
  creator's share of each launch.

## Theses

The Theses destination (`apps/web/src/components/launchpad/theses/`; on mobile the
Theses view, above Activity) shows a confirmed launch's public posts and, where
this app can take posts, the post form. The browser reads
`GET /api/launchpad/theses?launchId=` from this app (the launch's posts from
the primary, its identity through the chain views; [social](social.md)), on
open, on Try again and after the author's own post, 20 a page with
Show more theses. A failed refresh keeps the shown posts Stale; without them
it is Unavailable. An unconfirmed launch is Unavailable.

- **A post is its author's claim.** Each says so ("Community thesis: the
  author's own claim. Blast does not review or endorse it."; creator kinds
  name the creator), with its kind, stance and opaque author ID. The
  destination opens with "Theses are their authors' claims, not Blast's."
  There is no score, summary, ranking, profit figure, copy trading, reply,
  chat or follow.
- **Labels are checked facts with their observation.** Creator: posted from
  the wallet the chain index listed as the launch's creator at the
  checkpoint the record was written against, observed when it was written.
  Holding: in (or not in) the
  holder snapshot of the coin at its checkpoint and time, or "Not verified"
  when the snapshot could not answer. A disclosed wallet shows by address.
  The author's disclosure text is shown as the author's words.
- **Inert content.** The text is text (line breaks kept, never markup or
  links). Evidence is https links without credentials only, shown by host and
  path, opened in a new tab with `rel="nofollow noopener noreferrer ugc"` and
  no referrer. Each post states its posting and revision times (UTC) and the
  checkpoint, network and deployment it was written against.
- **Posting.** Kind (community thesis, creator thesis, creator update),
  stance (optional only for a creator update), text (1,000), evidence links
  (3), an optional disclosure (280) and "Disclose the wallet I post with",
  each checked by the write's own parsers before anything is sent. "Post with
  Privy" (when `PRIVY_APP_ID` is set) signs in and posts with the session
  token; "Post with wallet" connects a direct Sui wallet and signs a
  `social_post` Wallet Proof, a free personal message, never a transaction.
  Neither initializes before it is chosen. After a post the form says what
  was stored: the kind kept (a creator kind from another wallet is posted as
  a community thesis, and the form says why) and the holding observed.
  Refusals say what happened, that nothing was posted, and how to recover;
  the server's own words are never shown.
- **Where posting is offered.** Only with `BLAST_NETWORK` and
  `BLAST_DEPLOYMENT_FINGERPRINT` set (direct wallets sign for that network);
  otherwise the destination says posting is unavailable here. Writes also
  need the launchpad runtime ([identity](identity.md#operations)).

`/dev/launchpad/theses` (development only) mounts the same list and form for
the coin fixture launch, or `?launchId=`, against the dev server's real
routes, with a fixture Privy signer (paste a token the dev server's fixture
Privy issued, and that user's embedded wallet) and two fixture wallets
(`theses-fixtures.ts`: a "creator" and an "other" key) that sign Wallet
Proofs with test keys.

## Status

The page decides its status before any slot renders. It is a real 404 when
the ID is malformed, when blast-infra answers `not_found` and the node does
not show a launch of this deployment, or when blast-infra cannot answer and
the node shows no launch (absent or foreign). A launch the node shows but
blast-infra has not indexed keeps its page with Unavailable indexed sections.

When neither source can confirm the ID (blast-infra cannot answer and has no
remembered answer for it, and the node cannot be read), the page cannot tell a
launch from an unknown ID. It answers 200 with `robots: noindex, nofollow` and
the title "Launch not confirmed", names no source, venue or lifecycle, says
that Blast cannot confirm the launch right now, and retries every 10 s
(`CoinPage.confirmed`). A launch blast-infra answered for before keeps its
page from that answer, Stale.

## Eligibility

Only the fresh launch object decides what may be offered
(`executionAvailability` in `availability.ts`):

| Launch object | Execution slot |
| --- | --- |
| unreadable, absent, foreign, or another coin | `unverified`: nothing |
| OpeningRound | `opening-round`: bids; Buy/Sell closed until settlement |
| Live | `curve`: Buy/Sell on the curve |
| MigrationReady | `migration-ready`: Buy/Sell closed; Complete migration only on a supported recorded route |
| Migrated, supported route, venue pool answered this request | `venue`: Buy/Sell on the venue pool |
| Migrated otherwise | `venue-unavailable`: nothing; the curve never reopens |

Trading follows this request's reads. A venue answer that is only lagging is
still this request's answer and keeps venue trading. A venue read that failed
now shows the remembered facts as Stale but closes venue trading, however
recently the process saw the venue.

When blast-infra's lifecycle differs from the object's, the header names both
(`conflict`) and actions follow the object. The browser re-reads the page
every 5 s while they disagree, 10 s while a section is Stale or Unavailable,
and 30 s otherwise (`refreshIntervalMs`, `CoinLive`).

`tradable` (`curve` or `venue`) is the first-view denominator: the page
reports `launchpad.coin_view.v1` only then, and the telemetry route checks
the same decision (`tradableNow`) before it records a view. That check has
its own 1.2 s deadline inside T-007's beacon budget (`unavailable`, a 503,
past it), and a launch's definite answer is reused for 5 s
(`memoizeTradable`), so a burst of beacons costs one check.

The refresh re-renders the whole page on the server and re-runs its reads for
each viewer; slots that need faster data should refresh their own.

## Integration contracts

- **Selected source** (`CoinPage.source`): `{ kind: "curve", poolKey }` until
  migration, then `{ kind: "venue", venue, poolKey }`. The chart reads the
  curve's and the recorded venue pool's candles separately (see Chart); the
  activity vertical reads that pool and keeps the curve pool (`curve.data.launch.poolKey`)
  as history.
- **Action slots** (`CoinActionSlots` in
  `components/launchpad/coin/CoinExecution.tsx`), passed to
  `coinTerminalSlots(page, actions)`:
  - `trade({ launchId, coinType, poolKey, venue })`, rendered only for
    `curve` and `venue`; the page passes `coinTradeActions` (curve rail for
    `blast_curve`, the migrated-venue rail otherwise, [trades.md](trades.md));
  - `bid({ launchId, coinType, round, bidders })`, rendered only for
    `opening-round`: `round` is the fresh launch object's start, end, pot of
    undelivered bids (`opening_round_bids`), Quote type and read time, and
    `bidders` blast-infra's indexed bidder count (null without one); the page
    passes `openingBidActions(join, settle)` ([trades.md](trades.md#opening-round)).
    After the deadline by the server's read, its unavailable reason names
    settling rather than joining;
  - `migration({ launchId, route })`, rendered only for `migration-ready` on a
    supported route.
    The coin page fills it with the public Complete migration action
    (`docs/launchpad/migration.md`).

  Each vertical still runs its own fresh preflight before signing; the page's
  eligibility never authorizes a transaction.

## Development fixtures

```bash
npm run dev:coin-fixtures -w @blast/web   # blast-infra /v1 and launch objects on :3112
BLAST_INFRA_ORIGIN=http://127.0.0.1:3112 \
LAUNCHPAD_FIXTURE_CHAIN_ORIGIN=http://127.0.0.1:3112 npm run dev -w @blast/web
curl -X POST http://127.0.0.1:3112/__fixture/state \
  -d '{"indexed":"live","fresh":"migration_ready","infra":"ok","venue":"ok","holders":"complete"}'
```

The coin route's HTTP test runs in `npm run test:integration` (and so in the
gate): it starts the fixtures and signed backend, builds the web app, and stops
the servers after the checks. To run the existing launch-ID checks against the
servers above instead:

```bash
COIN_ROUTE_ORIGIN=http://127.0.0.1:3000 COIN_FIXTURE_ORIGIN=http://127.0.0.1:3112 \
  npm run test:integration -w @blast/web -- 'src/app/(launchpad)/coin/coin-route.integration.test.ts'
```

The fixture launch is `0xa1b2…c3d4`; `indexed` and `fresh` take a lifecycle
(`fresh` also `absent` or `down`), `infra` is `ok`, `lagging`, `starting` or
`down`, `venue` is `ok`, `down` or `untracked`, `holders` (the native
holder snapshot, 30 holders in pages of 25) is `complete`, `incomplete`,
`behind` or `zero`, and `chain` (the chain the node answers for) is
`deployment` or `other`. Each pool's candles (`chart-fixtures.ts`) follow
`indexed` and `venue`: curve trades with a quiet spell, the committed
migration, and venue swaps after it with another. The fixture launch's
classified activity (`activity-fixtures.ts`: every kind, an equal-time group
across the first page's end, a settlement with its curve effects) follows
`indexed`, and after migration it serves the Bluefin pool's trades
(`venue: down` refuses them). The same server is the outcomes route's fixture
node ([telemetry.md](telemetry.md)). Only the app's server reads the fixture
`/v1` (it sends no CORS headers); the browser reads it through the market
routes. Start both with the same `BLAST_INFRA_API_KEY` and the fixture refuses
a `/v1` request without it (401), as a keyed blast-infra does. A production server
ignores `LAUNCHPAD_FIXTURE_CHAIN_ORIGIN`; without a released Blast deployment
it cannot read launch objects, so nothing is offered for execution.
