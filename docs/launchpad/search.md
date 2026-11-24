# Launchpad search

The header's centered **Search coins** trigger (or `/` anywhere but a text
field) opens Search: a centered panel on desktop, full screen on mobile. It
works signed out. As the user types, `apps/web/src/components/launchpad/search/`
reads `GET /api/launchpad/search` and shows the matches in groups. Every
match is a canonical Blast launch, or a public thesis on one, and links to
its coin. Search has no Hot, Trending, filler or score.

## What matches

A launch is canonical while blast-infra's `chain_read_v1.pools` lists its
curve (venue `blast_curve`, pool ID = launch ID) with its coin in
`chain_read_v1.coins`. Search reads chain identity only through those views
on the read replica (`readChainJoin("search")`). It never reads another
chain table and never stores a chain fact. A coin without a curve, or a
social row whose launch the views do not list, matches nothing. Theses and
their search rows are read from the primary ([social](social.md#public-reads)),
so a hidden or revised thesis stops matching at once.

| Group | Matches | Why, by tier |
| --- | --- | --- |
| On-chain IDs | a `0x` address equal to a launch ID or a migration pool ID (Cetus, Bluefin), mapped to its launch | `launch_id`, then `pool_id` |
| Wallets | a `0x` address equal to the coin's creator (`coins.creator`) | `creator` |
| Coins | an exact coin type, or ticker and name text | `coin_type`, `ticker` (equal to the query), `name` (equal), `words` (every query word starts a word of the ticker or name) |
| Theses | public, current theses whose text has every query word as a word prefix (launchpad-social `searchTheses`) | `words` |
| Profiles | nothing yet: no profile source exists, so the group is always Unavailable (`no-source`) | none |

Only an explicit `0x` makes hex an identifier, so a word such as `face`
stays text. An address is canonicalized (`0xA1` is `0x00…a1`). A coin type
is `0x<address>::<module>::<Name>` without type arguments. Text compares in
its search form: NFKC, lower case, single spaces (`normalizeSearchText`).

A linked-X group appears only once an authoritative mapping from a launch or
creator to an X identity exists. None does, so there is no X group. X posts
are never searched.

## Order and exact-first

- Groups come in a fixed order: On-chain IDs, Wallets, Coins, Theses,
  Profiles. The identifier groups apply only to a `0x` address, so an exact
  launch ID, pool ID or wallet always leads the text groups. Inside Coins,
  an exact coin type is tier 0, ahead of every text tier.
- Inside a group, rows are ordered by tier, then newest launch (the curve's
  creation time), then launch ID bytewise. Theses go newest first post
  first, then thesis ID, as a launch's own thesis list does: a revision
  keeps its post's place. A thesis row shows its first-post time, and its
  revision time when it was revised.
- Each row names its match (`Exact launch ID`, `Exact Cetus pool ID`,
  `Ticker match`, …). It also shows the ticker, name, lifecycle, short
  launch ID, creator and creation time, so duplicate names and tickers stay
  apart.

## Pages

Each group has its own page token (the T-003 envelope). It is bound to the
group and the query by a hash, so a token of another group or query is a
400. A launch group's key is its tier and creation time, with the launch ID
as tie-break. A thesis key is the first-post time in microseconds, with the
thesis ID as tie-break. A page resumes strictly after the last row, so rows
with equal tiers and times are never repeated or skipped.

A theses page skips posts of launches the chain views no longer list (a
replay) and reads a bounded number of posts ([social](social.md#public-reads)),
so it may hold no row and still a token. Such a page is served `available`
with no items and its token, never `empty`; the surface says "No theses found
yet; more remain to search.", keeps Show more, and does not claim that
nothing matches.

Tokens are not signed, so every decoded value is checked before any read:
a tier the group has, a creation time of 0 or more and a launch ID
tie-break; for theses a key within PostgreSQL's `bigint` and a UUID
tie-break. Anything else is a 400 `LAUNCHPAD_CURSOR_INVALID`, never a
database error, a 503 or an error metric.

## `GET /api/launchpad/search`

| Parameter | Use |
| --- | --- |
| `q` | required, at most 200 characters, at least one letter or digit |
| `group` | `onchain`, `wallets`, `coins` or `theses`: one page of that group only |
| `cursor` | that group's page token; needs `group` |
| `limit` | matches per group, default 5, at most 25 (clamped) |

The answer is `{ groups: [{ group, section }] }`. Each section is a T-003
section (`available`, `stale`, `empty` or `unavailable`) with its provenance.
A launch group's data is `{ items: [{ match, launch, pool }], nextCursor }`.
A thesis group's data is `{ items: [{ match: "words", thesis, launch }], nextCursor }`.
`launch` is `{ launchId, coinType, name, symbol, iconUrl, lifecycle, creator, createdAtMs }`.
A thesis is `{ id, thesisId, kind, stance, body, authorLabels, postedAt, createdAt }`.
It never carries the author's identity or a wallet.

- Each group degrades alone. A source that lags is Stale or Unavailable by
  the `search` policy. A source that fails is Unavailable (`error`, logged
  as the `launchpad.search` metric) while the other groups answer.
- When every group is Unavailable, the status is 503 with `Retry-After`, and
  the body still names each group's state. Without `DATABASE_REPLICA_URL`
  every group is Unavailable (`unconfigured`).
- A malformed request is a 400 before any read: `LAUNCHPAD_QUERY_INVALID`
  (query, unknown or repeated key, unknown group, a token without its
  group, a group the query cannot match) or `LAUNCHPAD_CURSOR_INVALID`
  (token, limit). The 400 never echoes the query.
- The answer holds social records, so it is `private, no-store`.

## The surface

- Typing searches after a 250 ms pause. Enter searches at once, and again
  for the same text, so an unavailable group can be retried. A newer search
  cancels an older one, and an older answer is dropped.
- Escape closes Search and keeps the text for next time. Focus returns to
  the control that opened it. When `/` opened Search with nothing focused,
  focus goes to the trigger.
- The status line under the field is the only live region. It says how
  many matches came back in how many groups, and which groups are
  unavailable.
- **Show more** loads a group's next page and moves focus to its first new
  row, unless the user has moved focus meanwhile. If that page fails, the
  shown rows keep their own state, a note beside Show more says why, and
  focus stays on the button; a page that then loads clears the note. A
  refused page ends the group's paging. While a newer search runs, Show
  more waits (`aria-disabled`), and a page that belongs to an older query is
  dropped.
- **Try again** keeps focus in the search field.
- When nothing matches, the surface says which groups found nothing and
  offers **Clear search** and **Launch a coin**. A Stale group with no rows
  counts as having found nothing, and keeps its Stale note. An unavailable
  group stays visible and is never counted as empty.
- Choosing a row closes Search and opens the coin.

## Limits

- Coin text matching evaluates the ticker and name of every listed coin
  (`normalize` and `to_tsvector` per row): the views carry no text index.
  An exact coin type is in the same statement, so it pays the same scan.
  A pool ID scans `pools`, because the view computes `pool_id` from
  `pool_key`. Only a launch ID (the `pools` primary key) and a creator (the
  `coins_creator` index) are index lookups. Review measured about 515 ms
  for Coins at 50,000 launches on a loaded host. Follow-up for blast-infra:
  publish an indexed search column (normalized ticker and name, and the pool
  ID) in a `chain_read_v1` view once launches pass about 20,000 or the
  search p95 passes 300 ms. The statement timeout bounds the worst case as
  Unavailable (`error`).
- Lower-casing of non-ASCII ticker and name text follows the database's
  `lower()`, like thesis search.
- A coin's package ID alone and a thesis's disclosed wallet are not search
  keys.
