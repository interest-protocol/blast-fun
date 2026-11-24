# Account referrals and revenue tracking

`/invites` and the owner's profile show the invited people, their referred
volume, Blast revenue and cumulative 60% earnings, separated by native coin.
Both private APIs derive the owner from the authenticated session; per-person
aggregates are visible only to that owner. No payout, paid/unpaid balance,
wallet collection or transfer execution is implemented. Operators pay monthly
outside this feature. Earnings are lifetime accrued totals, not an unpaid balance.

## Reserved X identities

Migration `0143_x_referral_revenue` seeds reservations, without creating fake
users. Link codes are case-insensitive and permanently tied to the numeric X ID:

| Account | Referral code | X ID |
| --- | --- | --- |
| Kaleo | `cryptokaleo` | `906234475604037637` |
| Minh | `minhxdynasty` | `1310378599984148480` |
| Marty Party | `martypartymusic` | `22506165` |
| Kyle Chassé | `kylechasse` | `1187664208160124930` |
| Irene Zhao | `irenezhao_` | `1366964220768776192` |
| Mayne | `tradermayne` | `2446024556` |

Links use `https://blast.fun/?ref=<code>`. The actual site's origin is used when
copying. Public profile mirrors supplied the IDs; direct X profile access was
blocked during verification. Authenticated Privy X subjects, never handles, prove
ownership when claiming. Renaming an X or Blast account does not redirect its
reserved link. Existing uniquely matched accounts claim during migration;
ambiguous duplicate X identities require operator resolution. Reservations and
existing account aliases are checked for conflicts before migration proceeds.

A secure HttpOnly cookie retains the latest valid link visited for 30 days.
Signup records an immutable reservation reference, even before the KOL signs up.
The verified KOL account claims that reservation on creation or X refresh. Its
pre-signup invitees immediately belong to its private report. Existing accounts
cannot acquire or change a referrer. Known self-referrals are excluded. Legacy
Mission Control and callsign referrals remain included and deduplicated.

## Accounting

The existing social worker decodes confirmed native receipts through the pinned
SDK and `chain_read_v1.transaction_evidence`, inside its repeatable-read cut.
Each scan covers at most 1,000 checkpoints and returns at most 64 configured-package receipts. Sparse history advances through bounded checkpoint windows using the native header’s timestamp.
The event key `(digest,event_index)` prevents replay double counting. Published
checkpoint and timestamp advance together after completing a cut. No chain
scan runs on a page request. Wallets must have unambiguous proven ownership;
activity predating either signup attribution or wallet verification is excluded.

- **Presales:** only funded, non-cancelled sales count accepted volume. Each
  invitee's accepted volume is its commitments divided by all commitments,
  multiplied by accepted quote. Revenue uses the same proportion of actual
  `ProtocolFeesPaid.quote`. Refunded overflow, `partner_quote` and minted token
  allocations are excluded. Funded sales without fee payment retain accepted
  volume and stay pending for revenue. Failed/cancelled sales earn nothing.
- **Bonding curves:** confirmed buys and sells count executed quote volume
  (sell proceeds net of quote fees). Revenue is charged protocol fees, excluding
  creator fees. Fees in different coins remain separate. For unpartnered launches,
  the fee charged by each swap counts immediately as revenue generated; it need
  not already have been transferred to the treasury. For partnered launches,
  net Blast revenue waits for the actual claim's treasury/partner split and is
  allocated proportionally over that claim's gross fee accrual window. Graduation
  accrual participates in the denominator, but is not attributed as swap revenue.
  Same-transaction event order is supported. When cross-transaction ordering at a
  boundary checkpoint cannot be proven by the source view, affected fees stay
  pending instead of inheriting another claim's split. Missing launch metadata
  also stays pending. Complete attribution of those ambiguous cases requires an
  upstream transaction-order (`tx_slot`) surface; no split is guessed.
- **60% earnings:** integer atoms throughout. Presale commitments are aggregated
  per invitee/sale before allocation; proportional divisions floor to coin atoms.
  Earnings floor once per invitee/coin from allocated revenue × 6000 / 10000.
  Owner totals sum those same per-invitee amounts. Allocation dust is never
  overpaid. The existing submission-time USD swap statistic remains in the API
  for compatibility and is never used to calculate earnings.

Example: a follower commits 100 SUI, all 100 is accepted, and the successful
sale pays 1 SUI to Blast: volume 100, revenue 1, earnings 0.6 SUI. If 80 SUI is
accepted and 20 refunded, and Blast receives 0.8 SUI, earnings are 0.48 SUI.

## Rollout

Apply migration `0143` before deploying the APIs. Configure the existing social
worker's `SOCIAL_REFERRAL_PROFILE` as a JSON object with `network` (`mainnet`),
`deployment_fingerprint` (64 hex characters), `launchpad_original_package`
(full normalized package ID, or null for a presale-only deployment),
`presale_original_package` and `core_original_package` (full normalized package
IDs), and `first_checkpoint` (decimal string at or before the first deployed
receipt, and not before intake's first checkpoint). Values must come from
the verified deployment, not UI inputs. Its network and fingerprint must match
`BLAST_NETWORK` / `BLAST_DEPLOYMENT_FINGERPRINT`. Intake must cover the entire
configured history. Presale-only deployments require presale coverage; a configured
launchpad additionally requires market coverage. Do not use a placeholder launchpad
package ID. Adding a launchpad later changes the pinned profile and requires a
deliberate complete ledger rebuild.
The profile is pinned in worker state; any change requires a deliberate ledger
rebuild, rather than silently mixing deployments. The migration aborts on a
reserved-code collision, so resolve any actual conflict explicitly first.

### Rebuilding after a profile change

Until the pinned cursor changes, `referral-accounting` fails every pass with
"explicit ledger rebuild required". For a new deployment whose checkpoints all
follow the existing ledger, keep the ledger and move only the cursor, immediately
before deploying the new profile. Save the old row first.

```sql
UPDATE social_worker_state
SET value = jsonb_build_object(
  'profile', '<new profile JSON>'::jsonb,
  'checkpoint', '<first_checkpoint - 1>', 'digest', '',
  'complete_checkpoint', '<first_checkpoint - 1>', 'as_of_ms', value->'as_of_ms')
WHERE name = 'referral-accounting';
```

Existing `social_referral_events` stay below the new cursor, so lifetime totals
are unchanged. The worker then scans forward 1,000 checkpoints a pass. Delete
ledger rows as well only when the old rows are wrong, because that removes
earnings already recorded for those deployments.

Without a configured/caught-up worker, the UI reports that revenue tracking is
syncing. It never presents an unobserved zero. Keep monthly payments manual; this feature records attribution and cumulative
earnings without executing transfers.
