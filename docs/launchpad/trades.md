# Curve trades: spot Buy and Sell on the bonding curve

`apps/web/src/components/launchpad/trade/` is the trade rail for a Live launch. It runs
on the shared transaction boundary ([transactions.md](transactions.md)):
fresh preflight, one review, one signature, reconciliation by digest. Nothing
here writes a Move call or a curve formula: reads decode the shared `Launch`
through the SDK, previews are the SDK's `previewBuy` and `previewSell`, and
transactions are `LaunchpadTransactions.buy` and `sell`.

## Pieces

| Piece | Where | Use |
| --- | --- | --- |
| `parseTradeAmount`, `formatAtomic` | `amount.ts` | the only display edge: text to an exact positive `u64` (refusing empty, negative, zero, malformed, over-precision, and overflow); a point is the decimal separator, and a comma is accepted only as a thousands separator in the whole part after a non-zero leading group (`1,000.5`, never `0,500`), otherwise it is refused with guidance, never dropped; and atomic units to exact text |
| `readCurve` | `curve-read.ts` | the `Launch` read from the node and decoded by the SDK, with the object version and time it was observed, the coin's decimals (from its canonical supply), and its ticker |
| `curveTradeAdapter("buy" \| "sell")` | `curve-adapter.ts` | the adapter: fresh launch and balances, lifecycle and balance eligibility, the review facts, the SDK build, and completion on the configured launchpad's `Bought` or `Sold` |
| `tradeGuidance` | `guidance.ts` | what to do after a refusal or failure: retry, refresh, adjust, change route, stop, or wait |
| `curveAbortOf` | `aborts.ts` | what a curve abort means (15 lifecycle, 16 slippage, 17 zero output), read through the shared, package-checked `launchpadAbortOf` in `launch/advanced/contract-errors.ts` and only from the accepted launchpad package's `launch` module; any other abort is a plain execution failure |
| `readCompletedTrade`, `describeCompletedTrade` | `completed-trade.ts` | what a completed trade's event says (amounts in, out, refunded); a buy's amount paid is the event's `quote_in`, already net of any refund |
| `CurveTradeProvider`, `CurveTradeRail` | components | the provider owns both directions' controllers above the terminal (handing the rail the gated ones from `gateWhileUnresolved`, and following them with `watchCurveTrades`), so a trade survives the rail moving between the desktop column and the mobile sheet; mount it under a `LaunchpadSignerProvider` |
| `commitSignedBuy`, `reportCompletedBuy`, `signingPrivySession` | `outcomes.ts` | a Buy's verified outcome (below): the buy controller's commitment of its signed digest, and the report of a completed `Bought` with the signing Privy session's token |
| `coinTradeActions`, `serverTradeAvailability`, `CurveTradeUnavailable` | `coin-trade-slot.tsx`, public coin page | the rails' part of the coin page's execution contract ([coin-page.md](coin-page.md)): the page passes `coinTerminalSlots(page, coinTradeActions(…))`, which fills the `trade` slot with the curve rail for the bonding curve (offered only when the fresh launch object is Live) and the venue rail for a migrated launch's recorded pool (below); without a released, connected deployment each says trading is unavailable |

## Rules

- Signed out, the rail shows an indicative estimate from the last curve read,
  labeled with the launch version and the time it was observed (and called
  possibly stale after a minute). Every review reads the launch and balances
  again, previews with the SDK, builds, and simulates.
- Review facts: Buy shows what you pay, the refund above the graduation
  target, what you receive about, the fewest you accept (the preview less the
  slippage tolerance, rounded down), curve fees, whether the buy reaches the
  graduation target, slippage, launch state, the route with the launch version,
  and both balances. Sell shows what you sell, what you receive about, the
  fewest you accept, the sell burn, fees, and the same context. Network,
  signing wallet, and deployment come from the preflight.
- Any changed fact, including the launch version after another trade,
  replaces the review and needs confirmation; nothing is signed. On a busy
  curve this can repeat: each confirmation reads Sui again, and if another
  trade landed in between, the review is replaced once more. This is
  intended (the version is a material fact), not a loop to suppress; a
  replaced review also reads the curve and balances again.
- Only Live curves trade. An opening round, a reached graduation target, or a
  graduated coin refuses with what to do instead.
- The input survives every refusal, rejection, and failure. Nothing signs or
  submits again on its own.
- A lost submission answer (ambiguous) is resolved only by "Reconcile and
  continue", which reads that transaction by its digest and never signs or
  submits again.
- Until it resolves, nothing new starts in either direction. The provider
  hands the rail controllers whose `submit`, `chooseSigner`, and `approve`
  do nothing while `unresolvedTrade` finds an ambiguous trade, so no review
  opens ("Review", "Review again"), no signer is chosen, and no open review
  is signed. The rail also disables those buttons ("Review buy/sell",
  "Review again", the signer choices, and "{Buy/Sell} and sign"), and the
  other tab says which trade is unresolved. "Cancel", "Back", and "Change
  the amount" stay available.
- Known limit (inherited from T-004, which keeps ambiguity in page memory):
  reloading the page clears the unresolved state, so a new review can open
  before a trade whose answer was lost has been reconciled. Check the
  wallet's history before trading again after a reload.
- Balances are read when a review opens or is replaced, when the preflight
  refuses (a wallet is connected by then), and after a completed trade. The
  last read is advisory: a short balance is noted but never disables
  Review, because the review reads balances again and refuses a short one.
  A notice that a curve is not Live is labeled with the launch version and
  time it was observed.
- Success needs the completed event. Completion invalidates
  `launch:<id>`, `curve:<id>`, `chart:<id>`, `activity:<id>`, and
  `wallet:balances`: the rail refreshes its curve and balances, and the page
  passes the rest to `onInvalidate`.

## Diagnostics

`diagnostics.ts` derives, from the shared action states, `curve_review_shown`,
`curve_review_replaced`, `curve_signature_requested`,
`curve_review_abandoned`, `curve_rejected`, and `curve_failed` (stage and a
closed-list reason, including slippage, lifecycle, and zero output from the
accepted launchpad package's abort codes, through `curveAbortOf`). `curve_completed` (latency bucket, execution delta between the reviewed
and the completed amount, and first or repeat trade on the launch) is reported
from the completed event, once per digest (a per-browser ledger); only a
completed `Bought` also reports `curve_conversion`. Properties are closed lists
only, and reporting never blocks or changes a trade. These events are client
diagnostics, not outcome metrics: the conversion that counts is the verified
Buy outcome below.

## Verified Buy outcomes

Each completed Buy is reported to the verified-outcome route
(`POST /api/launchpad/outcomes`, [telemetry.md](telemetry.md)), which
verifies it on the configured node and records at most one `buy` outcome per
completed `Bought`, attributed to the event's sender wallet. The browser never
asserts who bought. The new-visitor-to-Buy numerator comes from these
verified outcomes, not from `curve_conversion`.

- **Commitment before submission.** The buy controller
  (`createCurveTradeControllers`) passes the shared controller's `onSigned`
  hook ([transactions.md](transactions.md)), so after the wallet returns a
  valid signature and before the transaction is sent, the rail calls
  `commitSignedOutcome({ kind: "buy", launchId, txDigest })`. It is not
  awaited and a throw is ignored, so a failed or slow commitment never delays
  the submission. It lets the server link this browser's visitor to a
  direct-wallet Buy. A declined signature, a review that is refused, and a
  Sale commit nothing.
- **Report on completion.** `curveCompletionHandler` reports
  `reportVerifiedOutcome({ kind: "buy", launchId, txDigest })` exactly where
  the rail reports `curve_conversion`: once per digest through the same
  per-browser ledger, so a reload or a reopened page with the same digest
  does not report again (and the reporter sends each event once per page).
  When the review's signer is a Privy wallet that is still connected, its
  session's access token goes with the report (`privyToken`, sent only as
  the request's Bearer header) if it is read within 2 s
  (`BUY_PRIVY_TOKEN_TIMEOUT_MS`); otherwise the report goes without it. A
  direct wallet has no session.
- A Sale, a declined or failed signature, an on-chain failure, a
  submission that stays unresolved, a simulation, and a completed
  transaction without the configured launchpad's `Bought` never report. A
  Buy whose submission answer was lost reports only once "Reconcile and
  continue" finds it completed. A reporter or route
  failure, timeout, or refusal never blocks, delays, or alters the trade,
  its refresh, or later trades.
- The commitment and the report go only to the server; nothing about them is
  shown or sent to analytics. Outcomes remain a lower bound: a completed
  Buy whose event cannot be read back reports neither its diagnostics nor its
  outcome.

## Development harness

`/dev/launchpad/trade` (development only; a dev server started with `BLAST_LAUNCHPAD_ENABLED=true`) drives the rail on a fixture node
with one Live launch: lifecycle, wallet answer, a competing trade now or while
you sign, a lost or aborted submission, simulation, node reads, coin
balances for both fixture wallets, and the Privy fixture wallet's session
token, with the diagnostics and refreshed reads shown. A signed Buy commits
its digest to the real commitments route; a completed Buy is landed on the
dev server's fixture node (`harnessOutcomeReporter`, through the fixture
chain's `transactionOf`, about a checkpoint's delay after it completes) and
then reported to the real outcomes route, which verifies it there when the
dev server runs with `BLAST_LAUNCHPAD_ENABLED=true`, `LAUNCHPAD_FIXTURE_CHAIN_ORIGIN` and
`npm run dev:coin-fixtures -w @blast/web`. The page shows whether the last landing
succeeded.

# Venue trades: spot Buy and Sell on a migrated launch's recorded pool

After migration a launch trades only on the venue pool it recorded. The venue
rail runs on the same transaction boundary. Nothing here writes a venue Move
call: route checks, quotes, builds, and reconciliation are the SDK's adapter
for the recorded venue (`@interest-protocol/blast-sdk/migrators`): Cetus CLMM
(`cetus-venue.ts`) or Bluefin Spot (`bluefin-venue.ts`).

## Pieces

| Piece | Where | Use |
| --- | --- | --- |
| `readVenueRoute`, `venueSupported`, `readVenueAvailability`, `recordedPool`, `recordedPoolPrice`, `readRecordedSwap` | `venue-route.ts` | the recorded route from chain records only: the fresh launch (Migrated, its `migration_witness` and tier through `launchMigrationRoute`), the migration transaction named by the locator (its launchpad `Migrated` must name this launch and it must hold exactly one migrators `VaultCreated` on the launch's witness and coins), the LP vault it created (decoded from the deployment's migrators package; its pool must be the event's), and the venue pool. The venue dispatch picks the driver from the recorded witness: Cetus CLMM (`resolveCetusVenueRoute`) or Bluefin Spot (`resolveBluefinVenueRoute`); any other recorded venue is `unsupported-venue`, before any record is read. A page pool key that disagrees (another pool, or the recorded pool under the other venue) is `route-substitution` |
| `simulatedCetusQuoteTransport`, `withQuoteRetries`, `quoteCetusTrade` | `venue-cetus.ts` | the Cetus quote: the transport simulates the SDK's own exact-input swap (`buildCetusSwapTransaction`, minimum one atom) on Sui and reads its `SwapEvent` through the SDK; a rejected simulation is a refusal, a transport failure is retried once (`CETUS_QUOTE_ATTEMPTS`). Quotes are valid for `CETUS_QUOTE_VALID_FOR_MS` (20 s) after quoting; Cetus has no on-chain expiry and the minimum output protects on chain |
| `resolveBluefinRecord`, `simulatedBluefinQuoteTransport`, `withBluefinQuoteRetries`, `quoteBluefinTrade` | `venue-bluefin.ts` | the Bluefin driver: the recorded `Pool<Meme, Quote>` (the Meme is coin A) read and resolved by the SDK; the Bluefin provider quote transport (the SDK's `BluefinQuoteTransport`) simulates the SDK's own exact-input `pool::swap` (`buildBluefinSwapTransaction`, minimum one atom) on Sui and reads its `AssetSwap` through the SDK; a rejected simulation (including the one a client runs while building, to estimate gas) is a refusal, a transport failure is retried once (`BLUEFIN_QUOTE_ATTEMPTS`). Quotes are valid for `BLUEFIN_QUOTE_VALID_FOR_MS` (20 s); the SDK's builder refuses them afterwards (`expired-quote`), and on chain `amount_limit` is the minimum output, below which Bluefin aborts with `slippage_exceeds` (1010) |
| `venueTradeAdapter("buy" \| "sell")` | `venue-adapter.ts` | the adapter: route, the recorded venue's availability (`access.venues[venue]`), balances, amount, and a fresh quote from that venue's driver; review facts; that venue's SDK build; the SDK's reconciliation of the simulated swap before signing (`checkSimulation`); and success only when the completed swap reconciles against the signed quote (`completionFor`) |
| `gateVenueTrades`, `reviewExpired`, `venueGuidance`, `venueProblem` | `venue-session.ts` | both directions gated while a trade is unresolved; approving an expired review quotes again for a new confirmation instead of signing; refusals and failures in words (a Move abort is never shown raw, except, until the Cetus quote-transport follow-up lands, a Cetus refusal raised while the client builds the quote probe, which is retried as an outage and keeps the raw abort in the block's details; Bluefin's `slippage_exceeds`, read only from the deployment's Bluefin Spot package, says the pool moved past the minimum) |
| `VenueTradeProvider`, `VenueTradeRail`, `VenueTradeUnavailable` | components | the venue rail; mount the provider under a `LaunchpadSignerProvider` with the launch's locator (`launchId`, the migration transaction digest from its classified activity, and the page's pool key) |
| `/dev/launchpad/venue-trade` | `VenueTradeFixtures.tsx`, `venue-fixtures.ts` | development fixtures (a dev server started with `BLAST_LAUNCHPAD_ENABLED=true`): a Cetus-migrated and a Bluefin-migrated launch (NEWT, six decimals), route and venue substitution, a missing record, an unavailable Cetus venue, absent or mismatched recorded Bluefin objects, an absent Bluefin pool, a Bluefin fee or layout change, a quote provider outage (all venues, or Bluefin only), another trader landing right after the quote (Bluefin's `slippage_exceeds` in simulation), wallet answers, submission outcomes, a competing trade, and a clock that expires quotes |

## Rules

- The venue is never chosen: no control names another venue or pool, and the
  route is read again from chain records for every review. A launch that
  recorded Bluefin trades only through the Bluefin adapter, and one that
  recorded Cetus only through the Cetus adapter.
- Review facts: trade, venue pool (recorded at migration), what you pay or
  sell, what you receive about, the fewest you accept (`minimumOut`, the quote
  less the slippage, rounded down), the venue fee in the input coin, the price
  impact the quote states, the pool price before the trade, slippage, the
  recorded route (vault, tick spacing, pool fee), and both balances. Network,
  signing wallet, and deployment come from the preflight. The quote's expiry
  is shown with the review. Amounts use the coin's decimals from its canonical
  supply and SUI's own; any other Quote is refused (`unsupported-quote`).
- Approval quotes and simulates again: a changed value replaces the review for
  confirmation, and an expired review is quoted again rather than approved.
  The builder refuses an expired quote in any case.
- Signing is disabled, with the reason, for an unsupported venue or route, a
  substituted record, a deployment that does not record the venue's lineage
  or admit the tier, an unavailable venue (`venue-unavailable` with the SDK's
  reasons, such as an absent or mismatched recorded Bluefin `GlobalConfig`),
  or a quote provider outage. A problem with one venue never blocks the
  other: each review checks only its recorded venue. The pool, the curve's
  history, and the migration stay readable.
- Two Bluefin limits fail closed. The SDK decodes the whole Bluefin Spot v17
  `Pool` layout, so a Bluefin layout change refuses every Bluefin pool
  (`unsupported-route`) until the SDK is updated. The pool's fee rate must
  equal the launch's recorded fee, so a Bluefin admin fee change closes that
  launch's route (`route-substitution`, naming both fees).
- Failures are told in words: a Move abort in a simulation or on chain is
  never shown raw. Until the Cetus quote-transport follow-up lands, one
  exception remains: a Cetus refusal raised while the client builds the quote
  probe (gas estimation) is still retried as a provider outage and shows its
  raw abort text in the block's details. Bluefin's `slippage_exceeds` says the pool moved past your
  minimum after the quote and to review again or allow more slippage. A Sui
  mainnet dry run of the SDK-built swap (T-041, read-only, nothing signed)
  confirmed that `amount_limit` is the minimum output: a Buy and a Sell with
  their minimum at the pool's output simulate, and one atom above it aborts
  with `slippage_exceeds` in `pool::swap`, reported at the revision's
  package ID.
- Completion invalidates `venue-pool:<id>`, `venue-chart:<id>`,
  `venue-activity:<id>`, and `wallet:balances`, never the curve's `chart:` or
  `activity:` keys: venue trades are a separate series. The rail describes a
  completed swap from its own venue event (`SwapEvent` or `AssetSwap`).
- Until the app serves a released, connected deployment, the coin page's venue
  slot shows `VenueTradeUnavailable` with the reason. The coin page does not
  carry the migration digest yet; the classified activity's `migration` row
  (T-025) is its source when the venue rail mounts live.

# Opening round

While the fresh launch object is in its opening round, the coin page renders
its `bid` slot from `apps/web/src/components/launchpad/opening/opening-slot.tsx`:
the round's pooled facts read for the request (`OpeningRoundUnavailable` in
`OpeningRoundFacts.tsx`), the indexed bidder count, the pro-rata delivery rules,
and why Join (before the deadline) or Settle (after it) cannot be signed in this
app. The app has no Join, Settle or Delivery rail; they were removed unmounted
(owner decision, 2026-11-10, #772).
