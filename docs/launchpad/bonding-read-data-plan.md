# Complete bonding discovery and fee disclosures

Status: implemented and locally verified; release pending, 2026-10-29. Architecture and final backend diff reviewed with Astra at high reasoning.
This extends the create/list/coin-page work in PR #659; it does not authorize a
hosted deployment or an on-chain transaction.

Source checkpoint: blast-v2 `497d72b`, blast-infra `origin/main` `7e7796f`.
Implementation checkouts: `claude/bonding-curve-create` in blast-v2 and
`codex/bonding-read-data` in an owned blast-infra worktree.
Companion infra PR: https://github.com/interest-protocol/blast-infra/pull/105.

## Outcomes

Complete the three remaining read gaps:

1. Bonding cards show authoritative holder counts, USD market cap and a defined
   24-hour price change when their inputs are available.
2. The closest-to-graduation launch has its published cover and tagline.
3. The permanent coin page discloses the current curve protocol share and the
   coin's effective quote/meme LP protocol shares, including coin overrides.

Opening-round creation and partner creation remain outside this work.

## Responsibilities and invariants

- Rust owns indexed market facts, policy projections and exact market arithmetic.
  Both hot-memory and committed-reader answers use the same rendering rules.
- Bun owns published off-chain details and composition. Next.js remains a thin
  signed adapter; the browser formats values without deriving market economics.
- Preserve the existing discovery eligibility, order, tie-breaks and cursor bytes.
  Presentation never filters or reranks a launch.
- Read market data at its original committed checkpoint. Published details have
  their own source state; a social read does not acquire chain provenance.
- Unknown values stay null/unavailable. A genuine zero remains distinguishable.
  TEST_SUI does not acquire a SUI/USD price by assumption.
- Optional enrichment failures leave the core discovery or coin read usable.
  Display policy never authorizes a transaction; signing retains SDK preflight.
- Extend the existing admission, cache and read-routing owners. No new service,
  scheduler, cache system, browser-to-infra access or per-card fullnode request.

## Published presentation: existing holders and published presentation

`blast-infra/src/registry/mod.rs::pool_summary` already returns holders. Expose
that field through `launchpad-contract/discovery.ts`, the server discovery
projection and the strict browser row parser. Account for wallet launches, which
shares `discoveryRow`. This requires no new ingestion or holder query.

Reuse `packages/server/src/modules/social/launch/details.ts` for the public
projection of published details. The hero needs one canonical launch ID and one
indexed `published_launch_id` lookup. Return only validated cover/tagline and the
public links already needed by the coin read. Never return the draft body,
account identity, publication state or private upload state. A malformed draft
removes its decoration without invalidating discovery. A future page needing
multiple covers must use one bounded batch lookup; do not build that unused
interface for the single-hero requirement.

Migration **0148** already supplies the partial unique
`social_launch_drafts_published_idx`. No Blast database migration is expected for
this read. Reuse the same projection for the permanent coin page.

Keep published presentation separate from the market-only discovery response and
its partner contract. Serve a signed first-party details GET through the existing
backend admission and adapter machinery, with `private, no-store`. The record is
a public projection; that does not make its transport a publicly cached market
response. Do not label a mixed response `chain-derived` or broaden social caching.

The featured launch is the first existing `near_graduation` result, including
when it has no cover. Reuse that page when already loaded; otherwise read
`near_graduation&limit=1`. A missing cover uses the approved empty presentation;
it never selects a different launch. Metadata failure affects decoration only.
Fetch details when the hero ID changes, using the existing query cache; do not
make every market polling tick repeat an unchanged published-details read.

## Market data: coin market facts in discovery

Extend the existing infra summary path with a small optional coin-market
projection. Preserve the historical curve summary and its ranking inputs, while
sourcing current valuation from the coin's **current pool**. After graduation,
that is the current venue pool rather than the curve's final reserve state.

Compute USD cap using the existing exact infra arithmetic and the current pool's
quote decimals and valid USD stamp. Preserve decimal strings across transport;
missing pricing inputs yield null. Do not infer USD from the quote's symbol or
use the preview-only TEST_SUI price proxy.

Use USD price change for the neighboring 24-hour figure. Its contract must include
the committed interval end, baseline observation time and nullable signed change.
The baseline is a valid observation at or before `end - 24h`, with an explicit
maximum age. A one-hour baseline search window matches the existing bounded Home
probe pattern; confirm its behavior with fixtures before freezing the contract.
Missing history, a zero denominator or a launch younger than the interval yields
null rather than an inception return labeled as 24 hours.

First verify that existing price/trade/candle inputs can establish the historical
pool state and quote USD stamp across curve-to-venue migration. A historical USD
change needs the historical quote price; applying today's quote price to both
ends gives a different measure. Add a replayable indexed projection only where
the existing sources cannot supply the required facts. Do not download candles
or scan a day's trades to render a card.

`social/home/coins.ts` is a useful example of batch baseline probes, but its source
universe covers presales and standalone migrated vaults, and its display reads
can enable a TEST_SUI preview proxy. Do not reuse that repository as the bonding
market source. Activity windows in `src/stats/mod.rs` contain volumes and counts,
not price changes.

Preserve `src/committed_reads/pools.rs`'s **one statement per page**, its
`limit + 1` candidate selection and hydration of visible coins. Add indexed
baseline/current-pool probes inside that snapshot and reuse shared renderers.
The hot-memory path must produce the same values at the same committed cut.
There must be no per-card `/v1/coins` fan-out or TypeScript market SQL.

## Current policy: effective current fee policy

Reuse the indexed curve `protocol_fee_share_bps` from
`src/launchpad_policy/{mod,routes,store}.rs`. Add effective current fee policy to
the coin summary in the same committed snapshot, rather than requesting global
policy separately for every page refresh.

LP shares require ingestion work. The migrators decoder already recognizes
`LpFeePolicyChanged`; `launch_reward_inputs` currently records policy creation
and destination changes while discarding the decoded default pair. Extend the
existing projection ownership to preserve:

- Typed policy identity and its eventless initial default pair.
- Atomic default-pair changes.
- Per-original-Meme-type overrides, their changes and removal.
- Native source cursor/time and completeness sufficient to prove absence.

Resolve the coin override first, then current defaults only when override absence
is authoritative. Incomplete history is unknown. Do not infer current percentages
from accrued fees, and do not return the entire unbounded override map. Index and
read only the requested policy/coin keys. Retried commits, replay and bootstrap
must agree before enriched fields become ready.

The optional coin fee-policy projection carries the effective meme/quote BPS,
default/override source, policy identity and applicable source observations.
Keep the curve policy observation distinct when it changed at a different native
position. Parse present fields strictly and isolate malformed optional policy
from the coin's core read.

Label these as current shares as of the indexed observation. Distinguish trade
fee rates, the protocol's share of those fees, and the creator-selected split of
remaining LP fees. Creation's `social/launch/rules.ts` reads LP defaults and cannot
answer an existing coin's override. Signing continues to use fresh SDK reads.

## Compatibility, evidence and delivery

Implement each follow-up as a scoped, reviewable change. Update the data-gap
ledger, including its stale 0146 reference. Deploy the new backend route and
tolerant parsers first, then tolerant frontend consumers, before infra starts
emitting enriched fields. Test older browser/backend payloads and existing
partner/wallet consumers. Check strict parsers explicitly; additive JSON alone
does not establish compatibility. Use an explicit response contract revision if
coexisting strict consumers require one.

Preserve the effective discovery policies: first-party `cache-policy.ts` currently
uses 10 seconds of edge freshness and 30 seconds of stale revalidation, subject to
team no-store; partner `v1/route.ts` overrides its response to no-store. The
architecture prose's 20-second stale interval does not match that implementation.
Do not silently change these policies or existing polling during enrichment.

Verification must cover:

- Exact/null/zero values; unpriced TEST_SUI; missing or stale USD stamps; missing
  baselines; large amounts; graduation inside the 24-hour interval.
- Identical discovery order and cursor bytes with and without enrichment.
- Published-only metadata, malformed-row isolation and DB failure.
- Policy initialization, override/default/removal, source completeness, restart,
  retry/replay and fixed-cut writer/committed-reader equality.
- Query plans and call counts at page sizes 1, 25 and 100 against a larger
  background dataset: one discovery statement, one indexed details lookup when
  the hero needs loading, and probes bounded by visible coins. Record timings and
  rows read; these local checks do not prove hosted capacity.
- Backend/web typechecks and focused tests under the host memory guard, with
  disposable loopback PostgreSQL only. Apply and repeat any required infra
  migrations locally. Run the applicable broader architecture checks.
- Approved Blast UI at 320, 407, 768, 1054 and 1414 px in light/dark, including
  absent data and failed enrichment; independent Astra review of the final diff.

Release compatible consumers first, then any infra schema/projection changes
with replay/reconciliation and writer/reader parity, then enable enriched output.
Deploy the backend before the consuming frontend. The main feature still needs
migration 0148 before its backend release. Existing hosted ownership, team gates
and the Actions billing restriction remain in force; this plan changes none of
them. Preserve effective route freshness/admission policies; do not silently
change them as part of data enrichment.

## Implemented continuity and release gates

Infra migration `2026-11-26-000000_coin_display` adds private price closes, LP
policy/override state, and per-component checkpoint coverage. Only the committed
reader role receives the three reader views. Each view requires its component
marker to equal the market watermark. An older writer advancing without this
projection therefore hides stale optional facts immediately. Bootstrap also
checks the marker: a mismatch starts empty, then clears old rows and writes the
new component marker atomically with the next market checkpoint. It never
relabels an old projection as continuous.

LP completeness comes from typed policy creation or a proven empty override
input; unknown nonempty history stays partial. Default pairs and override events
are reconciled with typed before/after values and native override counts. Removed
overrides retain a tombstone and their own observation. Quiet batch clones share
policy maps; changed-key overlays avoid cloning them for each transaction. A
changed batch may still copy the map once under copy-on-write.

Price history retains at most roughly 302 closes per active coin, including
unpriced observations. A close is a native trade's price with its historical
quote/USD stamp; opening settlement is excluded. The last fully closed
five-minute bucket before the 24-hour cutoff must have an observation within the
preceding hour. Missing or nonpositive/stale/future USD inputs and young coins
produce null changes. Current valuation follows the current venue after
migration. Legacy dynamic rankings load optional enrichment only after selecting
the page, inside their existing snapshot.

Release tolerant backend/frontend consumers before the enriched infra producer.
Apply web migration 0148 before the Bun backend, then deploy Vercel. Apply the
infra migration before starting the new producer/reader. Existing LP history
needs full market replay from the migrators deployment to prove absent overrides;
without it, unknown keys remain unavailable until a native empty state proves
completeness. Price history can warm naturally over 25 hours. Do not enable USD
for TEST_SUI without an admitted feed. No hosted deployment is part of this work.

## Verified results

Server, web and backend API typechecks pass. The follow-up passes 10 focused
contract/row/UI tests, two private metadata route tests, 83 frontend transport
tests and the launch integration file against disposable loopback PostgreSQL.
Changed-file lint and five shared-pattern checks pass. React Doctor 0.9.18
reports 100/100 with no issues across all 49 changed React files against
`origin/develop`. Twenty-one captures cover both read pages at all five required
widths in both themes, plus unavailable metadata; no overflow or page errors
were found. Independent Astra UI review has no open P0–P3 findings.

Infra passes all-target typecheck, Clippy with warnings denied, 471 unit tests,
three floating-point guards and eight selected loopback database tests. These
cover migration repetition, coverage/reset, reader permissions, writer/reader
parity, replay-reset atomicity and graduation. The indexed history probe returned
one row per selected coin against 100,001 closes: page sizes 1/25/100 executed in
0.517/1.152/3.009 ms locally. This is boundedness evidence, not hosted capacity.

The updated web PR's Vercel preview build passes. GitHub Actions did not start
because of organization billing, matching issue #484. Local evidence is retained
in `outputs/verification/2026-10-29-bonding-read-data` in the workspace. Local
production build, authenticated wallet signing and real chain execution were
not exercised. Original creation/migration verification remains recorded in
PR #659.
