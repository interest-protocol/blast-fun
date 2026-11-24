# Frontend swap tracking

Every transaction built by `/api/social/trades` already has a durable
`social_swap_intents` row before the browser signs. Migration 0125 adds
`social_swap_receipts`: one checkpointed outcome per intent. Only successful
outcomes carry a bought amount and appear in the competition export. Failed
outcomes retire permanently failed transactions from recovery.
The settlement route records the receipt in the same transaction as settlement.
No browser analytics service, local storage, or user-provided success flag
is involved.

Tracking starts with intents created after this migration. Existing intents
remain excluded, even if they settle later. There is no historical backfill.

The receipt export contains the sender, bought coin type, actual bought atoms,
paid coin type/atoms, chain timestamp in milliseconds, checkpoint, transaction
digest, trade ID, and nullable USD estimate. All amounts are decimal strings.
Use coin metadata decimals to display atoms. A sell that receives SUI/USDC
also records that output; there is no coin allowlist or `side = buy` filter.
An aggregator route produces one frontend swap receipt, not one per route hop.
The received amount is the sender's output balance change, after output fees;
signed wallet-paid net gas is added back when receiving SUI, excluding storage
rebates from the purchased amount.

`usd_value` is the input's USD estimate saved when preparing the transaction,
rounded to cents by the existing trade path. Its `usd_basis` is explicitly
`input_value_at_submission`. It is not a historical oracle valuation at the
checkpoint, the output coin's unit price, or profit. Unpriced inputs remain
null; zero is not a substitute for missing prices. No present-day prices are
used to backfill historical USD.

## Enable and export

Apply the normal web database migrations with the existing migration role
before releasing this change. Run these collection/export commands from
`apps/web`, with `DATABASE_URL` set privately to the **primary** database using
`blast_web` credentials. No production migration
or collector scheduling is performed by this source change.

```bash
npm run swaps:track -- collect
npm run --silent swaps:track -- export \
  --from 2026-10-20T00:00:00Z --to 2026-10-21T00:00:00Z
```

`collect` is a finite recovery sweep, reading pages of 100 intents with serial, five-second-bounded fullnode requests
and a single database connection. Schedule recurring sweeps through the hosting
platform when deploying, and run a final sweep after a competition closes.
It recovers successful trades even if the browser never settled them or the
initial result was not checkpointed yet. Null/uncheckpointed results write
nothing; checkpointed failures are recorded once and excluded from exports.
The `failed` count reports newly recorded failures, and `recorded` counts purchases.
The `pending` count reports missing/uncheckpointed outcomes
(including transactions that were built but never signed); unavailable lookups
produce a nonzero process exit for retry.
Every new sweep starts from the beginning of outstanding intents, so a delayed
checkpoint or temporary outage is retried. Already recorded receipts are skipped.
The sweep does not change the intent or transaction log's settlement state.

The export uses one repeatable-read snapshot and emits JSONL, ordered by `(timestamp_ms, trade_id)`, for the half-open
interval `[from, to)`. It reads pages of 100 without loading all history into
memory. Shell redirection can save the JSONL to a private artifact file. Its
timestamps come from Sui checkpoints, not the browser clock or request time.
Reruns cannot duplicate receipts because `trade_id` is the primary key and the
intent's transaction digest is unique. Runtime roles cannot update or delete
receipts. Recovery only considers new intents marked for tracking at creation.

## Scope

This tracks the current frontend swap API, including all its routed output
coins and embedded/external wallet signers. It does not count swaps made
directly on other apps, launchpad contract rails that bypass this API,
presale commitments, or individual inner pool swaps. Requests made directly to
our swap API are indistinguishable from browser requests; attribution means
our service built the transaction, not proof of a human browser session.

There is no public wallet feed or leaderboard in this change. Raw activity
stays on the primary with existing restricted credentials, separate from the
private analytics warehouse's registered-pool volume metrics. Decide eligibility,
scoring, time window and exclusions before publishing competition rankings.
