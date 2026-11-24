# Cetus creation compatibility

_Checked 2026-10-16 against first-party documentation, SDK sources, contract interfaces, and Blast's recorded mainnet fork._

Blast must check reservation eligibility for the selected quote and tick spacing. When creating the presale, Blast creates a fresh token's `PoolCreationCap` and calls `register_permission_pair<Meme, Quote>`. The historical presale adapter and launch migrator are in `blast-v2-contracts` at `4b57bc502ac9101d8893219a220dc5c85be4a251`, under `sui/presale/sources/cetus.move` and `sui/migrators/sources/cetus.move`.

## Authoritative configuration

The official interface defines `PermissionPairManager.allowed_pair_config` as `Table<TypeName, VecSet<u32>>`, alongside pair/cap reservation indexes. `GlobalConfig.fee_tiers` separately maps tick spacing to a fee tier. Intersect the quote's permitted spacings with registered tiers, then with the frontend's supported fee-to-spacing mappings. Cetus explicitly allows fee rates to change and permits multiple spacings to share a fee, so a static fee list alone cannot validate the quote. Sources: [factory interface](https://github.com/CetusProtocol/cetus-clmm-interface/blob/5ef409e5aa97cf0c545c5ff64560cb65eaa981e7/sui/cetus_clmm/sources/factory.move), [configuration interface](https://github.com/CetusProtocol/cetus-clmm-interface/blob/5ef409e5aa97cf0c545c5ff64560cb65eaa981e7/sui/cetus_clmm/sources/config.move).

The SDK's official error reference independently identifies reservation failures for a quote absent from the allowed-pair table (factory error 7) and a spacing absent from that quote's entry (error 8). Existing reservations, duplicate caps, and cap/coin mismatches are separate failures. Source: [CLMM contract errors](https://github.com/CetusProtocol/cetus-sdk-v2/blob/926855d314de45d8cd4409e33de114d3cb12dd4c/packages/clmm/docs/error_code.md).

## SDK findings

- The original SDK's `Pool.createPoolTransactionPayload` builds general pool creation with liquidity. Its source does not read the reservation allowlist. Source: [original pool module](https://github.com/CetusProtocol/cetus-clmm-sui-sdk/blob/bb37cda30d5aca63c2398e6886a1701cca1cf87d/src/modules/poolModule.ts).
- The v2 monorepo's legacy `clmm` package similarly exposes `createPoolPayload`/`createPoolRowPayload` without a reservation-permission reader. Source: [legacy CLMM pool module](https://github.com/CetusProtocol/cetus-sdk-v2/blob/926855d314de45d8cd4409e33de114d3cb12dd4c/packages/clmm/src/modules/poolModule.ts).
- The newer `clmmV2` package has `Config.getFeeTiers`, but it reads a dynamic-field fee-tier table with additional dynamic-fee fields. It is a different configuration ABI from the `GlobalConfig` VecMap used by Blast's pinned Cetus deployment, and still does not answer legacy quote-reservation eligibility. Source: [CLMM V2 config module](https://github.com/CetusProtocol/cetus-sdk-v2/blob/926855d314de45d8cd4409e33de114d3cb12dd4c/packages/clmmV2/src/modules/configModule.ts).

Reading the existing deployment's objects through Blast's existing Sui client avoids adding an SDK dependency that does not supply the required permission check. This is an implementation conclusion from the inspected SDKs, not a claim that Cetus's APIs can never add such a reader.

## Encoding and deployment details

`TypeName` wraps an ASCII string. Struct names use full-width lowercase hexadecimal addresses without `0x`; for the four simple quote structs currently offered by the form, BCS-encoding the normalized quote type after removing its leading `0x` matches the Move key representation. Generic type arguments would require normalizing every embedded address too. Source: [Sui `type_name.move`](https://github.com/MystenLabs/sui/blob/main/crates/sui-framework/packages/move-stdlib/sources/type_name.move).

At the same contracts revision, `sui/launchpad/ptb_tests/fork/fetch.py` resolves the manager from the pools object's `permission_pair_manager` string dynamic-object field, then reads quote `TypeName` keys from `allowed_pair_config`. The adjacent `snapshot/manifest.json`, checkpoint 326297561 on 2026-09-24, records different defining packages for the two object types:

| Object | Defining package |
| --- | --- |
| `config::GlobalConfig` | `0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb` |
| `factory::PermissionPairManager` | `0x157468379cfe5616c063ae39a889dd184ad48350d3e08f8d9b4ade22b8e3fb61` |

Do not require these types to have the same package address. The collector confirms SUI and USDC permit spacing 200 at that recorded checkpoint; it does not establish today's availability or any other quote's permissions. The frontend and publish endpoint should read current configuration and refuse to infer support when reads fail.

A read-only mainnet check using the implemented reader against `https://fullnode.mainnet.sui.io:443` on 2026-10-16 at approximately 17:09 UTC returned `[tick spacing, fee in millionths]`: SUI `[[200, 10000]]`, USDC `[[200, 10000]]`, USDsui `[]`, and TEST_SUI `[]`. This is an observed configuration result at that time, not a permanent eligibility or migration guarantee.

A follow-up read at approximately 17:15 UTC enumerated all six entries in the reservation table and queried USDsui and WAL directly, using the [official coin types](https://docs.sui.io/onchain-finance/deepbook/deepbookv3/contract-information). Neither USDsui nor WAL had an entry. SUI's entry contained only `[200]`. These are restrictions on Blast's permissioned reservation path, not a list of all quote coins or fee tiers that Cetus trading pools support. The reader accepts additional registered spacings when Cetus adds them; it does not hardcode this observed permission list.

## Limits of the check

The public pool-creation guide describes general creation, coin ordering, and initializable tick bounds; its fee table is documentation, not the reservation allowlist. Source: [Create CLMM pool](https://cetus-1.gitbook.io/cetus-developer-docs/developer/via-sdk/features-available/create-clmm-pool).

The interface also exposes coin allow/deny lists, and the error reference associates coin-admission failure with actual pool creation. Quote/spacing reservation validation therefore does not promise that a later migration will succeed under every future venue policy. Keep the on-chain reservation and migration checks authoritative; do not replace them with frontend validation. Sources: [factory interface](https://github.com/CetusProtocol/cetus-clmm-interface/blob/5ef409e5aa97cf0c545c5ff64560cb65eaa981e7/sui/cetus_clmm/sources/factory.move), [contract errors](https://github.com/CetusProtocol/cetus-sdk-v2/blob/926855d314de45d8cd4409e33de114d3cb12dd4c/packages/clmm/docs/error_code.md).
