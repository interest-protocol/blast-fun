# All linked-wallet coins

Deploy the paired blast-infra `2026-11-04-000000_wallet_balances` migration and
engine before switching portfolio reads. Its `docs/wallet-balances.md` contains
snapshot consistency, concurrency configuration, queue monitoring and recovery.

Apply web migration `0112_wallet_balance_tracking` and deploy both the social
worker and web app. The migration backfills Slush/social, Mission Control and
embedded wallet registries into a durable queue. New links enqueue in the same
transaction. The `wallet-registration` worker step registers and acknowledges
1,000 addresses per pass; infra outages leave requests available to retry.

The portfolio reads `chain_read_v1.wallet_balances` and `wallet_sync`, aggregates
only the verified account's linked addresses, and enriches every holding with
metadata and available prices. Unlisted TEST_SUI is included. Missing metadata
shows exact base units. Coins without a USD market display `$0.00`; stale prices,
missing prices for USD-backed markets, and indexing faults remain unavailable. SUI/USDC remain in
the existing cash fields, avoiding double counting. Existing presale coins retain
their cost basis and actions; generic coins have no invented presale action.

The Portfolio screen polls every five seconds during initial synchronization and
every 30 seconds afterward while visible. It reports syncing/stale balances.
Amounts never silently become zero after an index/provider failure. Opt-in public
portfolio reads keep their existing privacy checks. Daily valuation now includes
all non-cash wallet coins and skips incomplete or unpriced totals.

Check `public.social_wallet_balance_requests` for backlog and infra's wallet sync
status before confirming rollout. Code/tests are prepared locally; this document
does not indicate that either deployment has been released.
