# DefiLlama requirements and Blast accounting verification

Verified 2026-10-23 against official documentation and first-party adapter/SDK
source. This records requirements and recommendations; it does not constitute
DefiLlama approval of a Blast listing or accounting methodology.

The migration/vault recommendations below record the initial conservative
scope. They are superseded by the resolved policy and newer primary-source
evidence in [migration and vault attribution](2026-10-23-defillama-migration-vault-attribution.md),
implemented as methodology `blast-defi-v2`.

Source snapshot: `dimension-adapters` master
`6d21babf50ca5ceb76d2ebde7b288c2d8ac56206`; `defillama-sdk` master
`e9435a0796147030dafa5b5a150d999e9bcf0a47`. Local contract inspection used
`blast-v2-contracts` HEAD `0265cd4e9798b08502afb3994f400f97733d0b92`.

## Verified integration requirements

- Endpoints supply contributed adapters; they do not create a listing. TVL and
  dimensions have separate repositories. TVL must be derived from blockchain
  balances, so contract discovery is useful but self-reported aggregate TVL is
  insufficient. [TVL repository](https://github.com/DefiLlama/DefiLlama-Adapters),
  [submission workflow](https://docs.llama.fi/list-your-project/submit-a-project.md).
- A public, unauthenticated API is **not a universal requirement**. Current
  provider adapters use runner environment secrets through `getEnv`: GateSwap
  sends `X-DefiLlama-Api-Key`, DefiApp sends `X-API-KEY`. A new Blast secret would
  need upstream environment-key allowlisting and runner provisioning. Existing
  partner authentication is technically compatible; its secret is not already
  provisioned merely because the endpoint exists.
  [GateSwap helper](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/helpers/gateswap.ts),
  [DefiApp adapter](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/aggregators/defiapp/index.ts),
  [environment allowlist](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/helpers/env.ts).
- New dimensions adapters prefer version 2 arbitrary intervals. Version 1
  remains supported for daily-only external APIs and Dune. Both use
  `fetch(options: FetchOptions)` now, rather than the former three arguments.
  Source labels, methodology and applicable supply-side breakdowns are expected.
  Raw token balances are preferred over project-valued USD.
  [official dimensions guide](https://docs.llama.fi/list-your-project/other-dashboards.md),
  [repository agent guidance](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/AGENTS.md).
- Upstream encourages blockchain data, especially for teams maintaining their
  own indexers. A protocol API remains a source subject to review, not an
  automatic exemption from reproducibility. Cetus itself supplies Sui daily
  fee totals through a protocol API with timestamp bounds.
  [repository guidance](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/AGENTS.md),
  [Cetus fee adapter](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/cetus/index.ts).

### Sui raw token identifiers

With `options.createBalances()` on Sui, add the **unprefixed Move coin type**:

```ts
const dailyFees = options.createBalances()
dailyFees.add('0x2::sui::SUI', atomicAmountString, 'Curve Swap Fees')
```

The helper adds `sui:` itself. Passing `sui:0x2::sui::SUI` to ordinary `.add`
would produce a duplicate prefix. For an already-qualified identifier, explicitly
use `{ skipChain: true, label: 'Curve Swap Fees' }`, or strip the one chain prefix.
Keep atomic amounts as decimal strings and preserve Move module/struct case.
SUI's official core-asset entry is `0x2::sui::SUI`; a full normalized address in
the API can be mapped to that identifier in the adapter.
[SDK Balances](https://github.com/DefiLlama/defillama-sdk/blob/e9435a0796147030dafa5b5a150d999e9bcf0a47/src/Balances.ts),
[SDK sumSingleBalance](https://github.com/DefiLlama/defillama-sdk/blob/e9435a0796147030dafa5b5a150d999e9bcf0a47/src/util/common.ts),
[core assets](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/helpers/coreAssets.json).

## Verified accounting distinctions

The guide defines gross economic fees, supply-side costs, and net revenue.
Creator, LP, partner and referrer allocations are supply-side. Own governance
token buybacks/burns/distributions belong to holders revenue. Holders revenue is
also an off-statement measure that can include external holder flows; therefore
`revenue = protocolRevenue + holdersRevenue` is not a universal invariant.
[official dimensions guide](https://docs.llama.fi/list-your-project/other-dashboards.md).

Current Pump code expressly classifies cashback for holders/traders of a
**launched coin** as supply-side and PUMP buybacks as holders revenue. Its
holders number covers multiple products and deliberately does not reconcile
with that adapter's protocol revenue. Use `fees = supplySideRevenue + revenue`
for a fully attributed included scope; do not impose the second equation as a
general DefiLlama rule.
[Pump fee implementation and methodology](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/pumpdotfun.ts).

LaunchLab computes fees from trade events: protocol, launch platform and creator
amounts are additive; only Raydium's own cut is Raydium revenue. Platform/creator
amounts are supply-side even though they are claimed later. Launch-on-Bags
includes identifiable creation-fee receipts and source labels, while explicitly
flagging overlapping underlying DEX accounting as `doublecounted`.
[LaunchLab](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/launchlab/index.ts),
[Launch-on-Bags](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/launch-on-bags/index.ts).

Pump volume counts one quote-asset amount per bonding-curve trade. Its fees
adapter does not blindly combine API figures that also contain PumpSwap fees.
This supports explicit product attribution, not a blanket rule forbidding all
post-graduation launchpad reporting.
[Pump curve volume](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/dexs/pumpfun.ts),
[Pump fee attribution](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/pumpdotfun.ts).

## Proposed Blast mapping after local contract inspection

These are Blast implementation recommendations, distinguished from upstream
facts above. The existing API design is at
[defillama-api-design.md](../launchpad/defillama-api-design.md).

| Economic fact | Recommended API/adapter treatment |
| --- | --- |
| Completed Blast curve execution | One quote-side volume amount, raw native fee deltas. Opening pot counts once; delivery allocations do not add a trade. |
| Creation payment | Include an actual proved economic payment once; a configured price alone is insufficient. Claiming an already accrued fee is not another creation fee. |
| Presale raised principal, refunds, token delivery | Not swap volume or fee income. |
| `ProtocolFeesPaid.quote` and `.partner_quote` | They are separate net-Blast and partner amounts. Fee total is their sum; partner is supply-side. Do not subtract partner from `quote` again. |
| `ProtocolFeesPaid.tokens`, minted migration allocations | Keep visible as evidence separately; exclude from submitted economic fee totals until valuation and user-payment treatment are established with upstream. Minting an allocation alone does not demonstrate a user-paid fee. |
| Curve `ProtocolFeesAccrued` at migration | Reserve/token allocation facts, excluded from the initial published fee scope pending economic attribution and minted-token valuation review. Do not categorically describe the quote allocation as non-fee principal: the contract explicitly calls this a one-time migration fee. |
| Venue swaps after migration | Attribute to Cetus/Bluefin/Aftermath execution. Do not automatically add every launched-token venue trade to Blast DEX volume. A separate launchpad-owned/overlapping scope needs explicit methodology and, where applicable, upstream double-counting treatment. |
| `FeesCollected` | Collection-period LP income facts; gross amounts and recipient breakdowns are useful. They do not prove the underlying swaps happened on the collection date. |
| Launched-coin holder reward allocation | Supply-side recipient class, not Blast governance holders revenue. A later holder payout settles the recorded allocation and is not another fee. |
| `ProtocolLpFeesPaid` | Settlement of prior collected protocol fee balance; expose exact net Blast and partner payouts without adding them again to gross fees. |

The presale payout function calls `partner.pay` before `pay_protocol_fees` and
passes the reduced balance plus the separately returned partner amount. Vault
collection events separately record gross, protocol, ordinary recipients and
holder allocations; partnered protocol amounts are accumulated and paid later.
[presale contract](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/presale/sources/blast_presale.move),
[presale vault](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/presale/sources/presale_vault.move),
[migrator vault](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/migrators/sources/vault.move).

Specifically, curve migration apportions the actual quote reserve, splits its
protocol allocation into the fee ledger and emits `ProtocolFeesAccrued`. This
is not another swap, but may be an eligible migration/graduation fee: Pump's
methodology includes graduation fees. An initial API can accurately publish a
clearly named subset while exposing exclusions. It should not advertise that
subset as all protocol fees, and upstream completeness/acceptance remains
unresolved until the migration component is adjudicated.
[launch migration](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/launchpad/sources/launch.move),
[fee ledger](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/launchpad/sources/fees.move),
[Pump graduation fee methodology](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/pumpdotfun.ts).

### Mutable partner terms and recognition date

Blast curve `claim_protocol_fees_with_partner` drains the protocol ledger and
calls the **then-current Partner** to split meme, quote and SUI. That ledger
also receives creation and migration fees. Vault partner claims similarly drain
accumulated balances. Consequently, trade-time terms alone do not prove the
ultimate retained fee, and a later claim can aggregate multiple dates/components.
[launch contract](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/launchpad/sources/launch.move),
[presale vault](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/presale/sources/presale_vault.move).

Recommended implementation: publish fully covered execution `fees` and `volume`.
Publish revenue/supply-side only when the entire included scope is attributed.
When any partnered accrued fee has an indeterminate future allocation, mark the
dependent metrics unavailable with a precise reason; preserve known allocations
and claim-time payouts as separate evidence. Do not silently treat unknown
partner liability as zero, use current terms historically, or claim daily payout
amounts reconcile with that day's execution fees. Omit unavailable adapter fields
or fail the applicable adapter; never translate unavailability into zero.

A collection-basis view can expose exact realized cash facts. That is a separate
recognition policy requiring upstream agreement if used as daily fees/revenue.
Volo's Sui adapter recognizes performance-fee **charges** from on-chain helper
events; that is a useful collection/crystallization precedent, but not proof
that delayed withdrawal of previously earned swap fees should be relabeled as
new same-day fees. LaunchLab's execution accounting is the closer swap analogue.
[Volo vault](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/volo-vault/index.ts),
[LaunchLab](https://github.com/DefiLlama/dimension-adapters/blob/6d21babf50ca5ceb76d2ebde7b288c2d8ac56206/fees/launchlab/index.ts).

## TVL boundaries and remaining upstream decisions

Actual contributed assets locked in protocol contracts are the starting point.
Virtual reserves, unissued inventory, and merely minted allocations must not
inflate TVL. Externally migrated pools require custody/ownership and double-count
analysis; a launchpad registry entry does not establish ownership of an entire
venue pool. Refundable, raised, fee and reward balances should be separately
discoverable, with native amounts verified on-chain. These are conservative
Blast mapping recommendations under the upstream TVL definition, not an accepted
Blast-specific calculation.
[TVL inclusion rules](https://docs.llama.fi/list-your-project/what-to-include-as-tvl.md),
[TVL repository requirements](https://github.com/DefiLlama/DefiLlama-Adapters).

Before upstream submission, resolve: dedicated credential provisioning; whether
a partner-only API is accepted for this project's scale/source circumstances;
execution-versus-realized attribution for mutable partner splits; LP collection
product scope and underlying-DEX overlap; treatment/valuation of minted token
allocations; exact TVL custody and own-token exclusions; and the start date backed
by complete historical coverage. Existing adapter precedents establish supported
mechanisms and classifications, not preapproval of these project-specific choices.
