# Final launch-stack workers

The workers use the canonical mainnet deployment registered in Blast SDK 0.3.0, including the verified Cetus and Bluefin routes. Contract source follows the [current Sui package layout](https://github.com/interest-protocol/blast-v2-contracts/tree/main/sui). Production workers require reviewed release evidence and verified on-chain configuration before signing. Never supply a manifest file in production.

| Process | Work | Authority |
| --- | --- | --- |
| `blast-keeper` | Coin Registry registration; opening settle/deliver; launch migration using launchpad request then migrators adapter; presale settle, two-call migrate and `cancel_unlaunched`; protocol fees; presale/vault partner payouts; hourly per-vault collect fees and ready `settle_and_apply_fee_split`, with persistent fair capped discovery; gas-pool balance alert | Dedicated gas-only key; no role or cap |
| `rewards-planner` | Freeze checkpoint and holder inputs, reconstruct both fee balances, allocate both reward assets to eligible holders, and commit the manifest | No signer; `blast_indexer` pooled primary login |
| `vault-rewards` | Verify frozen plan and live vault, schedule then publish; relay allocations, reconcile gas, close expired rounds | Dedicated key and one core `RewardsAdmin` cap for both products |
| `vault-buyback` | Discover both products' vaults; preserve budget, TWAP/USD, slippage, piece spacing and pool-share limits; guarded buyback/burn through the selected venue | Dedicated key and one core `BuybackAdmin` cap |

`social` remains a separate process with its existing account/social configuration. Delayed `apply_*` calls stay in the admin console. DefiLlama publishing runs separately, as the hourly `blast-defillama-publisher` cron. There are no old worker commands, aliases, separate product reward executors, bridge worker or lifecycle planner.

## Runtime and storage

Run `/app/apps/workers/start.sh <process>` or `npm run worker -w @blast/workers -- <process>`; the processes are the rows of `apps/workers/src/processes.ts` (`start.sh --list`). All processes use the shared native Node loader. Signing processes isolate every foreign `*_SIGNER_KEY`, refresh deployment admission, ownership/role and pause checks, pay gas from their address balances, journal exact signed bytes before submission, and fence unknown submissions until definitive effects or epoch expiry. Signer leases and prepared-input custody fences prevent conflicting attempts. SIGTERM drains the current pass.

Migration 0154 binds new sponsored presale reservations to a deployment fingerprint so prepared transactions cannot cross a cutover. Submitted attempts remain available for reconciliation. Migration 0153 is additive to account data. It preserves account/profile/wallet/referral/social/settings/invitation and blacklist data and human release-gate evidence. It adds `blast_keeper_actions`, the `vault_reward_*` journal and `mission_control_vault_buybacks`, renames alerts and the buyback gate without deleting their rows. Retained old database journals are custody evidence, with no worker runtime reading them. Do not truncate them or perform a web database reset as part of rollout. Resolve any unknown signed attempts before changing signer ownership.

New rounds pay eligible holders the Meme and Quote available in the vault’s holder-rewards balance using the same time-weighted balance for both assets. A JOEY round pays JOEY and SUI to holders. Rounding leftovers stay in the vault for later rounds. Every new round requires a positive holder Quote payout. If Quote falls short of the holder minimum or all holder allocations round to zero, both assets stay in the vault for a later round. `REWARDS_GAS_RESERVE_BPS` defaults to zero. A nonzero setting is at most 909 bps of gross Quote, and the reserve cannot exceed 10% of allocated holder Quote.

For plans that evaluate holder eligibility, frozen exclusions include the per-coin blacklist, launch and presale team allocations, evidenced treasury destinations, protocol objects, and `REWARDS_EXCLUSIONS`. Cuts, holders, allocations, and custody survive restart. The planner and signer reject unpublished plans prepared under the previous payout policy. The treasury remains the destination for gas reimbursement.

`VAULT_REWARDS_RELAY_BATCH` defaults to 1,023, the largest accepted Sui command count. The relay packs the largest ordered prefix that fits in a signed 128 KiB transaction. It dry-runs with up to 1 SUI from the signer’s address balance, budgets gas after Sui’s storage rebate, plus up to 10% headroom, and checks the adjusted bytes before signing. On a gas or size limit, it probes smaller prefixes to find the largest one that fits before signing. The signer independently caps claim gas at 1 SUI per transaction.

## Indexer contract and cutover gates

Use the final launch stack indexer merged into `blast-infra` main in [#127](https://github.com/interest-protocol/blast-infra/pull/127). It provides `chain_read_v1` views, including `vaults`, `vault_fee_collections`, `vault_rounds`, `protocol_fee_ledgers`, `partner_earnings`, `delayed_values`, `pool_tiers`, `stack_packages`, `stack_objects`, `quote_allowed` and `meme_decimals_allowed`. The schema suffix stays v1; these are new-stack relations, with no fallback reads. Keeper bidder pages and buyback candle/pool reads use the indexer's `/v1` API.

Before rewards go live, indexer evidence must include ordered gas-settlement and close checkpoint/transaction/event cursors and digests, immutable treasury destination creation/application history and the original `RoundPublished` receipt. The immutable publication Quote remainder is decoded from that receipt, never the mutable round balance. Current projections may omit settlement/close cursors and applied treasury history. Rewards refuse an affected historical cut instead of estimating funds or choosing the current treasury destination. Track replay coverage and evidence in [the indexer replay issue](https://github.com/interest-protocol/blast-infra/issues/69).

The web and social chain readers use the same replayed vault and fee projections. Verify their readiness before cutover. Account/social records remain intact. Historical funds and treasury proofs stream ordered keyset pages without a lifetime row cap. Missing gas-price evidence is retried by transaction digest and blocks only the affected plan's gas settlement; definitive effects release shared-cap custody independently. Bluefin pool-creation fees come from the keeper's address balance and must not exceed `BLAST_WORKER_BLUEFIN_CREATION_FEE_CAP_MIST` (default `0`). No protocol role is needed. Set `BLAST_WORKER_GAS_BUDGET_MIST` high enough for pool creation, rather than sizing it only for fee claims.

The web app and workers use the published Blast deployment and umbrella SDK packages at version 0.3.0. The lockfiles record their registry integrity hashes.

## Release gates

The keyless `worker:release-gate` command records, revokes or shows the checks of each signing worker: `npm run worker:release-gate -w @blast/workers -- <blast-keeper|vault-rewards|vault-buyback> status | record <check> <evidence> | revoke <check> <evidence>`. Each record binds to `BLAST_NETWORK=mainnet`, `BLAST_DEPLOYMENT_FINGERPRINT` and the role's public signer address: `BLAST_WORKER_SIGNER_ADDRESS` (keeper), `VAULT_REWARDS_SIGNER_ADDRESS` with `VAULT_REWARDS_ADMIN_CAP_ID` (rewards), `BLAST_BUYBACK_SIGNER_ADDRESS` with `BLAST_BUYBACK_ADMIN_CAP_ID` (buyback). Checks: keeper `indexer-coverage`, `service-isolation`, `gas-pool-rehearsal`, `alerts`; rewards the same plus `core-role`; buyback `buyback-key`, `buyback-admin-grant`, `buyback-alerts`. Keeper and rewards are gated in production; buyback is gated everywhere. All records live in `blast_worker_release_gate_checks` (append-only; migration 0158 moved the buyback records there). Evidence is redacted, then must be 1 to 1000 characters. Use a migration login only for authorized gate writes; the command refuses any `*_SIGNER_KEY` in its environment.

## Auto-LP compounding

Keeper collects pool fees into the vault's pending Auto-LP balances. A release operator can reinvest those balances on Cetus or Bluefin with the one-shot `vault:auto-lp` command. The command uses the released mainnet deployment and its current on-chain identities.

1. On one operator host, provision a dedicated sender with SUI in its address balance and a cap whose only role is `AutoLpAdmin`. Use `install -d -m 700 "$AUTO_LP_STATE_DIR"` to create a persistent private state directory. Always use the same directory for that sender. Configure `BLAST_NETWORK=mainnet`, `BLAST_DEPLOYMENT_FINGERPRINT`, a trusted HTTPS `BLAST_WORKER_SUI_GRPC_URL`, `AUTO_LP_SIGNER_ADDRESS` and `AUTO_LP_ADMIN_CAP_ID`. Keep this signer separate from the Keeper and other workers.
2. Verify the vault, pool and coin order. Obtain a pool-specific price from a trusted independent source and retain its observation time in Unix milliseconds. Express it as `floor(sqrt(atomic B / atomic A) × 2^64)` in the pool's coin order. Run the following keyless simulation with that reference and a gas budget of at most 0.25 SUI.

   ```sh
   npm run -w @blast/workers vault:auto-lp -- plan \
     --state-dir "$AUTO_LP_STATE_DIR" --vault "$VAULT_ID" --pool "$POOL_ID" \
     --reference-sqrt-price-x64 "$REFERENCE_SQRT_PRICE_X64" \
     --reference-time-ms "$REFERENCE_TIME_MS" --gas-budget-mist "$GAS_BUDGET_MIST"
   ```

3. Review the preview's pair, bounds, added amounts, residuals and gas. With operator approval, repeat with `execute` and supply the dedicated Ed25519 key via `AUTO_LP_SIGNER_KEY` in an isolated environment. Execution re-simulates the exact transaction, requires both assets to be added in simulation, then durably records the digest before submitting once.
4. Use `npm run -w @blast/workers vault:auto-lp -- status --state-dir "$AUTO_LP_STATE_DIR"` to reconcile the digest without a key. `compounded` requires successful effects and the vault's matching `AutoLiquidityAdded` event. `unconfirmed-addition` means effects succeeded but the expected two-sided receipt needs review. A recorded attempt fences all new submissions for the sender. Keep the record until effects and the receipt have been reviewed, or until an authoritative archival lookup establishes non-execution after the recorded epoch has elapsed. Archive the resolved record before starting a new attempt. A single node reporting a missing digest is insufficient evidence.

The contract checks the execution price within 50 basis points of the reviewed **sqrt price**, clamped to the venue's limits. The five-minute freshness limit is enforced by the CLI before signing and sending. The transaction expires at the end of its Sui epoch. Review the entire pending bucket before executing, because the venue uses the balances present at execution and returns unused amounts to the vault. Simulation previews quantities, while the on-chain bounds constrain price.

## Render configuration

The [Render blueprint](../../render.yaml) declares the worker names, start
commands and shutdown allowance. Use [.env.example](../../apps/workers/.env.example)
for configuration. Assign each signer and database role to its owning
process. Store credentials in service-scoped configuration. Verify
deployment identity, reader provenance, permissions and custody before a
signed worker pass. Require fresh release evidence for each enabled process.

### Holder reward policy cutover

1. After owner approval, stop and drain both live rewards workers. Confirm both old processes have exited and no old signer can submit more transactions. Resolve signing and signed custody with definitive chain effects or verified transaction expiry before proceeding.
2. With both workers stopped, read the unpublished journal again and check every vault for an on-chain schedule. Cancel incompatible schedules before their notice elapses and verify cancellation on chain. Rebuild incompatible unpublished plans from their original periods and cuts. Preserve the records and claims of already published rounds. Keep both workers stopped if custody, the journal, and chain state cannot be reconciled.
3. Start the reviewed `vault-rewards` release first. Set `VAULT_REWARDS_RELAY_BATCH` to the reviewed batch limit. For adaptive batching at full capacity, remove the old override or set it to `1023`. After verifying signer readiness, start the reviewed `rewards-planner` release. Verify the first new plan and claim effects against the payout policy.

## Local verification

Install from the repository root with `npm ci --ignore-scripts`. Run `npm test -w @blast/workers` and the affected integration files. `scripts/with-disposable-postgres.sh` supplies explicit disposable loopback database URLs and removes its own container. Never use production configuration or Neon for tests. `npm run db:migrate` must succeed against that local database and be idempotent. `bash apps/workers/smoke.sh` checks the production image offline on an appropriately resourced owner host; it creates no service and submits no transaction.
