# Coin competitions v1

Competitions reuse the continuous, chain-verified frontend swap receipts from
`social_swap_receipts`. Creating a competition does not start a collector, change
swap execution, or scan historical chain transactions. Deploy swap tracking
(PR #409, migration 0125) before the competition's start.

## Configure an event

An authorized operator runs the existing operator credentials against the primary:
`MISSION_CONTROL_OPERATOR_ALLOWED_ID`, `MISSION_CONTROL_OPERATOR_TOKEN_SHA256`,
`BLAST_OPERATOR_ID`, `BLAST_OPERATOR_TOKEN`, and `DATABASE_URL`. Never commit these.

Create a JSON file with a unique URL slug, name, fully qualified Sui coin type,
symbol, and UTC epoch millisecond start/end:

```json
{
  "slug": "sui-week-one",
  "name": "SUI trading week",
  "coin_type": "0x2::sui::SUI",
  "coin_symbol": "SUI",
  "feature_on_swap": true,
  "prize_description": "Top three share the organizer’s prize pool",
  "rules_url": "https://x.com/your_project/status/your_rules_post",
  "starts_at_ms": 1793001600000,
  "ends_at_ms": 1793606400000
}
```

Prize text and the HTTPS X/Twitter rules link are optional; prize text requires a rules link.
For the card's "Prize pool" figure ("25,000 WAL"), add `prize_amount` (whole coins as a
plain decimal string, positive, at most nine places, such as `"25000"`) with the
prize coin's `prize_coin_type` and `prize_coin_symbol`. The three go together, need a
rules link, and are stored as configured (migration 0141); the app only displays them.
An optional `coin_icon_url` accepts an HTTPS image URL for any coin. Without it,
the header uses the shared canonical coin artwork where available and a
coin-type-derived fallback otherwise. A reused symbol never selects another
coin's branding. Broken images also fall back while symbol/type inspection stays available.
Replace the example link with the actual organizer post. No prize amounts or payout
promises are inferred by the app. Choose future dates for your actual event. Run from the repository root:

```sh
npm run competitions -w @blast/web -- create /private/path/event.json
npm run competitions -w @blast/web -- list
```

Creation normalizes the coin type, validates the window, records the operator and
creation time, and publishes an immutable configuration. No runtime update/delete
grants or edit endpoint exist. A repeat slug fails rather than changing rules.
This first version has no enrollment, rewards, payout automation, or admin UI.
The public pages are `/competitions` and `/competitions/<slug>`.
Announcements can link directly to an event. Event pages show the
configured name once, with coin identity, UTC schedule, optional prizes and the
organizer's X announcement/rules link.

## Live placement on Swap

Set `feature_on_swap: true` when creating an event to promote its coin in Swap's
existing coin-selection shortcuts. The default is false. Promotion is live only
within `[start, end)`; upcoming and completed events stay in the directory.
The shortcut appears before normal choices, with a pink tint and two brief wave
sweeps, then rests. Reduced motion keeps the static tint. The card below identifies
the live competition once and provides leaderboard/rules links. Selecting the coin
uses the existing swap flow.
Ending an event removes promotion without clearing a selected coin, entered amount,
quote or pending transaction. It does not change saved favorites.

`GET /api/social/competitions?placement=swap` reads public configuration only,
using server time and the same route gates/rate limits. It returns up to 25 unique
live coin types, ordered by start then slug. Overlapping events for one coin use
the earliest start/slug; the next becomes eligible as its predecessor ends.
The response includes server time and the next featured start/end boundary.
Existing indexed trade metadata resolves decimals and presale eligibility in a
batch, including coins without a Blast presale. Missing metadata never creates a
selectable placeholder; the event remains available in the competition directory.
The router still decides whether it can quote a pair.

The frontend shares one read, refreshes within 30 seconds and at the next boundary,
and revalidates on window focus. A server-relative clock removes expired promotion
within a second even if a refresh is unavailable; a failed read hides promotional
chrome while the normal swap keeps working. No scheduler or deletion job is needed.

## Scoring and privacy

Rules version 1 counts successful tracked frontend swaps involving the configured
coin on either side, once per transaction, within `[start, end)` using verified
chain time. Internal route hops are not additional volume. Concurrent/overlapping
competitions may independently count the same qualifying receipt.

The immutable intent's account ID determines the member. The account must be
public now and must have been sharing at the swap's timestamp. The contributing
address must still unambiguously belong to that same member, with a link predating
the swap. Linking an address later never claims historical swaps. Private members
and addresses that are no longer eligible disappear on the next read.

Volume is the saved **input USD estimate at swap preparation**, not a claim of
execution-time valuation, profit, or net position. PostgreSQL sums NUMERIC values
exactly; API amounts are decimal strings. Unpriced swaps are retained and counted
separately, excluded from USD totals. Members with only unpriced swaps have no
rank; a known zero is distinct. Equal USD totals share rank (1, 1, 3), with account
ID as the deterministic page order. All public members participate automatically;
only those with qualifying receipts appear.

## Architecture and growth

The write path remains receipt-first, independent of competitions. A new coin or
event is one configuration row. The read path scopes receipts with the existing
`(timestamp_ms, trade_id)` index, joins immutable intents and live identity/privacy,
then groups/ranks in SQL. Only 25 members plus a next-page sentinel leave the DB;
raw swaps never get loaded into the web process for ranking. The board is ranked
once per read (a materialized CTE), so its `members_total` (the "Traders" tile, on
every board page and on the viewer's rank read) costs one count of rows already
ranked, never a second pass over the receipts. The directory carries no member
count: it would rank every listed event's receipts per page.

`GET /api/social/competitions?page=1` lists current/upcoming configurations;
`&period=past` lists completed events (`ends_at_ms <= now`). The directory exposes
both views with shareable URLs, resets pagination when switching and filters in
SQL before the page limit. Add `&slug=<slug>` for a leaderboard, including past
events. Past boards retain current privacy/ownership checks rather than freezing
public identities. The operator CLI's `list` still includes all configurations.
Both public reads use the social route kit's rate limiting and feature gates.
They read the primary because receipts are private source data without replica
grants. Responses are `private, no-store`, even for anonymous reads, so a public
cache cannot retain a newly private member's data. No per-event worker, job queue,
new database, or balance/price network calls are required.

Measure the bounded window aggregate before adding machinery. If query latency
or sustained traffic warrants it, add a rebuildable per-competition/member
aggregate over these same receipts, using unique `(competition, trade_id)` credits
for idempotency and retaining live privacy checks. The receipts remain the source
of truth; versioned rules permit a new scoring policy without reinterpreting old
competitions. Do not cache public identities independently of current privacy.

Migration 0126 is additive. Apply 0125 and 0126 before deploying these pages.
Rollback the application first; dropping 0126 discards configuration only and
leaves the continuous swap history intact.
