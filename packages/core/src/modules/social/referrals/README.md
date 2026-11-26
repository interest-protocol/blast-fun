# Account referrals and revenue tracking

`/invites` and the owner's profile show the invited people, their referred SUI
volume, Blast revenue and lifetime earnings in SUI, plus the current
referral rate. The standard share is 30% after activation. Approved special
referrers keep 60%.
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

- **Presales:** only funded, non-cancelled SUI sales count accepted volume. Each
  invitee's accepted volume is its commitments divided by all commitments,
  multiplied by accepted quote. Revenue uses the same proportion of actual
  `ProtocolFeesPaid.quote`. Refunded overflow, `partner_quote` and minted token
  allocations are excluded. Funded sales without fee payment retain accepted
  volume and stay pending for revenue. Failed/cancelled sales earn nothing.
- **Bonding curves:** confirmed buys and sells count executed SUI quote volume
  (sell proceeds net of quote fees). Revenue uses swap fees paid to Blast's
  treasury in SUI. Each claim is allocated over its gross SUI quote fee accrual
  window, after the partner's cut where applicable. Creator fees, meme-token
  fees, and separate SUI creation fees are excluded. Graduation accrual
  participates in the denominator, but is not attributed as swap revenue.
  Same-transaction event order is supported. When cross-transaction ordering at a
  boundary checkpoint cannot be proven by the source view, affected fees stay
  pending instead of inheriting another claim's split. Missing launch metadata
  also stays pending. Complete attribution of those ambiguous cases requires an
  upstream transaction-order (`tx_slot`) surface; no split is guessed.
- **Earnings:** unpartnered curve revenue takes the rate at the trade, partnered
  curve revenue at the treasury claim, and presale revenue at fee payment.
  Revenue recognized before the change keeps its 60% share. Integer atoms are
  allocated per invitee and asset. Earnings floor once after summing the weighted
  revenue, and owner totals sum those per-invitee amounts. The submission-time
  USD swap statistic is separate from earnings.

Example: if a sale pays Blast 1 SUI attributable to an invitee, a standard
referrer earns 0.3 SUI after activation. At 60% that revenue earns 0.6 SUI.

## Rollout

Deploy the web app and backend before activating the rate. Both can serve
existing 60% accounting during rollout. Already-open tabs from the previous web
release need a reload to read the 30% rate. To activate, insert the
`referral_rate_policy` row in `social_config` with `effective_at_ms` as a UTC
epoch in milliseconds, `special_account_ids` as an array of approved account
UUIDs resolved from verified X identities, and `special_reservation_codes` as
an array of approved codes tied to verified X identities. An approved
reservation earns 60% from its link before and after claim. For other referral
activity the reservation owner earns 60% from the recorded claim time.
Keep the effective time and approved entries fixed after activation.

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
