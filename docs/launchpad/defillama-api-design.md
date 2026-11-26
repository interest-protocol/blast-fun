# DefiLlama reporting API

This runbook covers the daily metrics and contract discovery publication
pipeline. Production metrics need a verified backfill. The current-state TVL
adapter has a separate
[upstream TVL PR](https://github.com/DefiLlama/DefiLlama-Adapters/pull/22078).
The verified upstream requirements, pinned source revisions and accounting evidence are in
[the research report](../research/2026-10-23-defillama-requirements.md).
The resolved migration and vault attribution is documented in the
[follow-up research](../research/2026-10-23-defillama-migration-vault-attribution.md).
The expanded feed uses methodology `blast-defi-v4`. Backfill it from the verified
deployment floor before switching consumers to the new feed.

## HTTP contract

These GET/HEAD reads are public on `https://www.blast.fun`. The web app
relays them to the backend API through its signed gateway. Anonymous requests
have a limit of 120 reads per minute per IP and 300 across all callers, shared
by the reporting endpoints and subject to the backend's shared read budget.
Responses include wildcard CORS and private/no-store headers. OPTIONS
returns the supported methods. Existing partner keys can still use the
authenticated path with its partner quotas.

| Endpoint | Required query | Response |
| --- | --- | --- |
| `/api/v1/defillama/metadata` | None | Identity, accounting scope, coverage ranges, discovery bounds, endpoint paths |
| `/api/v1/defillama/fees` | `date=YYYY-MM-DD` | One stored daily fee and revenue summary |
| `/api/v1/defillama/fees` | `start_timestamp=SECONDS&end_timestamp=SECONDS` | Stored fee summaries for one or more completed UTC hours |
| `/api/v1/defillama/metrics` | `date=YYYY-MM-DD` | One completed UTC day's token amounts and coverage |
| `/api/v1/defillama/contracts` | `timestamp=UNIX_SECONDS` | Contracts created at/before the historical timestamp, from a verified complete cut |

Metrics and contracts accept an optional opaque `cursor`. Pages contain at most
100 `items`; follow `next_cursor` until null. Cursors bind the selector and the
immutable snapshot, so corrections cannot change an ongoing pagination session.
Snapshots remain available after correction. The page size is fixed. Duplicate,
unknown and malformed parameters are rejected. Timestamps are whole Unix
seconds; creation facts retain millisecond precision and filter at exactly that
second, not the end of that second.

The fee summary contains `date`, `snapshot_id`, `revision`, `dailyFees`,
`dailyRevenue`, and `dailySupplySideRevenue`. Each metric maps fee sources to
chain-qualified Sui coin types and raw amounts as strings. A `null` amount is
unknown, never zero. Gross `dailyFees` are always published. A positive
protocol fee from a partnered launch makes `dailyRevenue` and
`dailySupplySideRevenue` `null` for that whole source and token row, because
the partner share is set only at claim time. No estimate is published. No key or cursor
is required. A complete day without any fees returns empty maps. A date
without a complete fee summary returns 404. The worker saves the summary
atomically with the audit snapshot.

The timestamp form uses inclusive start and exclusive end in Unix seconds. Both
must fall on UTC hour boundaries and the range is limited to 24 hours. It
returns the same three fee maps for the exact window and echoes its timestamps.
The worker verifies and stores each hour separately using the daily accounting
rules. A scheduled run that cannot summarize an hour logs
`skipped hour <iso>: <reason>`, publishes the later hours and retries the
skipped one on its next run. The API returns 404 if any hour is missing and 409 if the window is still
open. Verified zero hours return empty maps.

Every metrics or contracts page includes `schema_version: 1`, `chain: "sui"`, `network: "mainnet"`,
deployment fingerprint, methodology and policy versions, snapshot ID, revision,
publication time, and checkpoint digest/number/time plus history floor. Metrics
also include UTC interval bounds, date, metric-level coverage, and
`scope_coverage` for `launchpad`, `frontend_router` and `vault_yield`.
`frontend_fee_policy` pins the applicable receiver and package ranges to the
snapshot. Metadata includes the latest completed publication date and the
supported cadence. The interval
is `[00:00 UTC, next 00:00 UTC)`; the current day is never final. Contract reads
require a published cut strictly after the requested second. Discovery does not
report a self-valued TVL total or imply the current object state is historical.

| Status | Meaning |
| --- | --- |
| 200 | A fully published snapshot exists; inspect each metric's coverage |
| 400 | Missing/invalid date, timestamp, parameters or cursor |
| 401 | Supplied partner key is invalid |
| 404 | Unknown route or no publication/snapshot covering the selector |
| 409 | Requested UTC day is unfinished or timestamp is in the future |
| 429 | Existing partner or endpoint quota exceeded |
| 503 | Authentication/reporting dependency unavailable; retry as indicated |

An empty `items` array with `complete` coverage proves zero for that published
scope. A missing snapshot is never zero. Coverage is `complete`, `unavailable`
or `not_applicable`; an unavailable metric has a stable reason. Metadata groups
only consecutive fully published dates into ranges and preserves gaps. Revisions
and ranges are isolated by the complete deployment profile and methodology, not
just the network. A policy change needs its own backfill before reads become
available under that profile.

Each metric item contains:

```ts
{
  component: string,
  coin_type: string,                  // normalized unprefixed Move type
  included_in_totals: boolean,
  underlying_venue_overlap: boolean,  // collected vault yield overlaps its DEX
  accounting_basis: "execution" | "payment" | "collection",
  metrics: {
    volume: string | null,
    fees: string | null,
    supply_side_revenue: string | null,
    revenue: string | null,
    protocol_revenue: string | null,
    holders_revenue: string | null
  },
  evidence: Record<string, string>
}
```

All amounts are **atomic decimal strings**, including values above `2^53`.
There is no floating-point amount conversion, price assumption or server-side
USD valuation. Coin decimals are not needed to pass raw atoms to DefiLlama.
Evidence-only items have all metric values null. Evidence may include protocol
accrual, creator allocation, net treasury payout, partner payout, minted
allocation, or a vault's gross/recipient/holder collection split. These evidence
fields are not additive fee metrics.

## Accounting and attribution

The published fee scope is **curve execution fees, launch creation payments,
quote graduation fees, actual presale raise-fee payments, Blast frontend
routing payments, and collected LP yield from the unified vaults**.
Vault yield has collection basis and underlying DEX overlap. Report it
as a separate yield product. Token issuance, LP residual principal and later settlements remain
visible as evidence and are deliberately excluded from economic fee totals.

| Component | Recognition and attribution |
| --- | --- |
| `curve_swaps` | Native `Bought`/`Sold` fee deltas at execution; protocol plus creator shares are gross fees. Volume counts one fee-inclusive quote leg per swap. A buy uses `quote_in` after refunds. A sell uses `quote_out_gross` before quote fees are deducted. [DefiLlama volume definition](https://docs.llama.fi/analysts/data-definitions#volume-dexs). Count a pot's `Bought` once; opening settlements/deliveries add no volume. |
| `creation` | `LaunchCreated.creation_fee` proves the actual creation payment in SUI. Its later withdrawal is not another fee. |
| `presale_raise` | `ProtocolFeesPaid.quote_amount` is net Blast; `partner_quote_amount` is the partner's separate supply-side share. Gross fees are their sum. Raised principal, refunds and token delivery are not trading volume or fees. |
| `frontend_router_fees` | Actual output-token payments to reviewed Blast receivers. Cetus uses the on-chain overlay amount and event position. Aftermath uses the executed split from the final DAO route output and the immediately following transfer. The full payment is Blast fees, revenue and protocol revenue. Provider amounts are exposed as `cetus_paid` and `aftermath_paid` for the breakdown. |
| `curve_settlements` | Actual treasury and partner payouts. They may settle multiple days and creation/swap/migration components together, so they never add fees or repair execution-day attribution. |
| `migration` | Include `ProtocolFeesAccrued.quote_amount` once as a graduation fee, split from the actual quote reserve into the fee ledger at migration. This is separate from LP principal and prior swap fees. |
| `migration_minted_allocations`, `presale_minted_allocations` | Initial token-issuance allocations, with no new user payment. Evidence only, excluded from economic fee totals. |
| `vault_collections` | Gross collected LP yield is fees. Blast's protocol cut and the route amounts reconcile to gross for each asset. Owner balances, auto-LP, holder rewards, burn, and address routes follow the fee split active at collection. |
| `migration_residuals` | The venue's unspent LP funding recorded by `VaultCreated` is principal. |
| `vault_owner_withdrawals` | `OwnerBalancesClaimed` includes accrued owner fees and any owner residuals. |
| `vault_settlements` | Core `ProtocolFeesPaid` records net Blast and partner payments from the vault ledger. These payments settle accrued amounts. |

For fully attributed included fees/yield, `fees = supply_side_revenue + revenue`.
Creators and partners are supply-side. A curve's mutable partner share is
applied at **claim time**, after accrual, so neither today's terms nor a later
mixed claim can identify each execution day's net retained amount. Any positive
partnered protocol accrual, including graduation fees, leaves that item's supply-side/revenue/protocol
revenue null and the day's dependent coverage unavailable with
`mutable_deferred_partner_allocation`. Gross fees and volume remain usable.
Known creator accrual remains in evidence; no unknown allocation is coerced to
zero. A partnered vault holds its protocol cut for a later payment under the
partner's applied terms. A positive held cut makes the collection's dependent
metrics unavailable. Gross yield and the applied route amounts remain visible.

Vault gross income is recognized on its collection date. The `vault_collections`
items expose `underlying_venue_overlap: true`. The Volo Sui yield adapter supplies a direct
gross-yield/charged-revenue precedent; the reporting decision is Blast's policy,
not upstream project approval. Separate the vault yield contribution from the
launchpad adapter and use upstream `doublecounted: true` treatment when it
overlaps the underlying DEX. Do not publish gross yield as an additional
performance charge or count auto-LP reinvestment, creator/reward claims, or
later buyback burns a second time.

No Blast governance holder mechanism is verified, so `holders_revenue` is
not applicable. DefiLlama does not universally require
`revenue = protocol_revenue + holders_revenue`; holders revenue is also an
off-statement measure. Launched-coin holders are a different recipient class.

Graduated Cetus/Bluefin/Aftermath turnover is attributed to its execution venue
and contributes no Blast curve volume. A future Blast routed-volume series
would belong on the aggregator dashboard. The frontend fee component covers
the separately charged overlay or output split, excluding any venue, referral
or DAO fee. The profile's excluded meme packages apply to native launchpad and
vault discovery, fees, volume and evidence. Frontend attribution follows the
reviewed receiver and router history.

## TVL discovery

Contract items contain `object_id`, `kind` (`curve`, `presale`, `vault`),
`meme_type`, `quote_type`, `created_timestamp_ms` and a `tvl` instruction.
Curve/presale items point an adapter to historical user quote custody; vaults
are flagged `requires_attribution_review`. Use historical Sui object reads at
the requested checkpoint/time to compute actual attributable custody. Exclude
virtual reserves, unissued/own token inventory, fee ledgers, treasury/gas funds
and other protocol-owned balances. The current-state adapter includes direct
quote custody in curves, opening rounds and presales, including refundable
quote until paid. Canonical vaults hold position objects. Cetus, Bluefin and
Aftermath hold the underlying reserves and account for them in their adapters.
Vault migration residuals and balances awaiting fee distribution are excluded.

## Publication and deployment

HTTP reads touch only a dedicated reporting database. They never scan raw
history, decode receipts, access the chain primary, call RPC or trigger a
backfill on a miss. Reader connections are read-only, max two per process, with
1s statement/1.5s client timeouts. Queries return at most 101 rows for page
lookahead. Metadata bounds history to 10,000 published dates and fails closed
beyond that bound.

Daily publications also store the [partner launchpad stats](../security/partner-read-api.md#daily-launchpad-stats)
in their summary. The scheduled publisher revisits yesterday when its stats
are missing. To populate an earlier day after upgrading the publisher, rerun
`npm run defillama:publish -- YYYY-MM-DD` for that date. Each successful
republication creates a revision using the existing immutable reporting store.

The offline publisher reads finalized native BCS from a **physical read
replica**, enforces exact deployment identity, journal floor, successful
transactions, and the intake watermark/fault barrier inside one repeatable-read
transaction. The cut is the first committed checkpoint at/after the day's end.
It uses the pinned Blast SDK's event decoders and replays in checkpoint /
transaction-slot / event-slot order. It publishes only after complete collection
and reconciliation; ingestion lag, faults, unknown SDK events, missing launch
history or replay-limit failure leave no partial day.

The first publication replays bounded pages of 500 native receipts from the
deployment floor, with a 256 KiB per-receipt limit and a one-million-event
replay limit. Later publications load the prior accounting state from the
reporting database, verify its checkpoint digest on the replica and replay
only the checkpoint delta. State and its immutable metrics snapshot commit
together. Historical corrections insert a new revision, preserving pages
already pinned to earlier revisions.

The publisher scans the archival Sui GraphQL receiver index over the day's
checkpoint interval. It verifies the index and receipt retention bounds and
the checkpoint digest against the native replica. Each receipt must belong
to a finalized successful transaction. Aftermath transaction bytes must hash
to that transaction digest. The fee transfer must move the exact split result
from the DAO swap output or from a fee-free Cetus suffix linked to that swap.
Event and command positions distinguish payments in the same transaction.
Missing or gapped receiver policy marks frontend fees and dependent aggregate
metrics unavailable. Archive errors and truncated pages abort the publisher
so an outage cannot replace a complete revision.

### Setup

1. Apply infra migration
   [`2026-11-12-000000_defillama_source`](https://github.com/interest-protocol/blast-infra/tree/main/migrations/2026-11-12-000000_defillama_source)
   from `blast-infra` main. It adds a successful-native-
   receipt view and the NOLOGIN `blast_defillama_source` role. Grant that role to
   a dedicated source login, then use the physical replica URL for the collector.
   Existing native evidence/coverage migrations must already be present.
2. Create a **separate reporting database** and apply
   [`schema.sql`](../../packages/core/src/modules/defillama/schema.sql) with its
   migration owner. Grant `blast_defillama_publisher` to a collector login and
   `blast_defillama_reader` to a separate read login. Neither role can update or
   delete snapshots; only the publisher can insert. Do not apply this schema
   through the web app's normal `db:migrate` or expose reporting-owner credentials.
   If the reporting database already has the v3 schema, apply the
   `defillama.native_replay` table and grant at the end of that file as its owner
   before starting the v4 publisher.
3. Define the same `DEFILLAMA_PROFILE` JSON for the publisher and native API:

   ```json
   {
     "network": "mainnet",
     "deployment_fingerprint": "<64 lowercase hex from the reviewed deployment>",
     "launchpad_original_package": "<0x plus 64 lowercase hex>",
     "presale_original_package": "<0x plus 64 lowercase hex>",
     "vault_original_package": "<0x plus 64 lowercase hex>",
     "core_original_package": "<0x plus 64 lowercase hex>",
     "admin_original_package": "<0x plus 64 lowercase hex>",
     "first_checkpoint": "<verified deployment history floor as decimal string>",
     "excluded_meme_packages": [],
     "policy_version": "release-v1"
   }
   ```

   These are placeholders, not deployable identities. Verify the checkpoint is
   at/before **every configured original package's publication checkpoint**,
   using release records and chain evidence, and at/before midnight UTC of the
   first day to publish. The replica must retain every native receipt from that
   checkpoint onward. Changing `first_checkpoint` to today's watermark is
   not a valid backfill. No date, package ID or historical completeness is
   inferred from a current object or current policy.
   The original package IDs must match the SDK's published deployment. When
   an SDK update changes the fingerprint for the same lineage, keep the
   published `DEFILLAMA_PROFILE` to retain the feed and snapshot history.
   Set `BLAST_NETWORK` and `BLAST_DEPLOYMENT_FINGERPRINT` to the current SDK
   deployment on the native API and publisher. The publisher verifies each
   source cut against that deployment.
   The November 6 [canonical publication](https://github.com/interest-protocol/blast-v2-contracts/blob/main/deployments/sui/mainnet/2026-11-06-canonical-launch-stack.json)
   began at checkpoint `342354025`. The earliest full UTC day for that
   deployment is `2026-11-07`, provided the replica has complete history from
   that checkpoint. Track production replay evidence in
   [blast-infra#69](https://github.com/interest-protocol/blast-infra/issues/69).
   The feed identity includes this complete profile.
4. On the collector only, set `DEFILLAMA_SOURCE_DATABASE_URL`,
   `DEFILLAMA_WRITE_DATABASE_URL`, and `DEFILLAMA_SUI_ARCHIVE_GRAPHQL_URL`.
   Supply `DEFILLAMA_FRONTEND_FEE_HISTORY` as a JSON array of ordered,
   non-overlapping checkpoint ranges. Each entry has numeric
   `first_checkpoint` and `end_checkpoint_exclusive`, plus `receivers`,
   `cetus_packages`, and `aftermath_package` (the reviewed DAO wrapper or null
   when disabled). Use an empty receiver list only for a verified fee-disabled
   interval. Establish Blast control and fee retention from release evidence
   for every listed receiver. Record package activations and receiver rotations
   at their actual checkpoints. The current trading configuration cannot fill
   missing history. From `apps/web`, run
   `npm run defillama:publish -- YYYY-MM-DD` for each completed day. Publication
   requires a complete frontend policy and archive coverage for that day.
   Use `npm run defillama:publish -- --hours YYYY-MM-DD` to publish or reconcile
   a day's 24 hours from the same verified checkpoint floor. Compare the 24-hour
   range with the daily summary before switching the upstream adapter. Run
   `npm run defillama:publish -- --scheduled` at minute 15 every hour. It fills
   missing hours in the last 24 completed hours and ensures the prior daily
   summary exists.
   Enable the production schedule only after verified backfill and provisioning.
   Retrying identical evidence is idempotent. Changed evidence
   inserts a new atomic revision; old pages remain readable. Run the collector
   under the shared host's heavy-job memory guard.
5. On `blast-backend-api` set `DEFILLAMA_READ_DATABASE_URL` and the profile.
   Reuse normal partner-key provisioning. Where the API and hints share a
   reviewed `BLAST_BACKEND_FLEET_CONFIG`, set `api.defillama` to `true` and
   budget two reporting connections per API replica against the reporting,
   primary and replica ceilings. See the
   [fleet capacity contract](../architecture/latency-and-capacity.md).
   The web and hints processes do not need the reporting URL or profile.
   Keep source and publisher credentials on the collector.

## DeFiLlama submissions and adapter contract

[TVL PR #22078](https://github.com/DefiLlama/DefiLlama-Adapters/pull/22078/changes)
uses direct Sui object reads for current custody. The separate
[dimensions repository](https://github.com/DefiLlama/dimension-adapters)
consumes fees, revenue and volume. The reporting API is the backend data
source for these dimensions because it can reconcile indexed contract and
router receipts once per publication. The read endpoint serves the resulting
immutable snapshot.

| DeFiLlama field | Blast source |
| --- | --- |
| `dailyFees` | Sum gross included payments and accruals for the chosen scope, by token. Launchpad and frontend charges can be combined when both scopes are complete. |
| `dailyUserFees` | Optional user-paid subset. Native launchpad charges and paid frontend overlays and splits belong here. Vault LP yield is a separate source. |
| `dailySupplySideRevenue` | Known creator, partner and vault route allocations for the chosen scope. |
| `dailyRevenue` | Gross fees less supply-side distributions for the same period and scope. `null` for a coin whose partner share is still unknown; never treat it as zero. |
| `dailyProtocolRevenue` | Verified retained Blast share, including the settled frontend charges. |
| `dailyHoldersRevenue` | Omit while a Blast governance-holder distribution mechanism is unverified. |
| `dailyVolume` | Native curve trading, one quote side per fill. Venue trading stays with the DEX and any separate Blast routed volume belongs in the aggregator dashboard. |
| Vault yield | Use its own yield scope and review upstream overlap treatment for the underlying venue. |

Use a version 1 dimensions adapter with `fetch(options)`,
`options.dateString` and the Sui chain. DeFiLlama accepts one UTC-day aggregate
per call at this version. Hourly version 2 pulls require real interval-level
aggregation keyed by the requested start and end timestamps. The latest
published UTC day is a 24-hour bucket. It may differ from a live rolling
24-hour view. The adapter returns token balance objects via
`options.createBalances()` and passes the stored, chain-qualified balances to
`addBalances`. The publisher normalizes the native SUI alias. Define a
descriptive label for each fee source and destination and document it in
`breakdownMethodology`. Use the existing fetch helper with the public Blast
reporting URL. See the
[dimensions guide](https://docs.llama.fi/list-your-project/other-dashboards)
and [TVL criteria](https://docs.llama.fi/list-your-project/what-to-include-as-tvl).

Fetch `/fees` once for the date. The worker requires complete launchpad and
frontend fee coverage and omits evidence-only rows and overlapping DEX
fees, including vault LP yield. It splits frontend revenue between the
amounts actually paid to Blast on Cetus and Aftermath. Republish existing
covered days with the updated worker before switching the adapter.
Choose the adapter start from the earliest reconciled full day, test a
historical day with `npm test fees <slug> YYYY-MM-DD` in the dimensions repo,
and verify a nonzero finalized Blast receipt for each frontend route before
upstream submission. Confirm both TVL custody and the nonzero fee sample on
Sui mainnet for release.


## Verification

For a completed day, the read-only reconciliation command compares the stored
provider totals against independently inspected public receipts and the existing
bounded receiver-index scan. Prepare one JSON file containing:

- `date` and the day's first checkpoint at or after 00:00 UTC as
  `first_checkpoint`;
- `policy_evidence` and `receipt_evidence`, descriptions or links to the
  reviewed receiver/package history and the independent receipt inspection;
- `publication`, the entire first `/metrics?date=YYYY-MM-DD` response, and
  `fees`, the `/fees?date=YYYY-MM-DD` response for the **same snapshot**;
- `expected_receipts`, a list independently transcribed from the public chain,
  with `id` (`<digest>:event:<position>` for Cetus or
  `<digest>:command:<transfer position>` for Aftermath), `venue`, output `coin`
  type and positive raw `amount` as a decimal string. Inspect successful
  finalized effects, the actual Cetus overlay event or Aftermath split and
  following transfer, and enumerate each applicable receiver and package
  window. Do not derive these expected values from the collector's output.

Run from the repository root with an archive endpoint that retains the interval:

```sh
DEFILLAMA_SUI_ARCHIVE_GRAPHQL_URL='<archive endpoint>' \
  node --no-warnings --experimental-strip-types \
  apps/web/scripts/defillama-reconcile.ts /path/to/reconciliation.json
```

The command checks the preceding and first checkpoint timestamps at each UTC
boundary, the published cut digest, the collector's policy and archive coverage,
receipt positions and exact provider/token fee and revenue totals. It rejects
missing or conflicting data. The evidence descriptions are operator assertions:
matching them does not prove receiver ownership or that the independently
inspected list is complete. Retain the public receipt and policy evidence and
review those facts separately. A zero-fee day does not satisfy the nonzero
release condition, and each supported frontend route still needs a real
nonzero finalized Blast receipt before upstream submission.

Use the two intake and reporting migrations from `blast-infra` main.
The PostgreSQL integration test creates task-owned loopback primary and
physical-replica clusters. It checks role isolation, exact native amounts,
pagination, coverage, and byte-independent snapshot identity when resuming a
prior day. Frontend fixtures cover success, failure, duplicate pages, both
gas payment modes, and a Cetus suffix on an Aftermath route.

```bash
node --no-warnings --experimental-strip-types --test --test-concurrency=1 \
  packages/core/src/modules/defillama/{accounting,frontend-fees,reads}.test.ts
DEFILLAMA_INFRA_CHECKOUT=/absolute/path/to/blast-infra \
  npm run test:defillama-infra -w @blast/core
```

`PG_BIN` defaults to `/usr/lib/postgresql/16/bin`. The PostgreSQL test
(`reporting.external.test.ts`) runs only through `test:defillama-infra`, which
fails without an explicit infra checkout path.
