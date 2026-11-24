# Migration and vault fee attribution

Verified 2026-10-23. This resolves Blast's reporting policy from contract cash
flows and current primary DefiLlama precedents. These implementation decisions
do not constitute DefiLlama approval or create a project listing. This note
supersedes the migration/vault exclusions in the initial
[requirements research](2026-10-23-defillama-requirements.md).

## Source identities

- DefiLlama dimension-adapters master at verification:
  `5d160889fcae145a2c6e4836cc32a82c5c5b048b` (2026-10-23 08:04 UTC).
- Blast contracts inspected locally at
  `0265cd4e9798b08502afb3994f400f97733d0b92`; comparison with fetched
  `origin/main` `01d7659617abcd552cece6d05b9db409ec4ff2c0` finds no economic
  changes in the relevant migration/fee/vault functions. Unrelated working-tree
  changes were preserved.
- SDK decoder source matches vendored release
  `6a1622f639843aabca62fcb4549249adea3ae73d`.

## Upstream principles and precedents

The [official attribution guide](https://docs.llama.fi/list-your-project/other-dashboards)
distinguishes a yield product's gross yield from performance fees: yield is the
fees measure, retained charges are revenue, and the remainder is supply-side.
That supports publishing a vault-income component without representing the
whole collected amount as an additional management charge.

A particularly close Sui precedent is the current
[Volo vault adapter](https://github.com/DefiLlama/dimension-adapters/blob/5d160889fcae145a2c6e4836cc32a82c5c5b048b/fees/volo-vault/index.ts).
It sums gross yield and charged performance fees from each on-chain
`VaultPerformanceFee` record, recognizes them on the charge event's UTC date,
and reports fees as yield, revenue as performance charges and supply-side as
the difference. The earlier research's old Volo snapshot is superseded by this
implementation. This is evidence for crystallization/collection recognition;
it does not establish the dates of the underlying strategy's trades.

The [Pump implementation](https://github.com/DefiLlama/dimension-adapters/blob/5d160889fcae145a2c6e4836cc32a82c5c5b048b/fees/pumpdotfun.ts)
separately labels token-graduation receipts as fees/revenue. Its launched-coin
cashback is supply-side, while PUMP governance buybacks are holders revenue.
The [Bags adapter](https://github.com/DefiLlama/dimension-adapters/blob/5d160889fcae145a2c6e4836cc32a82c5c5b048b/fees/launch-on-bags/index.ts)
explicitly sets `doublecounted: true` because its launchpad pools overlap
underlying DEX adapters. A Blast contribution containing collected LP yield
should disclose that overlap and use upstream's double-counting mechanism;
this API alone cannot change DefiLlama's adapter configuration.

## Resolved migration policy

[`launch.move::migrate`](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/launchpad/sources/launch.move#L715)
apportions the real quote reserve, pays project recipients, and splits the
protocol allocation into its fee ledger before returning the LP funding.
[`fees.move`](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/launchpad/sources/fees.move#L10)
identifies this as the one-time migration fee.

- Include `ProtocolFeesAccrued.quote_amount` exactly once as an execution-date
  graduation fee in the quote asset. It is an actual reserve charge, distinct
  from LP principal, prior per-trade fees and later fee-ledger withdrawal.
- For a launch without a partner, this quote fee is entirely Blast revenue and
  protocol revenue. For a partnered launch, gross fees remain exact but
  claim-time mutable partner terms leave dependent revenue/supply-side metrics
  unavailable, as for partnered curve execution fees.
- Keep `ProtocolFeesAccrued.meme_amount` as token-issuance allocation evidence.
  It comes from `allocated_meme`, not a new trader debit. A minted allocation
  does not become a user-paid economic fee merely because an event calls it a
  protocol fee. Apply the same exclusion to presale protocol-token issuance.
- A launch's later `ProtocolFeesClaimed` drains creation, swap and migration
  accruals together. It is settlement evidence and never another fee.

[`migrators::vault`](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/migrators/sources/vault.move#L53)
also has a `ProtocolFeesClaimed` event, but this withdraws the separately stored
migration LP residuals. `VaultCreated.residual_*` is the venue's unspent LP
funding handoff, as shown by
[`cetus.move`](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/migrators/sources/cetus.move#L140).
Recording/withdrawing that principal does not prove another service charge;
keep both facts as evidence, outside graduation fees and collected LP yield.

## Resolved vault policy

Include the gross amounts from native `FeesCollected` as **collected LP yield**,
on the collection's UTC date, separately for presale vaults and launchpad
migrator vaults. Include only the custodied position's recorded collection,
not every trade or fee in its external pool. It adds no Blast swap volume.
Amounts are native atoms; no API-side USD price or scaling is required.
This is a deliberate collection-basis reporting policy, inferred from Blast's
cash flows and the above yield precedent. It is not an assertion that the LP
income was earned by swaps on the collection date.

### Presale vaults

[`presale_vault.move::split_fees`](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/presale/sources/presale_vault.move#L248)
charges the current protocol share, pays the immutable recipients and treats
the remaining Meme and Quote differently. Do not infer attribution solely
from the `holder_rewards_*` field names:

| Asset | Fully attributed treasury revenue | Supply-side allocation |
| --- | --- | --- |
| Meme | `protocol_meme + holder_rewards_meme` | Sum of `fee_recipient_meme` |
| Quote | `protocol_quote` | Sum of `fee_recipient_quote` plus `holder_rewards_quote` |

The entire remaining Meme is paid to `fee_policy.destination()` (the governed
treasury), and `HolderMemePaid` records that transfer. It is treasury revenue,
not launched-coin-holder supply-side or Blast governance holders revenue.
Only the remaining Quote joins the vault's holder-reward balance. The native
[reserve rewards test](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/presale/tests/reserve_rewards_tests.move#L579)
checks the Meme treasury transfer explicitly. `HolderMemePaid` is an audit fact,
not a second fee/revenue recognition.

For each asset require:
`gross = protocol + sum(fee_recipient) + holder_rewards`.
When `protocol_destination` is null and protocol amount is positive, that
protocol slice is held for a mutable future partner split. Gross income and
known allocations stay exact, but the component's aggregate supply-side,
revenue and protocol revenue are unavailable. The known treasury Meme amount
must remain separately visible in evidence. A null destination with zero
protocol amount does not make otherwise known amounts unavailable.

### Launchpad migrator vaults

[`migrators::vault::split_fees`](https://github.com/interest-protocol/blast-v2-contracts/blob/0265cd4e9798b08502afb3994f400f97733d0b92/sui/migrators/sources/vault.move#L222)
records gross income, protocol share, creator accrual, auto-LP allocation,
launched-coin rewards, burns/buyback allocation and ordinary recipient amounts.
For each asset require:

`gross = protocol + creator + auto_lp + rewards + burn + sum(recipient)`.

The protocol slice is revenue when paid directly. All the other classes are
project/creator/recipient/coin-holder supply-side allocations, including
reinvestment and burn allocations for the launched coin. They do not fund
Blast's own governance tokenholders. Keep each class in evidence, even when its
later cash distribution occurs on a different day. A positive protocol slice
with null destination again has unavailable net attribution because of the
future mutable partner split.

`ProtocolLpFeesPaid` (presale) and `ProtocolLpFeesClaimed` (migrators) settle
previously collected protocol slices. Creator/reward claims, auto-LP additions,
and later launched-coin buyback burns similarly consume already classified
allocations. They must not add gross fees or replay the prior revenue/expense.

## Implementation requirements

The pinned
[SDK migrator event module](https://github.com/interest-protocol/blast-v2-sdk/blob/6a1622f639843aabca62fcb4549249adea3ae73d/src/migrators/events.ts)
provides `decodeMigratorEvent`, `migratorEventBcs` and exact native bigint fields.
Migrator `blast_events` types are non-generic; resolve their asset types from
`VaultCreated.meme`/`.quote`, using the vault ID for later collections. Authenticate
the event type's original package identity, not the called package/module.
Missing vault identity, invalid BCS or a failed reconciliation must prevent a
complete publication, not silently omit fees.

Source discovery must include the reviewed migrator original package(s) and
history from before every required package's deployment. Include those package
identities and the changed accounting methodology in snapshot identity so old
partial-scope snapshots cannot serve the expanded feed. Metadata must state
collection basis, asset-specific treasury classification, DEX overlap, and the
remaining deliberate exclusions (token issuance, residual principal and
settlements). These are resolved economic exclusions, not missing fee totals.

Production deployment/backfill and DefiLlama adapter submission remain separate
release actions. No production reads, migrations or upstream submissions were
performed for this research.
