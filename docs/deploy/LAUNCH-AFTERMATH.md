# Launch: presale generation 2 and the Aftermath DAO-pool venue

> Hosting update (2026-10-22): the production backend now runs on Render, with
> Vercel frontend and existing Neon databases. Follow
> [the current hosting guide](RENDER.md). The dated decisions, branch names and provider
> instructions below are historical records, not current deployment steps.


**Part of the 2026-10-10 launch** (owner decision, 2026-10-09): it ships inside PR #65 through branch `launch/aftermath-into-integration` (`sfd/integration` + `next/aftermath`). It is read together with [LAUNCH-DEPLOY.md](LAUNCH-DEPLOY.md): this page lists only what generation 2 and Aftermath add to that checklist. Nothing here was done by an agent: no manifest, Vercel or Railway variable was changed, and no secret is in this repository.

The release moves the web app and the presale workers onto the integrated generation-2 SDK (vendored in `vendor/blast-sdk/`, see its README for the exact build) and teaches the presale lifecycle worker to migrate Aftermath DAO-pool sales.

**The generation-2 SDK cannot read the generation-1 presale package** (`0x76cb…98400`): its layouts, events and claim call differ. Deploying this release against the generation-1 manifest makes every sale read `sale_unreadable`. `PRESALE_DEPLOYMENT_MANIFEST` must name the generation-2 package below, on Vercel and on every presale worker, in the same deploy.

## 1. Published on mainnet (2026-10-09)

Contracts commit `acad02ecd6c1b4be70f7b9c611c8d23cb318e9e5` (record: contracts `deployments/sui/mainnet/2026-10-09-blast-presale.json`, branch `deploy/presale-2026-10-09`). Generation 2 is administered through the shared Blast ACL: there is **no `AdminRegistry` and no presale `AdminCap`**. An admin call signs in with `blast_acl::sign_in<Role>(acl, adminCap)` in the same PTB, with a `blast_acl::AdminCap` that holds `<presale original>::blast_presale_domain::<Role>`.

| What | ID | Initial shared version |
| --- | --- | --- |
| `blast_admin` (immutable) | `0x726fb49b880faa89719b95c6ef3a91be794f771ed3560fe5894d0a605c8469f9` | |
| `blast_acl::ACL` (shared) | `0xc9fbcfc4eda38626d7daad17902cc145b4008beb20470135438298aa7a005a6d` | `1` |
| `blast_partners` (immutable) | `0x96fbe2db7337dea5ef6926203d32cf602e527d5e2dcae176fbbc3e3d2a30d94f` | |
| `blast_presale` original (v1) | `0x2d300f3d8819c6e09fd1558e518c2ffab97b324479843d4f94b561b10a441fd0` | |
| `blast_presale` current (v2, dependency-only upgrade) | `0x33897a946e231652f00d712834665831ada3e3ffb3cd3ef11f4a449058ab43c6` | |
| `VenueConfig` | `0x5399abde7eeb48fec9d38d048d9faebe2a51a82df03f35ae8feb52e7d9ef32dc` | `1` |
| `CreationPolicy` | `0xe5a202e29aa436e75d64af0eb286572bf32e35e0ce0f39ddf3ac4154d47d93a5` | `1` |
| `FeePolicy` | `0xe9eccc8b1281998240372a113b494ecfc7f57f47d3545880988ae3c05624c348` | `1` |
| Aftermath vendor `blast_aftermath_dao_presale` (immutable) | `0xac58d338925ac96304ca573a4dab80d442df6f2427291bcddbea7fc65279678e` | |

The four shared objects' types and initial shared version `1` were read from mainnet GraphQL on 2026-10-09 (`VenueConfig`, `CreationPolicy` and `FeePolicy` are `0x2d30…1fd0::<module>::<Type>`, the ACL `0x726f…69f9::blast_acl::ACL`). The presale package was published at checkpoint `331859629`.

Post-deploy configuration as recorded: Quote `0x2::sui::SUI` allowed; migration witnesses `cetus::Witness`, `bluefin::Witness` and the vendor's `blast_aftermath_dao_presale::Witness` allowed; the deployer's `AdminCap` `0xf9b3…146c` holds every presale role. **Check before launch:** the record shows `FeePolicy` destination = the deployer and rates `0/0/0/0`. Set the intended destination and rates (`FeeAdmin`) if those are not the launch values.

## 2. Remaining owner steps, in order

1. **Rewards key's `AdminCap`.** Grant the rewards key its own `blast_acl::AdminCap` holding `blast_presale_domain::RewardsAdmin`; set `PRESALE_REWARDS_ADMIN_CAP_ID` on `presale-rewards` to that cap (it is a `blast_acl::AdminCap` now, not a presale `AdminCap`).
2. **`PRESALE_DEPLOYMENT_MANIFEST`** (Vercel and every presale worker; one JSON value):
   - `presale` (the published values; `deployment.test.ts` parses exactly this block in production):

     ```json
     {
       "packageId": "0x33897a946e231652f00d712834665831ada3e3ffb3cd3ef11f4a449058ab43c6",
       "originalPackageId": "0x2d300f3d8819c6e09fd1558e518c2ffab97b324479843d4f94b561b10a441fd0",
       "venueConfig": { "objectId": "0x5399abde7eeb48fec9d38d048d9faebe2a51a82df03f35ae8feb52e7d9ef32dc", "initialSharedVersion": "1" },
       "creationPolicy": { "objectId": "0xe5a202e29aa436e75d64af0eb286572bf32e35e0ce0f39ddf3ac4154d47d93a5", "initialSharedVersion": "1" },
       "feePolicy": { "objectId": "0xe9eccc8b1281998240372a113b494ecfc7f57f47d3545880988ae3c05624c348", "initialSharedVersion": "1" },
       "admin": {
         "packageId": "0x726fb49b880faa89719b95c6ef3a91be794f771ed3560fe5894d0a605c8469f9",
         "acl": { "objectId": "0xc9fbcfc4eda38626d7daad17902cc145b4008beb20470135438298aa7a005a6d", "initialSharedVersion": "1" }
       }
     }
     ```

     The generation-1 `adminRegistry` key is refused (`malformed`).
   - `contractsCommit`: `acad02ecd6c1b4be70f7b9c611c8d23cb318e9e5`; `sdkCommit`: `908b3c5713e0aca78664d3325da8c0053b141d66` (the vendored SDK, `launch/sdk-acl-aftermath`; its presale ABI is pinned to `acad02e`); `publishCheckpoint`: `331859629`;
   - `venues.cetus` and `venues.bluefin`: unchanged from the generation-1 manifest (they are Cetus's and Bluefin's objects);
   - `venues.aftermath.vendorPackageId`: `0xac58d338925ac96304ca573a4dab80d442df6f2427291bcddbea7fc65279678e`. `poolRegistry` and `daoFeeVersion` may be left out: they default to the SDK's `AFTERMATH_MAINNET_OBJECTS` (`PoolRegistry` `0xfcc77449…577ae`, DAO-fee `Version` `0xb4bfb0f9…392b7`, recorded 2026-09-02). Set them only if Aftermath moved those objects.
   - Then `npm run presale:release-check -w @blast/web -- --sdk <sdk worktree at sdkCommit> --contracts <contracts worktree at acad02e>` (LAUNCH-DEPLOY step 0).
3. **Launchpad deployment (TODO, owner).** The owner upgrades the launchpad and migrators packages to current contracts so their ABI matches the vendored SDK's `FROZEN_ABI` pins. In production the launchpad manifest is the SDK's released registry (`BLAST_DEPLOYMENTS.mainnet`) and `BLAST_DEPLOYMENT_FINGERPRINT` must equal its `deploymentFingerprint`; `evaluateProtocolAccess` reports `abi-mismatch` (`source.contractsCommit` and `source.abi.{launchpad,blastSui}` against `FROZEN_ABI`), `unreleased-deployment`/`foreign-lineage` (registry), `sdk-unreleased`/`sdk-mismatch` and `runtime-mismatch` otherwise, and the launchpad stops signing.
   - **TODO: launchpad package ID (upgraded): _unknown, fill after the upgrade_.**
   - **TODO: migrators package ID (upgraded): _unknown, fill after the upgrade_.**
   - **TODO: contracts commit and ABI hashes of the upgrade, the SDK registry entry, and the new `BLAST_DEPLOYMENT_FINGERPRINT`: _unknown_.**
4. **Web migrations through `0104`** (LAUNCH-DEPLOY step 4): `0104_presale_lifecycle_aftermath` widens the lifecycle records' venue check and adds `aftermath_pool_creation_id`; its down refuses while an Aftermath record exists.
5. **blast-infra on generation 2** (below) before the web deploy, so `chain_read_v1` and `/v1/presales` decode generation-2 sales.
6. **Aftermath migration: proven on mainnet.** Contracts E2E-040 (`deployments/sui/mainnet/2026-10-09-blast-presale-e2e.json`, scenario `e040`, pass) created, filled, settled and migrated two real Aftermath vendor sales on mainnet, one per coin order. Their executed settle and migrate transactions are stored in `apps/workers/src/modules/presale/lifecycle/fixtures/e2e-040-aftermath-mainnet.json` (read from mainnet GraphQL), and `lifecycle.test.ts` ("E2E-040 mainnet") checks against the published identity:
   - the relayer's `migrate` for the same sale, `PoolCreation` and LP coin is **byte for byte** the executed transaction kind (vendor `0xac58…678e::blast_aftermath_dao_presale::migrate<Lp, SaleToken, Quote>(presale, pool_creation, fee_policy, pool_registry, dao_fee_version, clock)`), for both sales;
   - its `settle-migrate` is the executed settle and migrate command for command (same calls, types and object arguments). The one difference is the package of `settle`: the relayer calls the current package `0x3389…43c6` and E2E called the original `0x2d30…1fd0`. Generation 2's v2 is a dependency-only upgrade with identical modules, so this is the same function;
   - the lifecycle key's guards sign both shapes for the published presale and vendor `0xac58…678e`.
   - Gas (computation + storage, what the budget is checked against): migrate 40,532,000 and 37,917,600 MIST, settle 5,921,600 and 5,853,200 MIST; net after rebate 18.6M and 16.0M MIST. `PRESALE_LIFECYCLE_GAS_BUDGET_MIST = 500000000` (LAUNCH-DEPLOY) covers a combined settle and migrate more than ten times over.
   - Neither E2E sale was partnered, so the partner payout after an Aftermath migrate is covered by the SDK-equality tests only, not by a mainnet transaction.
   - The lifecycle key needs no new setting: an Aftermath migration splits no fee.
7. **Recapture the generation-2 presale vectors** after the first mainnet sales (the SDK dropped generation 1's).

## 3. Configure blast-infra


blast-infra's generation-2 work is on its branch `sfd/next-presale-gen2-aftermath` (head `5c5baf6` on 2026-10-09); it must be what the engine runs at launch. It needs:

- the generation-2 presale package (`--presale-generation` = original `0x2d300f3d8819c6e09fd1558e518c2ffab97b324479843d4f94b561b10a441fd0`) and the vendor package (`--aftermath-presale-package-id` = `0xac58d338925ac96304ca573a4dab80d442df6f2427291bcddbea7fc65279678e`);
- the agreed list venue `{ kind: "aftermath", vendor_package_id, pool_creation_id | null, lp_type | null, pool_id | null, dao_fee_pool_id | null }` on `GET /v1/presales` and the projection, which the lifecycle worker reads (its `pool_creation_id` says where the sale's `PoolCreation` is; the worker checks it on chain);
- `chain_read_v1.presales.venue` = `aftermath` for the vendor's witness. Until then the social app's `SHOWN_PRESALES` leaves Aftermath sales out (it hides a sale with no venue);
- the amended presale contract this branch publishes (`packages/core/src/modules/presale/contracts/schemas`): the Aftermath venue branches, `totals` without `remaining_commitments` (generation 2 has no such total; `participants` counts down as wallets claim), the generation-2 abort names (with `EInvalidHardCap` and `EMissingSetting`), the sale-level `hard_cap` (`{ starts_after_ms, closes_when_filled }`, no longer on `uncapped`), `windows.hard_cap_from_ms`, and a nullable CLMM tier (`tick_spacing`, `pool_fee_rate`);
- **early close (ADR 0110):** after a sale closes early, `windows.end_ms` and `liquidity_deadline_ms` on the list and the projection, and `chain_read_v1.presales.end_ms`, must be the ACTUAL ones `PresaleFunded` carries. The social app's countdowns, "live" filter and notifications read `end_ms` from there; the lifecycle worker follows the chain itself;
- **tiers (ADR 0111):** `venue_config::PoolTierReserved<Meme, Quote, Venue>` (no `presale_id`, emitted before `PresaleCreated`, keyed by the sale token) fills the venue's tier; an Aftermath sale has none.


## 4a. In-app trading of Aftermath coins

An Aftermath coin trades in the app like a Cetus or Bluefin coin: Buy and Sell, its quote, dry run, Blast's fee, slippage, sponsorship and receipt (`SOCIAL_TRADE_VENUES` includes `aftermath`). The Cetus aggregator does not route DAO-fee pools, so the trade path calls the pool's wrapper directly: `swap::swap_exact_in` of Aftermath's DAO-fee package (`apps/web/src/modules/social/trades/aftermath.ts`). USDC or SUI that is not the pool's own quote coin goes through the aggregator first or after, with no fee of its own. Blast's fee is split from the final output and sent to `BLAST_TRADE_FEE_RECEIVER` in the same transaction. A quote reads the pool, its wrapper and Aftermath's protocol fee vault from the fullnode; on mainnet its figures equal the chain's to the atom.

- **Nothing to configure.** `PRESALE_SPONSOR_SWAP_TARGETS` is unchanged: the sponsor pins the DAO-fee call whole in code (`packages/core/src/modules/presale/sponsor/aftermath-dao.ts`: the package, the function, and every shared object except the pool). Only the trade intent admits it, and Blast's fee may go to its receiver only in a kind that calls it.
- **If Aftermath upgrades** the DAO-fee package or moves one of its objects, Aftermath trades are refused (the dry run, or the sponsor) until both pin files are updated and reviewed.
- **The fee a buyer pays** on a Blast DAO-fee pool is the sale's DAO fee (2%), Aftermath's protocol fee (0.05% of what is left), and the pool's own swap fee (0.01%), plus Blast's 0.3%. The quote's `fee_bps` shows the first three compounded.
- **Price, chart and trades** of an Aftermath coin come from blast-infra's decoding of the pool's swaps (branch `sfd/next-presale-gen2-aftermath`), as for Cetus and Bluefin.

## 5. Product decision (owner, 2026-10-08)

- **Creators choose launch timing in Launch.** "When target is reached" sets a hard cap from the start and permits immediate settlement and migration, independently of wallet limits. "At scheduled end" waits for the full sale window, including when a final-phase hard cap stops further contributions. New and older drafts default to the scheduled end. The wallet that fills an early-closing sale can commit, settle, migrate and buy from the new pool in one transaction.

## 6. Known gaps, not in this release

- **Partner payout after migration:** the lifecycle relayer pays a partnered sale's partner in its own migration PTB on every venue (`pay_protocol_fees_with_partner` after the venue's `migrate`). A sale migrated without the payout (someone's bare migrate, or a payout the relayer dropped so the migration could land) only raises `partner_unpaid:<id>`; the relayer does not yet pay it on its own (a `pay-partner` shape needs a record state or column for its digest and discovery of migrated sales). Until then an operator pays it by hand ([runbook](../presale/runbooks/manual-settle-migrate.md#paying-a-partner-after-migration-partner_unpaidid)).
- **Commit change under a hard cap:** from the cap's start, a commit takes only what is left of the raise and returns the rest as change (`previewCommit(...).change`). The SDK already sends it back; the commit quote does not show it yet.
- **Open-sale countdowns** for a sale that closes when filled still count to the scheduled `end_ms`: it may close sooner.
- **Claim delivery stays disabled** (owner, 2026-10-07). Its guard follows generation 2's `claim(presale, participant, clock)` but is not registered.
- **Launchpad `LpVault`:** the SDK decodes ADR 0107's partnered layout (`partner_id`, `unpaid_protocol_*`). A vault of migrators published from `442116a` lacks those fields, so the migrated-coin trade reads would fail on it: this is the same launchpad upgrade as in section 2, step 3.
