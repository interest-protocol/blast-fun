# Next release: presale generation 2 and the Aftermath DAO-pool venue

> Hosting update (2026-10-22): the production backend now runs on Render, with
> Vercel frontend and existing Neon databases. Follow
> [the current hosting guide](RENDER.md). The dated decisions, branch names and provider
> instructions below are historical records, not current deployment steps.


This is **not** part of the 2026-10-10 launch. It is what the owner must publish and configure before branch `next/aftermath` can run in production. Nothing here was done by an agent: no package was published, no ID exists yet, no manifest or Railway variable was changed, and no secret is in this repository.

Branch `next/aftermath` (from the launch tip `1bb89263`) moves the web app and the presale workers onto the integrated SDK (`interest-protocol/blast-v2-sdk` `next/sdk-integration@f52ca59`, contracts `af86ea4`, vendored in `vendor/blast-sdk/`) and teaches the presale lifecycle worker to migrate Aftermath DAO-pool sales.

**The generation-2 SDK cannot read the live generation-1 presale package** (`0x76cb…98400`): its layouts, events and claim call differ. Deploying this branch against the generation-1 manifest makes every sale read `sale_unreadable` and every launchpad action `abi-mismatch`. Deploy it only together with the steps below.

## 1. Publish, in this order

Each step depends on the one before. Use the contracts runbooks; the IDs come from each publish's effects.

1. **`blast_partners`.** Publish it first: the generation-2 `blast_presale` links it to pay a sale's partner.
2. **The new `blast_presale` (generation 2).** Follow `presale/DEPLOYING.md` in the contracts repository: retire the live dependency-only generation's `Published.toml` entry first, so the new entry names the address the vendor package links to. Record the package ID and the shared `VenueConfig`, `CreationPolicy`, `FeePolicy` and `AdminRegistry` with their initial shared versions. Call `fee_policy::set_destination` once (as for generation 1).
3. **The Aftermath vendor package `blast_aftermath_dao_presale`** (at `af86ea4` its `new` is split into `new` and `finalize`; `migrate` is unchanged).
   - Run `scripts/verify.sh` and `node scripts/check_mainnet_abi.mjs`. The ABI gate fails on any newer Aftermath revision until it is reviewed.
   - Run `scripts/publish_immutable.sh --preview`, then `--execute`: the package becomes immutable in the publish transaction, and its only `AdminCap` goes to the publisher.
   - With the presale `AdminCap`, call `creation_policy::set_migration_witness_allowed` for `<vendor>::blast_aftermath_dao_presale::Witness`, and allow the sale's Quote type.
4. **Re-sync and refreeze before any of these publishes** if contracts `main` moved past `af86ea4bf34080553a45d961d6db8cec719bb2a0`: re-run the SDK's `npm run check:abi`, refreeze for any approved change, repack and re-vendor the SDK.

## 2. Put the IDs into the manifests

- **`PRESALE_DEPLOYMENT_MANIFEST`** (web on Vercel, and every presale worker on Render):
  - `presale`: the generation-2 package and its four shared objects;
  - `contractsCommit`: the published presale source commit; `sdkCommit`: the vendored SDK commit;
  - `venues.aftermath.vendorPackageId`: the vendor package ID. `venues.aftermath.poolRegistry` and `venues.aftermath.daoFeeVersion` may be left out: they default to the SDK's documented `AFTERMATH_MAINNET_OBJECTS` (`PoolRegistry` `0xfcc77449…577ae`, DAO-fee `Version` `0xb4bfb0f9…392b7`, as recorded on 2026-09-02). Set them only if Aftermath moved those objects.
  - Production refuses a placeholder vendor ID (below 2^64, an SDK test ID, or the web fixture's). Leave `venues.aftermath` out until the vendor is published; its sales then block as `venue-unrecorded`.
- **The launchpad deployment manifest** must be rebuilt from contracts `af86ea4` with the SDK's new `FROZEN_ABI` hashes (launchpad `f1dd0c41…aa9d6`, Blast SUI `fea49b30…a574`), or `evaluateProtocolAccess` reports `abi-mismatch` and the launchpad stops signing. **Decide this first:** the launch's launchpad was built from contracts `442116a` (ABI `90da6331…2cf3`), so its ABI differs from `af86ea4`'s (ADR 0105's permissionless fee claims, ADR 0107's partnered `LpVault`). A manifest may only name `af86ea4` for packages actually upgraded to it. Either upgrade the launchpad and migrators packages to `af86ea4` in the same release, or have the SDK keep the launch's launchpad pins; this branch does neither.
- **The SDK registry** still names the generation-1 package (`getPresaleDeployment("mainnet")`). The web reads the manifest, not the registry; register the generation-2 release in the SDK when it is published.

## 3. Configure blast-infra

blast-infra's generation-2 work is on its branch `sfd/next-presale-gen2-aftermath` (WIP at the time of writing). It needs:

- the generation-2 presale package (`--presale-generation`, the original package) and the vendor package (`--aftermath-presale-package-id`);
- the agreed list venue `{ kind: "aftermath", vendor_package_id, pool_creation_id | null, lp_type | null, pool_id | null, dao_fee_pool_id | null }` on `GET /v1/presales` and the projection, which the lifecycle worker reads (its `pool_creation_id` says where the sale's `PoolCreation` is; the worker checks it on chain);
- `chain_read_v1.presales.venue` = `aftermath` for the vendor's witness. Until then the social app's `SHOWN_PRESALES` leaves Aftermath sales out (it hides a sale with no venue);
- the amended presale contract this branch publishes (`src/modules/presale/contracts/schemas`): the Aftermath venue branches, `totals` without `remaining_commitments` (generation 2 has no such total; `participants` counts down as wallets claim), the generation-2 abort names (with `EInvalidHardCap` and `EMissingSetting`), the sale-level `hard_cap` (`{ starts_after_ms, closes_when_filled }`, no longer on `uncapped`), `windows.hard_cap_from_ms`, and a nullable CLMM tier (`tick_spacing`, `pool_fee_rate`);
- **early close (ADR 0110):** after a sale closes early, `windows.end_ms` and `liquidity_deadline_ms` on the list and the projection, and `chain_read_v1.presales.end_ms`, must be the ACTUAL ones `PresaleFunded` carries. The social app's countdowns, "live" filter and notifications read `end_ms` from there; the lifecycle worker follows the chain itself;
- **tiers (ADR 0111):** `venue_config::PoolTierReserved<Meme, Quote, Venue>` (no `presale_id`, emitted before `PresaleCreated`, keyed by the sale token) fills the venue's tier; an Aftermath sale has none.

## 4. Before the first Aftermath sale migrates

- **Prove a mainnet dev-inspect of the vendor's `migrate`** with a fresh LP coin, for both coin orders (the sale token before and after the Quote in Aftermath's order). The local stubs prove types, not behaviour.
- Apply web migration `0104_presale_lifecycle_aftermath` (it widens the lifecycle records' venue check and adds `aftermath_pool_creation_id`; its down refuses while an Aftermath record exists).
- The lifecycle key needs no new setting: an Aftermath migration splits no fee. `PRESALE_LIFECYCLE_GAS_BUDGET_MIST` must cover it; measure the first migrations' gas.

## 4a. In-app trading of Aftermath coins

An Aftermath coin trades in the app like a Cetus or Bluefin coin: Buy and Sell, its quote, dry run, Blast's fee, slippage, sponsorship and receipt (`SOCIAL_TRADE_VENUES` includes `aftermath`). The Cetus aggregator does not route DAO-fee pools, so the trade path calls the pool's wrapper directly: `swap::swap_exact_in` of Aftermath's DAO-fee package (`src/modules/social/trades/aftermath.ts`). USDC or SUI that is not the pool's own quote coin goes through the aggregator first or after, with no fee of its own. Blast's fee is split from the final output and sent to `BLAST_TRADE_FEE_RECEIVER` in the same transaction. A quote reads the pool, its wrapper and Aftermath's protocol fee vault from the fullnode; on mainnet its figures equal the chain's to the atom.

- **Nothing to configure.** `PRESALE_SPONSOR_SWAP_TARGETS` is unchanged: the sponsor pins the DAO-fee call whole in code (`src/modules/presale/sponsor/aftermath-dao.ts`: the package, the function, and every shared object except the pool). Only the trade intent admits it, and Blast's fee may go to its receiver only in a kind that calls it.
- **If Aftermath upgrades** the DAO-fee package or moves one of its objects, Aftermath trades are refused (the dry run, or the sponsor) until both pin files are updated and reviewed.
- **The fee a buyer pays** on a Blast DAO-fee pool is the sale's DAO fee (2%), Aftermath's protocol fee (0.05% of what is left), and the pool's own swap fee (0.01%), plus Blast's 0.3%. The quote's `fee_bps` shows the first three compounded.
- **Price, chart and trades** of an Aftermath coin come from blast-infra's decoding of the pool's swaps (branch `sfd/next-presale-gen2-aftermath`), as for Cetus and Bluefin.

## 5. Product decision (owner, 2026-10-08)

- **Creators choose launch timing in Launch.** "When target is reached" sets a hard cap from the start and permits immediate settlement and migration, independently of wallet limits. "At scheduled end" waits for the full sale window, including when a final-phase hard cap stops further contributions. New and older drafts default to the scheduled end. The wallet that fills an early-closing sale can commit, settle, migrate and buy from the new pool in one transaction.

## 6. Known gaps, not in this branch

- **Partner payout after migration:** the lifecycle relayer pays a partnered sale's partner in its own migration PTB on every venue (`pay_protocol_fees_with_partner` after the venue's `migrate`). A sale migrated without the payout (someone's bare migrate, or a payout the relayer dropped so the migration could land) only raises `partner_unpaid:<id>`; the relayer does not yet pay it on its own (a `pay-partner` shape needs a record state or column for its digest and discovery of migrated sales). Until then an operator pays it by hand ([runbook](../presale/runbooks/manual-settle-migrate.md#paying-a-partner-after-migration-partner_unpaidid)).
- **Commit change under a hard cap:** from the cap's start, a commit takes only what is left of the raise and returns the rest as change (`previewCommit(...).change`). The SDK already sends it back; the commit quote does not show it yet.
- **Open-sale countdowns** for a sale that closes when filled still count to the scheduled `end_ms`: it may close sooner.
- **Claim delivery stays disabled** (owner, 2026-10-07). Its guard follows generation 2's `claim(presale, participant, clock)` but is not registered.
- **Generation-2 presale vectors** must be recaptured after publication (the SDK dropped generation 1's).
- **Launchpad `LpVault`:** the SDK decodes ADR 0107's partnered layout (`partner_id`, `unpaid_protocol_*`). A vault of migrators published from `442116a` lacks those fields, so the migrated-coin trade reads would fail on it: this is the same launchpad decision as in section 2.
