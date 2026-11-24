# Runbook: manual settle and migrate, and the cancel after the deadline

This runbook is for operators. Use it when the lifecycle relayer ([../lifecycle.md](../lifecycle.md)) cannot settle or migrate a sale. Signs you need it:

- `lifecycle_overdue:<id>`: settle is more than 60 s late;
- `migrate_blocked:<id>` that does not clear;
- `deadline_near:<id>`: 24 h left before anyone may cancel the funded sale.

`settle`, `migrate` and `cancel_unlaunched` are permissionless. Any funded wallet can send them; no capability is needed. Network: mainnet. Never use a worker key for a manual call. Sign with an operator wallet that holds only gas.

## 0. Look first

1. Read the record:

   ```sql
   SELECT state, settled_by, migrated_by, settle_digest, migrate_digest, migrate_attempts,
          blocked_abort, blocked_location, blocked_code, error_class, next_check_at
   FROM presale_lifecycle_records WHERE network = 'mainnet' AND presale_id = '<id>';
   ```

2. Read the chain. The chain decides, not the record:

   ```ts
   import { PresaleClient } from "@interest-protocol/blast-sdk/presale";
   const presales = new PresaleClient(client, identity.presale); // identity: PRESALE_DEPLOYMENT_MANIFEST
   const sale = await presales.getPresale("<id>");
   // sale.lifecycle, sale.endMs, sale.totalCommitments, sale.raiseTarget, sale.liquidityDeadlineMs, sale.migrationWitness
   ```

3. If `settle_digest` or `migrate_digest` is set, look it up on an explorer. **Do not send anything while that transaction may still land.** The relayer's own ledger row (`mission_control_worker_submissions`, `resolved_at IS NULL`) means the same.
4. Find the cause in the record's `error_class` and `blocked_abort`:
   - `insufficient-gas`: fund the lifecycle key ([relayer-keys.md](relayer-keys.md)). This is also `blocked_abort` when the gas budget is too small for a migration.
   - `insufficient-gas` with the sale settled: the key's address balance holds the gas budget but not the Bluefin fee as well. Fund it ([relayer-keys.md](relayer-keys.md)).
   - `provider-unavailable`: fix the node.
   - `execution-failed`: a settle simulated but failed on chain. The relayer backs off and settles alone. Look up `settle_digest`.
   - `blocked_abort`: see section 3.

   A blocked pass is not in the record. Examples are an unreachable node at the identity check, another chain, or an open mainnet release gate. Its reason is in `mission_control_worker_jobs.blocked_reasons` for the job `presale-lifecycle-relay`, and in the role's `worker.config_blocked` log lines, for example `deployment-unavailable` or `release-gate-open`. During such a pass `lifecycle_overdue` still fires, and `job_stalled` follows after 5 minutes.

   Often fixing the cause is enough, and the relayer closes the sale on its next pass. Use the manual path only when the relayer cannot.

## 1. Settle (lifecycle `Open`, `now >= end_ms`)

With the raise met, settle and migrate in **one** PTB, so a funded sale never sits unmigrated:

```ts
import { PresaleCalls } from "@interest-protocol/blast-sdk/presale";
import { Transaction } from "@mysten/sui/transactions";

const calls = new PresaleCalls(identity.presale);
const types = { memeType: sale.memeType, quoteType: sale.quoteType };
const presale = { objectId: sale.objectId, initialSharedVersion: sale.initialSharedVersion, mutable: true as const };
const tx = new Transaction();
tx.add(calls.settle({ ...types, presale }));
// then the venue's migrate (section 2), added to the same `tx`
```

With the raise missed, or with the migration known to be blocked, send `settle` alone: `new PresaleTransactions(identity.presale).settle({ ...types, presale })`. A missed raise is then `Cancelled`, and participants are refunded through claims, which the relayer delivers ([../delivery.md](../delivery.md); by hand: [manual-claim.md](manual-claim.md)). A met raise is `Funded`; migrate next.

Always dry-run first (`client.core.simulateTransaction`), then sign and execute.

## 2. Migrate (lifecycle `Funded`)

The venue is the sale's recorded migration witness. `calls.migrationWitnessType("cetus")` or `("bluefin")` equals `sale.migrationWitness`.

**Cetus.** Pass the identity's Cetus objects:

```ts
const cetus = identity.venues.cetus!;
tx.add(calls.migrateCetus({
  ...types, presale,
  cetusConfig: { ...cetus.globalConfig, mutable: false },
  cetusPools: { ...cetus.pools, mutable: true },
  burnManager: { ...cetus.burnManager, mutable: true },
}));
```

**Bluefin.** Pay exactly Bluefin's current SUI pool-creation fee (`config::get_pool_creation_fee_amount<SUI>`). Read it just before you build. Bluefin aborts on any other amount.

1. **Read the fee** from the identity's Bluefin `GlobalConfig`, with nothing but the SDK and `@mysten/sui`:

   ```ts
   import { bcs } from "@mysten/sui/bcs";
   const field = (parentId: string, key: string) =>
     client.core.getDynamicField({ parentId, name: { type: "0x1::string::String", bcs: bcs.string().serialize(key).toBytes() } });
   const table = (await field(identity.venues.bluefin!.globalConfig.objectId, "pool_creation_fee")).dynamicField.value;
   const tableId = bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }).parse(table.bcs).id;
   const entry = (await field(tableId, "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI")).dynamicField.value;
   const fee = BigInt(bcs.u64().parse(entry.bcs));
   ```

   If a field is missing, Bluefin's configuration has changed. Stop and investigate; never guess the fee.
2. **Read the currencies.** Each is the shared `Currency<T>` at its Coin Registry address. Get the address with `deriveObjectID("0xc", "0x2::coin_registry::CurrencyKey<T>", new Uint8Array([0]))` from `@mysten/sui/utils`. Then read the object's initial shared version with `client.core.getObject`. That gives `memeCurrency` and `quoteCurrency` as `{ objectId, initialSharedVersion }`.
3. **Build:**

   ```ts
   const [creationFee] = tx.splitCoins(tx.gas, [tx.pure.u64(fee)]);
tx.add(calls.migrateBluefin({
  ...types, presale,
  memeCurrency: { ...memeCurrency!, mutable: false },
  quoteCurrency: { ...quoteCurrency!, mutable: false },
  bluefinConfig: { ...identity.venues.bluefin!.globalConfig, mutable: true },
  creationFee: creationFee!,
}));
```

From a web checkout only, `apps/workers/src/modules/presale/lifecycle/chain.ts` has the same reads as the relayer: `readBluefinFee` and `readRegistryCurrency`. They need the checkout's TypeScript import hooks (`node --import ./scripts/test-tsx-hooks.mjs`), so an operator script outside the repository should use the steps above.

For `migrate` alone, `PresaleTransactions.migrateCetus(…)` and `PresaleTransactions.migrateBluefin({ …, creationFee: fee })` build the same calls.

**A partnered sale** (`sale.partnerId` is set, generation 2): its migration holds Blast's raise fee until `blast_presale::pay_protocol_fees_with_partner` pays the partner its cut and Blast the rest. Pay it in the same PTB, right after the venue's migrate, as the relayer does. The partner is the shared `blast_partners::Partner` at `sale.partnerId`; read its initial shared version from the chain (`client.core.getObject`), never from anywhere else:

```ts
tx.add(calls.payProtocolFeesWithPartner({ ...types, presale, partner: { objectId: sale.partnerId, initialSharedVersion: partnerVersion, mutable: false } }));
```

`PresaleTransactions.migrateCetus`, `migrateBluefin`, `migrateAftermath` and `settleAndMigrateAftermath` take the same `partner` and append it for you.

### Paying a partner after migration (`partner_unpaid:<id>`)

`partner_unpaid:<id>` means the sale migrated with its partner still unpaid (`unpaidProtocolQuote` is set): someone migrated it without the payout, or the relayer's payout failed in simulation (for example a deny-listed partner recipient) and it migrated without it rather than risk the liquidity deadline. Anyone may pay it, once. Check `client.core.getObject` of the sale still shows `unpaid_protocol_quote` set, then, after a dry run:

```ts
new PresaleTransactions(identity.presale).payProtocolFeesWithPartner({ ...types, presale, partner: { objectId: sale.partnerId, initialSharedVersion: partnerVersion, mutable: false } })
```

It aborts with `EWrongPartner` for any partner but the sale's, and `ENoPartnerPayout` once paid. The relayer does not pay it on its own after migration yet; the alert is raised once.

## 3. When migration is blocked

`blocked_abort` names the cause: an SDK name for a presale-package abort, or `external_abort` with `blocked_location` and `blocked_code` for a venue abort.

| Cause | What to do |
| --- | --- |
| Cetus `factory` abort (`external_abort`, `<cetus>::factory`): the Quote is not in Cetus's permission-pair allowlist at the sale's tick spacing | Ask Cetus to admit the pair. The relayer's backoff then migrates it. Nothing else can migrate a Cetus sale. |
| Bluefin fee mismatch, or `bluefin-fee-unreadable` | Check the Bluefin `GlobalConfig` and its `pool_creation_fee` table. The relayer reads it again on every attempt. |
| `bluefin-fee-above-cap` | Bluefin's fee is above `PRESALE_LIFECYCLE_MAX_POOL_FEE_MIST`. Either raise the setting on the owner's decision and restart the role, or migrate by hand (section 2). |
| `insufficient-gas` | Fund the key's address balance above gas budget plus fee (`send_funds`), or raise the gas budget. See the sizing in [../lifecycle.md](../lifecycle.md). |
| `combined-execution-failed` | The combined PTB simulated but failed on chain. The sale was settled alone, and `migrate` retries with backoff. Look up `migrate_digest` for the reason. |
| `currency-unavailable` | The Meme's or Quote's Coin Registry `Currency` is not shared yet. Finalize its registration. |
| `venue-unrecorded` | The identity lacks the venue's objects. Fix `PRESALE_DEPLOYMENT_MANIFEST`, then restart. |

Keep `deadline_near` in view. Once `liquidity_deadline_ms` passes, anyone may cancel the sale. Participants are then refunded, and the pool is never created.

## 4. After the deadline: anyone may cancel

From `liquidity_deadline_ms`, a sale still `Funded` can be cancelled by **anyone**:

```ts
new PresaleTransactions(identity.presale).cancelUnlaunched({ ...types, presale })
```

This is the participants' refund exit. **The relayer never calls it**, and no worker key may sign it (the lifecycle guards refuse it). An operator calls it only on the owner's decision. Before the deadline it aborts (`ELiquidityDeadlineNotReached`). After it lands, participants claim their refunds, and the relayer records the sale `cancelled` with `cancel_reason = 'liquidity_deadline'`.

## 5. Afterwards

The relayer records whatever the chain shows on its next visit, with `settled_by` or `migrated_by` set to `external` for your transaction, and clears the sale's alerts. Write the digest, the operator and the reason in the incident log.
