# Standalone liquidity vaults

Standalone Cetus and Bluefin vault coins appear in Home’s existing Coins list after coin and quote metadata arrive and the market pipeline registers their canonical pool. They reuse the existing coin row, expanded market view and swap. Unavailable presale fields, watchlist and presale discussion controls are hidden; no vault pages, navigation or Presales cards are added. Multiple vaults of one coin produce one coin row. Aftermath presales retain the current presale and migrated coin components. Backend vault discovery and collection do not require hydrated metadata. The creation transaction must emit the configured Blast package’s native `VaultCreated` event.

The daily collector reads the position’s sealed venue from the vault’s dynamic object field and uses the existing SDK collection transaction. Collection is independent of presale migration and holder price eligibility. Protocol fees, recipient splits, partner handling, signed custody and retry rules remain enforced by the existing contracts and executor.

Holder rewards use the existing daily eligibility, price, gas reserve and complete holder-history checks. For a Blast presale coin, including an Aftermath migration, the existing indexed holder history and canonical pool remain the sources of truth. The native balance-history pipeline records all coin types, so a coin does not need a presale to qualify. Its creation baseline and full holding window must still be covered; an incomplete historical baseline blocks allocation rather than distributing against partial balances. Quote fees fund holder rounds; coin fees follow the existing treasury policy.

Each standalone vault has its own reward source ID. Several vaults for one coin therefore keep separate received amounts, waiting allocations and payout pages under `/portfolio/rewards`. Existing presale rewards retain their presale identity. The original `presale_reward_payouts` view and waiting function remain available for old consumers.

## Rollout

1. Apply blast-infra migration `2026-11-06-000000_standalone_vaults` and deploy the indexer changes. It adds `chain_read_v1.vaults`, `reward_sources`, and `vault_reward_payouts`, and extends reward-planner discovery.
2. Apply web database migration `0117_standalone_vault_rewards` on the primary. It adds the scoped waiting reader with vault identity and unchanged native funding checks.
3. Wait for the new infra views to reach the read replica, then deploy the web app and rewards workers together. Keep the existing launch flags and access gate.

For a previously untracked coin’s existing Cetus or Bluefin pool, the indexer registers the first canonical pool at vault creation and records its price from the first subsequent native swap. Until then there is no observed price. If the creation checkpoint was already indexed before this release, market-pipeline replay from vault creation is required to register that pool; fee collection uses the already indexed vault projection, while Home discovery waits for canonical pool registration. Existing Blast coins continue using their original canonical pool.

A Blast presale migrating to Aftermath already has a supported pool path without a vault. This change adds support for manually locked Cetus or Bluefin positions; it does not add an Aftermath vault contract.
