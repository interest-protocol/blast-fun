# Runbook: manual claim fallback

> **Claim delivery is disabled (owner decision, 2026-10-07): buyers claim in the app.** The relayer claims for nobody, so the delivery alerts below (`delivery_blocked`, `delivery_overdue`, `claim_unpayable`) are not raised, and a closed sale's record stays `migrated` or `cancelled`. Every buyer claims their own tokens or refund from the app. Use this runbook when a buyer cannot (a broken app, a lost session, an operator asked to help), or to finish a sale for everyone still owed: `claim` is permissionless and always pays the participant. Sections 1 and 2 apply as written; the record's `claim_*` columns, the ledger check in step 0.3 and the relayer behaviour in sections 3 and 4 apply only if delivery is switched back on ([../delivery.md](../delivery.md)).

This runbook is for operators. Use it when claim delivery ([../delivery.md](../delivery.md)) cannot finish a sale, or, while delivery is disabled, when a buyer cannot claim in the app. Signs you need it:

- `delivery_blocked:<id>` that does not clear;
- `delivery_overdue:<id>`: a closed sale not delivered 15 minutes after it closed;
- `claim_unpayable:<id>`: wallets set aside because their own claim cannot be paid (section 4);
- a record left `migrated`, `cancelled` or `unpayable` with an `error_class` that does not change;
- a participant asks for their tokens or refund before delivery reaches them, or (while delivery is disabled) cannot claim in the app.

`blast_presale::claim<S, Q>(presale, participant)` is permissionless. **Anyone can call it for any participant**, and it always pays the participant, never the caller:

- after a migration, the tokens and any refund;
- after a cancellation, the full refund.

The caller pays gas and receives the storage rebate of the removed commitment field.

A participant can claim for themselves from any wallet. An operator can claim for everyone still owed. Network: mainnet. Never use a worker key for a manual call. Sign with an operator wallet that holds only gas.

## 0. Look first

1. Read the record:

   ```sql
   SELECT state, migrated_by, cancel_reason, claim_digest, claim_batches, claim_failures,
          claim_batch_size, claim_blocked_reason, unpaid_wallets, error_class, next_check_at
   FROM presale_lifecycle_records WHERE network = 'mainnet' AND presale_id = '<id>';
   ```

2. Read the chain. The sale must be `Migrated` or `Cancelled`; otherwise `claim` aborts with `EInvalidLifecycle`:

   ```ts
   import { PresaleClient } from "@interest-protocol/blast-sdk/presale";
   const sale = await new PresaleClient(client, identity.presale).getPresale("<id>");
   ```

3. If `claim_digest` is set, look it up on an explorer. **Do not send anything while that transaction may still land.** An open ledger row (`mission_control_worker_submissions`, `resolved_at IS NULL`, job `presale-claim-delivery`) means the same.
4. Find the cause in `error_class` and, when it is `claim-blocked`, in `claim_blocked_reason`:
   - `claim-blocked`, reason `insufficient-gas`: even one claim does not fit the gas budget. Raise `PRESALE_LIFECYCLE_GAS_BUDGET_MIST` (about 0.4–0.5 SUI covers a 100-claim batch; see [../delivery.md](../delivery.md)) and restart the role. The relayer then carries on at the record's `claim_batch_size`. To return to `PRESALE_CLAIM_BATCH`, set the record's `claim_batch_size` to NULL as the table owner.
   - `claim-blocked`, reason `insufficient-coin-balance`: fund the lifecycle key ([relayer-keys.md](relayer-keys.md)).
   - `claim-blocked`, reason `EInvalidLifecycle`: the node does not see the sale as `Migrated` or `Cancelled`. Check the node (step 2).
   - `claim-blocked`, another abort name or `external_abort`: every claim fails the same way. Claim one wallet by hand (section 2) to see the abort.
   - `claim-unpayable` (state `unpayable`): see section 4.
   - `provider-unavailable`: fix the node.
   - `execution-failed`: a batch failed on chain. The relayer backs off and lists afresh. Look up `claim_digest`.
   - `signer-refused`: the claim guard refused the relayer's own batch, for example after an SDK change that alters the bytes. Escalate to engineering. Meanwhile claim by hand.
   - `internal-error`, `no-progress`, `awaiting-chain`, `suspect-recheck` or `commitments-remaining` that does not change: read the role's `presale.delivery.visit` logs for the record.

   Often fixing the cause is enough. Use the manual path only when the relayer cannot finish.

## 1. Who is still owed

The sale's `CommitmentKey` dynamic fields are the only source. Do not use an index or a spreadsheet:

```ts
import { bcs } from "@mysten/sui/bcs";
import { normalizeStructTag } from "@mysten/sui/utils";

const keyType = normalizeStructTag(`${identity.presale.originalPackageId}::blast_presale::CommitmentKey`);
const owed: string[] = [];
let cursor: string | null = null;
do {
  const page = await client.core.listDynamicFields({ parentId: "<id>", cursor, limit: 500 });
  for (const field of page.dynamicFields) {
    if (field.$kind === "DynamicField" && normalizeStructTag(field.name.type) === keyType) owed.push(bcs.Address.parse(field.name.bcs));
  }
  cursor = page.hasNextPage ? page.cursor : null;
} while (cursor);
owed.sort();
```

The commitment of one wallet: `getPresaleCommitment(client, "<id>", wallet, identity.presale.originalPackageId)` from the SDK. It returns null once the wallet is claimed.

## 2. Claim

One PTB can carry many claims of one sale. Keep a batch at 100 or fewer, and halve it if the dry run fails on size or gas:

```ts
import { PresaleTransactions } from "@interest-protocol/blast-sdk/presale";

const tx = new PresaleTransactions(identity.presale).claim({
  memeType: sale.memeType,
  quoteType: sale.quoteType,
  presale: { objectId: sale.objectId, initialSharedVersion: sale.initialSharedVersion, mutable: true },
  participants: owed.slice(0, 100),
});
```

Always dry-run first (`client.core.simulateTransaction`), then sign and execute.

- `ENoCommitment` in the dry run means a wallet in the batch was claimed meanwhile. List again (section 1) and rebuild.
- A participant claiming for themselves uses the same call with `participants: [theirAddress]`.

## 3. After

Repeat sections 1 and 2 until the listing is empty. The relayer's next visit reads the same empty listing, checks that the sale's `participants` (the wallets still holding a commitment, generation 2) is zero, and marks the record `delivered`. It clears `delivery_blocked`, `delivery_overdue` and `claim_unpayable` and sends nothing. Manual and automatic claims never pay a wallet twice: a claimed field is gone, and a second `claim` would abort.

## 4. Unpayable wallets

Use this section for `claim_unpayable:<id>`, or for a record in state `unpayable`.

**What it means.** Each listed wallet's own claim cannot run. For example, after a cancellation every claim pays Quote, and after a migration any wallet with a refund does; a deny-listed USDC recipient fails with `CoinDenyListError`. The relayer delivered everyone else.

**What the relayer does.**
- The set-aside wallets keep their commitment. Nothing is lost, and the contract still owes them.
- The relayer tries them again hourly. The alert repeats meanwhile.
- The record becomes `delivered` once they are paid.

**What to do.**
1. **Read the wallets.** They are in the alert's `wallets` detail, or in the record's `unpaid_wallets`.
2. **Find out why each claim fails.** Dry-run a claim of that wallet alone (section 2 with `participants: [wallet]`), and read the error.
   - `CoinDenyListError` means the Quote's issuer has deny-listed the address. The refund cannot reach it while the deny stands. Nothing on Blast's side can pay it elsewhere: `claim` only pays the participant.
3. **Tell the participant.** Their commitment is safe, and it is paid as soon as their address can receive the coin. They, or anyone, can then claim it (section 2), or the relayer's hourly recheck will.
4. **Do not edit `unpaid_wallets` by hand.** The recheck keeps it in sync with the chain.
