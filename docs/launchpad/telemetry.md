# Launchpad outcome telemetry

`apps/web/src/modules/launchpad-telemetry` is the launchpad's shared measurement
boundary. It records one denominator, a visitor's first view of a tradable
coin, and stores the verified outcomes that the buy, launch and migration
flows report, including those a browser reports and the server verifies on
the chain (`POST /api/launchpad/outcomes`). Each outcome belongs to the
wallet that sent its completed event; a visitor is linked to it only by
evidence a claimant cannot forge. It shares nothing with Mission Control
telemetry: no event names and no profile or account identifiers.

## Privacy rules

- A visitor is a first-party opaque random ID (UUID v4) in the HttpOnly
  cookie `__Host-blast_vid`, minted by the ingestion route. It is never
  derived from a wallet, Privy subject, profile or provider ID.
- **Outcome rows store the event's sender wallet.** Each outcome holds
  `sender_wallet`, the native `sender` of its completed event (the
  transaction sender), read from the chain by the server. It is public chain
  data, like the digest beside it. No client-supplied field holds a wallet.
- **A visitor is linked to a wallet only by the user's own evidence:** the
  user's own verified Privy session whose embedded Sui wallet is that sender
  (`visitor_link = 'privy_session'`), or the user's own browser's commitment
  of the transaction's digest, sent before submission and received before
  its checkpoint (`'signed_commitment'`). Nobody can claim another wallet's
  outcome by reporting it first, by reporting it from their own browser, or
  by its digest alone; without such evidence the outcome is wallet-only.
- **The outcomes and commitments tables are personal data.** A linked row
  ties a visitor (and that visitor's first views) to a wallet, and a
  commitment ties a visitor to a digest. Only the web runtime role
  (`blast_web`) reads them; no other role has a grant.
- **Aggregates and public UI never expose a link.** Aggregates return counts
  only: no visitor, coin or wallet. No route answer says whether, or to
  whom, an outcome was linked. No volume is stored, so nothing can rank by
  raw volume.
- Every other field is a canonical public chain identifier (a launch ID, a
  completed transaction's digest and event position) or a value from a
  closed list. Parsers accept exact shapes only, so a Privy subject, thesis
  text, evidence URL, signature or provider ID has nowhere to go. Wallets,
  digests, visitors, tokens and Privy subjects never appear in event names,
  metric labels or logs; rejections and metrics carry bounded reasons only.
- Records are kept for the reporting policy's retention (90 days); the
  maintenance cleanup cron deletes older ones. A commitment is deleted as
  soon as a report decides its digest's link, and one never decided after a
  short configured window (below).

## Contract

| Piece | Where | Use |
| --- | --- | --- |
| `launchpad.coin_view.v1` `{ event, launchId, surface: "coin-page" }` | `contracts.ts` | the only event the browser sends |
| `reportCoinView(launchId)` | `client.ts` (browser-safe) | call in an effect after the page shows the coin as tradable; once per page, fire-and-forget (beacon, else `fetch` with `keepalive`) |
| `POST /api/launchpad/telemetry` | `route.ts`, `app/api/launchpad/telemetry/route.ts` | 204 stored or already counted, 400 rejected or not a tradable coin now, 403 another site or `Origin`, 400 aborted body, 408 body slower than 1.5 s (see below), 413 over 1 KB, 429 client over its rate bucket, 503 limiter, tradability check or storage unavailable |
| `CompletedOutcome` `{ kind, launchId, senderWallet, visitorId, visitorLink?, completion }` | `contracts.ts` | `kind` is `buy`, `launch` or `migration`; `senderWallet` is the completed event's `sender` (canonical `0x` + 64 hex), from the chain only; `visitorLink` (`privy_session` or `signed_commitment`) is present exactly when `visitorId` is not null; `completion` is `{ status: "completed", checkpoint, txDigest, eventSeq, completedAt }` |
| `visitorIdFromRequest(request)` | `route.ts` | the opaque visitor (or null) a flow passes with its outcome |
| `createLaunchpadTelemetryEmitter(() => sink)` | `emitter.ts` | the server adapter; `admitCoinView`, `admitOutcomeReport`, `admitOutcomeCommitment`, `recordCoinView`, `recordOutcome` and `recordOutcomeCommitment` never reject and resolve within 1.5 s (`allowed`/`limited`, or `recorded`/`duplicate`, `rejected`, `dropped`) |
| `LaunchpadTelemetryService.funnel({ from, to })` | `service.ts` | per reporting period: `firstViews`, `viewers`, and per kind `completed` and `convertedViewers` |
| `LAUNCHPAD_REPORTING_POLICY` | `contracts.ts` | the one policy (one UTC day, 90 days' retention) the service, funnel, cookie and cleanup read |
| `POST /api/launchpad/outcomes` `{ kind: "launch" \| "buy", launchId, txDigest }`, optional `Authorization: Bearer <Privy access token>` | `outcomes.ts`, `app/api/launchpad/outcomes/route.ts` | anyone same-origin reports a completed launch or curve Buy; the server verifies it on the node and records it for the event's sender (below) |
| `POST /api/launchpad/outcomes/commitments` `{ kind: "launch" \| "buy", launchId, txDigest }` | `outcomes.ts`, `app/api/launchpad/outcomes/commitments/route.ts` | a browser commits a signed transaction's digest as its visitor's own just before submitting it (below) |
| `reportVerifiedOutcome({ kind, launchId, txDigest, privyToken? })` | `client.ts` (browser-safe) | call once the chain shows the completed event; fire-and-forget (`fetch`, JSON, `keepalive`, the token only as the Bearer header), once per event per page, one jittered retry after a 503 (below), never throws or waits |
| `commitSignedOutcome({ kind, launchId, txDigest })` | `client.ts` (browser-safe) | call after the wallet signed and just before submission, never awaited; fire-and-forget, once per digest per page, never retried, never throws |
| `createOutcomeVerifier(chain)` | `outcomes.ts` | the server verifier the route uses: `verified` with the event's sender and the chain's completion, `refused` or `unavailable` with a reason |

### First-view dedupe

A visitor's view of a coin is stored once per reporting period (default one
UTC day; periods are aligned to the Unix epoch): one row per period, visitor
and launch ID, `INSERT ... ON CONFLICT DO NOTHING`. Views of coins the page
does not show as tradable are never reported.

### Bounded ingestion

- Requests from another site, a sibling subdomain or a foreign `Origin` are
  refused. Bodies are capped at 1 KB and parsed exactly before anything
  touches the database; a body the client aborts is a 400.
- The handler stops reading a body after 1.5 s (408). That only guards a
  streamed body handed to the handler directly: under `next start` and on
  Vercel the platform buffers the request body before the route runs, so
  over real HTTP a slow-drip upload is bounded by the platform's own
  limits, not by this deadline.
- Each client IP has the rate bucket `launchpad_telemetry` in the shared
  registry (`lib/web-security/rate-limits.ts`): 30 beacons a minute and 300
  an hour. It is checked before a visitor ID is minted or a view recorded;
  a full bucket answers 429 and records nothing. If the limiter cannot
  answer (database down, `RATE_LIMIT_SUBJECT_PEPPER` missing) the beacon is
  dropped (503), never recorded and never blocking.
- One row per period, visitor and coin, deleted after 90 days.
- **Only tradable coins count.** After the rate bucket and before a
  visitor is minted, the route asks the coin page's own decision
  (`tradableNow` in `modules/launchpad-coin`) whether the launch is a Blast
  coin the page shows as tradable now: Live on its curve, or Migrated with a
  supported route and an answering venue pool, both from the fresh launch
  object. A launch that is unknown, foreign, in its opening round or
  migration-ready is a 400 (`reason: "not-tradable"`); one whose launch
  object cannot be read, or whose check does not finish within 1.2 s, is a
  503. Neither records anything. A launch's definite answer is reused for
  5 s. The coin page reports only when the same decision says tradable.

### Outcomes are completed chain events

Flows record an outcome only after they verified its completed on-chain
event: the executed transaction's digest, the completed event's position in
it and its native sender, the checkpoint that includes it and the
checkpoint's time. A click, a
simulation, a signature or a submitted digest has no checkpoint or event and
cannot be expressed. One completed event is one outcome; a retry is a
duplicate.

The browser records no `migration` outcome here. The public Complete
migration action reports its manual-fallback diagnostics through the site's
analytics instead (`docs/launchpad/migration.md`).

`convertedViewers` counts visitors with a first view in the period whose own
completed outcome of that kind (an outcome linked to that visitor) followed
the view within the period. Wallet-only outcomes count in `completed` only.
A flow's own numerator (for example, a buy of the same coin) is the flow's to
define.

### Verified launch and Buy outcomes

`POST /api/launchpad/outcomes` (Node runtime, `no-store`, never cached) is
the browser's only way to an outcome. The body is exactly `{ kind, launchId,
txDigest }`: `kind` is `launch` or `buy` (migrations are recorded by their own
flows), `launchId` is canonical and `txDigest` a Base58 transaction digest.
The client never sends a checkpoint, event position, time, amount or wallet.
An optional `Authorization: Bearer <Privy access token>` header can only link
the reporting visitor (below); a missing, malformed or failing token never
refuses a report. In order, and nothing is read or written before the rate
bucket:

| Step | Refusal (`{ reason }`, nothing recorded) |
| --- | --- |
| another site, sibling subdomain or foreign `Origin` | 403 `origin` |
| a body that is not `application/json` | 415 `content-type` |
| over 1 KB, slower than 1.5 s (see below), aborted or not JSON | 413 `too-large`, 408 `body-timeout`, 400 `malformed` |
| not exactly the three fields | 400 `shape`, `event` (kind), `launch-id` or `digest` |
| the client IP's `launchpad_outcome` bucket | 429 `rate-limited`; 503 `limiter-unavailable` |
| the node cannot answer now | 503 `node-unconfigured`, `wrong-network` (the node answers for another chain), `node-unavailable` (unreachable or over 2 s), `node-busy` |
| the transaction is not the completed event named | 422 `unknown-transaction`, `failed`, `not-checkpointed`, `foreign-lineage`, `other-launch`, `not-a-launch`, `not-a-buy`, `settlement-buy` |
| storage | 503 `storage-unavailable`; 422 `unrecordable` |

A report without a visitor cookie is verified and recorded like any other.
A verified report answers 201 `{ result: "recorded" }`, or 200 `{ result:
"duplicate" }` when that completed event is already recorded; the answer never
says whether or to whom the outcome is linked. Reasons are bounded labels and
never echo input; each refusal records a `launchpad.telemetry` metric with
`event: "outcome_report"`, `result`, `reason` and `kind` only.

The 1.5 s body deadline behaves as in the coin-view route ("Bounded
ingestion"): under `next dev`, `next start` and on Vercel the platform
buffers the request body before the handler runs, so over real HTTP a slow
body is bounded by the platform's own limits and `body-timeout` does not
fire; it guards only a streamed body handed to the handler directly.

**Verification.** `createOutcomeVerifier` reads the transaction by digest
(with its events) from the configured node and requires:

- the node answers for the deployment's chain identifier (checked once per
  node and process);
- execution succeeded and the transaction is in a checkpoint with a time;
- for `launch`, the configured lineage's `LaunchShared` for `launchId`; for
  `buy`, a `Bought` for `launchId` that is not the opening round's settlement
  buy (the first such when there are several). Events are decoded with the
  SDK's `decodeLaunchpadEvent` against the deployment's launchpad original
  package, so another package's look-alike is `foreign-lineage`. As in
  blast-infra's trade classification, the settlement buy is the pot's: the
  last `Bought` of the launch before its `OpeningRoundSettled` in the same
  transaction. Every other completed `Bought`, including a bidder's own buy
  after the settlement in that transaction, counts.

The event's `sender` (its envelope's native sender, the transaction sender),
`checkpoint`, `eventSeq` (the event's index in the transaction) and
`completedAt` (the checkpoint's time) come from the node. Node reads share a
2 s budget (`OUTCOME_READ_TIMEOUT_MS`) and at most 8 run at once per process
(`OUTCOME_READ_CONCURRENCY`); a report beyond them is `node-busy` at once,
never queued.
This bounded read is `createCompletedEventVerifier`; presale outcome
registration shares it ([../presale/outcomes.md](../presale/outcomes.md)).

**Attribution.** The outcome is recorded for `senderWallet`, the event's
sender, with the event's own checkpoint, time and position. One completed
event is one outcome (primary key `(tx_digest, event_seq)`): a duplicate or
competing report, in any order, from any visitor or none, never changes the
sender, checkpoint, time or position. The reporter's cookie never decides
attribution.

**Visitor link.** Evaluated on every verified report, in the transaction that
records the outcome (`LaunchpadTelemetryRepository.recordOutcome`). A digest
decides once, for every outcome of its transaction: a transaction can hold
more than one recorded outcome (a creation that includes the creator's first
buy has a `Bought` and a `LaunchShared`), and all of them have the one
sender. So a link already recorded on any outcome of the digest is the
decision for the others, with its visitor and its kind (`privy_session` or
`signed_commitment`), whoever reports them and whatever the report carries;
that visitor is already linked to the same wallet, so nothing new is
disclosed. Otherwise:

1. **Privy session.** The report carries a Privy access token that the
   identity module's `createPrivySessionVerifier` accepts, the session's
   embedded Sui wallet is the sender, and the report has a visitor cookie:
   that reporting visitor is the link (`privy_session`). Privy is asked only
   when a token and a visitor are both present, alongside the node read and
   within `OUTCOME_PRIVY_TIMEOUT_MS` (2 s), and never refuses the report.
   Each check that links no one is a `launchpad.telemetry` metric (`event:
   "outcome_privy"`): `result: "rejected"` with `reason: "other-wallet"` (a
   valid session for another wallet) or `"no-wallet"` (a valid session with
   no embedded Sui wallet), and `result: "dropped"` with the failure's bounded
   label for an invalid token, a Privy outage, missing Privy settings
   (`INVALID_CONFIGURATION`) or `timeout`.
2. **Signed commitment.** Otherwise, the digest's commitments whose receipt
   time is strictly before the transaction's checkpoint time: exactly one
   visitor among them is the link (`signed_commitment`); none, or two or
   more (contested), is no link. Commitments that arrive after a recorded
   link change nothing.
3. **Write rule.** A link is written only onto an outcome that has none (a
   conditional update), so an existing link is never replaced. The digest's
   commitments are deleted in the transaction of the digest's first verified
   report, whether a link was written or refused (late or contested), and in
   every later report's transaction (commitments that arrived since). A
   development row recorded before migration 0037 (no sender) is never
   touched.

Concurrent reports of a digest that has commitments serialize on their row
locks, so the later one sees the link the earlier one recorded. Reports of a
digest without commitments are not serialized, so simultaneous reports decide
independently: a cookieless sibling can be decided unlinked while a report
with the sender's Privy session links the other, and two different sessions
of the same wallet can leave siblings with different visitors. A later report
of the unlinked one converges it on the recorded link; an existing link is
never replaced. Two edges remain:

- When the Privy session holder and the on-time committer are different
  visitors (both the user's own evidence for the same wallet), the link
  follows whichever outcome is decided first, and every sibling carries it.
- An outcome decided with no link (no commitment, contested or late, and no
  session) stays wallet-only until it is reported again; that report takes
  the link a sibling has recorded since (a sibling reported later with the
  sender's Privy session is linked at once).

Rule 2 compares this server's receipt time (taken once the commitment
request's body has arrived, before the rate check) with chain time, so it
assumes an NTP-synchronized server clock. Each commitment that a report spends after it
was received at or after its checkpoint's time is a bounded
`launchpad.telemetry` metric (`event: "outcome_commitment"`, `result:
"late"`): a rising count means the server clock or the browsers' commitments
are late. A commitment that arrives after its digest's last report is never
spent by a report; the cleanup removes it without a metric.

**Commitments.** `POST /api/launchpad/outcomes/commitments` (Node runtime,
`no-store`) takes exactly `{ kind, launchId, txDigest }` under the same
guards, then requires the visitor cookie (422 `no-visitor`; it never mints
one), then the client IP's `launchpad_outcome_commitment` bucket (429
`rate-limited`, 503 `limiter-unavailable`). It stores `(tx_digest,
visitor_id)` once with the server's receipt time, read as soon as the body has
arrived (a client cannot pre-date it by opening the request early) and before
the rate check (a slow limiter cannot make it later): 201 `recorded`, 200
`duplicate` (the first receipt is kept), 503 `storage-unavailable`. It makes
no node read and records no outcome. Refusals record `event:
"outcome_commitment"` metrics like the report route's.

**Node configuration.** The route reads the launchpad's one server node
configuration, `configuredLaunchReadChain` (`modules/launchpad-coin/chain.ts`),
the same the coin page reads launch objects from: the SDK registry's released
deployment on `BLAST_NETWORK` and its fullnode, or, on a development server
only, the fixture node at `LAUNCHPAD_FIXTURE_CHAIN_ORIGIN`. Without one every
report is a 503 and nothing is recorded. Privy reads `PRIVY_APP_ID` and the
Privy API settings (`apps/web/.env.example`), resolved per check.

**Who reports.** The shared launch engine reports `launch` once, when a
draft first becomes `created` (Quick and Advanced alike), with the Privy
session's access token when a Privy wallet signed and the token is read
within 2 s (otherwise without it, so the launch is still recorded
wallet-only); and in approval two it
commits the signed creation digest just before submitting it
([launch-creation.md](launch-creation.md)). The curve trade rail commits
each signed Buy's digest just before submitting it, through the shared
controller's `onSigned` hook, and reports `buy` once per completed `Bought`
(its per-browser ledger), with the Privy session's access token when a Privy
wallet signed it and the token is read within 2 s
([trades.md](trades.md)).

**Outcomes are a lower bound.** The reporter sends each completed event once
per page. A 503 (`node-*`, `wrong-network`, `limiter-unavailable`,
`storage-unavailable`: the server cannot answer now) is retried once after a
jittered 3 to 8 s (`OUTCOME_RETRY_DELAY_MS`); no 4xx is retried, and the
server keeps one outcome per event, so a retry is at most a `duplicate`.
Everything else is lost for good:

- a second 503 (a longer outage, or the telemetry gate stepping aside under
  concurrent reports), and a page closed before its retry;
- a server node that lags the browser's node (`unknown-transaction`,
  `not-checkpointed`), and every other 4xx.

Linked outcomes are a smaller lower bound: a commitment that arrives late or
is contested, a visitor without a cookie (a creator who never opened a
tradable coin page has none), or a Privy check that fails leaves the outcome
wallet-only. Read launch and Buy counts, and `convertedViewers`, as lower
bounds, like the first-view denominator ("Expected loss" below). Watch the
`launchpad.telemetry` metric with `event: "outcome_report"` and `result:
"dropped"` (by `reason`), `event: "outcome_privy"`, and `event:
"outcome_commitment"` with `result: "late"`.

**Rate limits.** `launchpad_outcome` and `launchpad_outcome_commitment` are
per client IP and PROVISIONAL: both reuse the `launchpad_telemetry` values (30
a minute, 300 an hour) until the owner sets their own.

### Non-blocking delivery

Product code calls the emitter and never the service. A flow may `void` the
call or pass it to `after()`; even awaiting it cannot hold the action past
the timeout or change its result. Storage outages, timeouts, unconfigured
databases and malformed records become `dropped` or `rejected` and a
`launchpad.telemetry` metric with `event`, `result` and `reason` only.

Telemetry shares the product's primary pool, so it must not take the
product's connections or database backends (`gate.ts`):

- Per process and pool, at most a quarter of the pool (at least one
  connection) does telemetry work at once. A call waits at most 25 ms for
  that share and never queues for a connection: when the share stays busy,
  the pool has waiters or every connection is lent out, the work is
  `dropped` (`LAUNCHPAD_TELEMETRY_BUSY`).
- Every telemetry statement (the first-view and outcome inserts, and the
  rate limiter's count) runs in its own transaction with
  `SET LOCAL statement_timeout = 1000`, `lock_timeout = 500` and
  `idle_in_transaction_session_timeout = 1000`. `SET LOCAL` is safe behind
  Neon's transaction-mode PgBouncer; session settings and startup options
  are not used. PostgreSQL cancels a statement past its budget and the
  transaction rolls back, so an abandoned beacon never commits later and
  never leaves a backend behind. The share is released only when the server
  has answered, so it also bounds telemetry's server backends: with the
  table locked, one instance holds at most its share of backends, each for
  at most about a second.

**Expected loss.** The share trades completeness for safety. Under healthy
load a busy instance drops some views when more beacons arrive at once than
its share can insert within the 25 ms wait (the R-002 review measured
1.5 % at 50 beacons a second per instance and about 20 % at 200 a second
without the wait). The first-view denominator is therefore a lower bound.
Watch the `launchpad.telemetry` metric: alert when `result = "dropped"` with
`reason = "LAUNCHPAD_TELEMETRY_BUSY"` exceeds 5 % of `coin_view` events over
15 minutes, and raise `DATABASE_POOL_MAX` (the share grows with it) before
relying on the counts.

## Storage

Migration `0031_launchpad_telemetry` creates
`mission_control_launchpad_coin_views` and
`mission_control_launchpad_outcomes`, owned by the `launchpad-telemetry`
module, and grants them to `blast_web` like every web table (`0030`).

Migration `0037_launchpad_outcome_attribution` (same module, `blast_web`
only) adds to the outcomes:

- `sender_wallet` (canonical `0x` + 64 hex), required for every new row by
  `CHECK (sender_wallet IS NOT NULL) NOT VALID`; development rows recorded
  before it are untouched (no deployment was released);
- `visitor_link` (`privy_session` or `signed_commitment`), present exactly
  when `visitor_id` is for new rows (also `NOT VALID`);
- an index on `(sender_wallet, kind, completed_at)` for per-wallet
  repeat-trading queries.

It creates `mission_control_launchpad_outcome_commitments` (`tx_digest`,
`visitor_id`, `kind`, `launch_id`, `committed_at`; primary key `(tx_digest,
visitor_id)`), granted `SELECT`, `INSERT` and `DELETE` to `blast_web` only.
The maintenance cleanup deletes a commitment no report decided after
`LAUNCHPAD_OUTCOME_COMMITMENT_WINDOW_MINUTES` (a deployment setting: whole
minutes, default 60, never longer than the 90-day retention). Outcomes keep
the 90-day retention. The down migration drops the table, the index, the
constraints and both columns.

```bash
npm run test:integration -w @blast/server -- src/modules/launchpad-telemetry/launchpad-telemetry.integration.test.ts
npm run test:integration -w @blast/core -- src/modules/database/runtime-roles.integration.test.ts
```

### Development fixtures

`outcome-fixtures.ts` holds one fixture launch (`0x5a5a…5a5a`) and a
transaction for every case: a completed launch (`LaunchShared` at event 1),
a creation that includes the creator's first buy (`Bought` at 0,
`LaunchShared` at 1; two outcomes of one digest), a curve Buy, a settlement,
a settlement then a bidder's buy, a `Sold`, a failed, a foreign-lineage,
another launch's and an uncheckpointed transaction, and an unknown digest. `npm run dev:coin-fixtures -w @blast/web` serves them
as the dev fixture node (`/__fixture/transactions/{digest}`,
`/__fixture/chain`; `fresh: "down"` takes the node offline and `chain:
"other"` puts it on another chain), so a development server started with
`LAUNCHPAD_FIXTURE_CHAIN_ORIGIN` verifies reports against them. The
`/dev/launchpad/launch` harness lands its own completed creation there
before reporting it: the page posts it same-origin to the dev-only
`POST /dev/launchpad/launch/fixture-transactions` (404 in production;
`modules/launchpad-coin/fixture-landing.ts`), and the dev server forwards it
to the fixture node's `POST /__fixture/transactions`, so the page's CSP never
names the fixture origin. The browser's fixture node executes instantly, so
the harness lands the creation `HARNESS_CHECKPOINT_DELAY_MS` (1 s, about a
real checkpoint's delay after submission) after it completes, checkpointed at
that moment, after the engine's pre-submission commitment reached the server.
A harness launch is then recorded like a real one: for the fixture wallet
that signed it, and linked to the browser's visitor when the browser carries
a visitor cookie. With "Creator's first buy" set, the fixture creation also
emits the creator's `Bought` before `LaunchShared`, as the SDK builds it, so
the digest holds two outcomes; the engine reports the `launch`, and the
`buy` can be reported by anyone. The harness shows whether the landing failed. The Quick and
Advanced fixture pages pass a no-op reporter and committer.
