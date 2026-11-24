# Presale claim delivery (T-024)

> **DISABLED (owner decision, 2026-10-07): buyers claim in the app.** The `presale-claim-delivery` job is not registered on the `presale-lifecycle` role (`PRESALE_ROLE_JOBS` in `apps/workers/src/modules/presale/worker/jobs.ts`), and its `presale-claim-batch` guard is not on the lifecycle key (`PRESALE_SIGNER_GUARDS`), so the key refuses a claim batch. Nobody claims on a buyer's behalf: after a migration or a cancellation each buyer claims their tokens or refund from the app (the sale page, and the Claim link in "Your presales"), or anyone may call the permissionless `claim` for them ([runbooks/manual-claim.md](runbooks/manual-claim.md)). `PRESALE_CLAIM_BATCH` is unused. The code (`apps/workers/src/modules/presale/delivery/`) is kept with a DISABLED header, and its delivery-only integration tests are skipped. The rest of this page describes the job as it ran before, for the day it is switched back on: register `presaleClaimDeliveryJob` again and put `CLAIM_GUARDS` back on the lifecycle key.

After a sale migrates or is cancelled, the lifecycle relayer claims for every participant. After a migration a claim pays tokens and any refund. After a cancellation it pays the full refund. Nobody has to come back, and a claim someone else made first is skipped.

The job is `presale-claim-delivery` (`apps/workers/src/modules/presale/delivery/job.ts`). It is registered on the `presale-lifecycle` role after T-023's `presale-lifecycle-relay` ([lifecycle.md](lifecycle.md)) and signs with the same key. The host, ledger, alert channel and release gate are T-009's ([worker.md](worker.md)).

Contracts: `sui/presale` at `eca9b25`.

- Commitments are dynamic fields on the `Presale` UID: key `CommitmentKey(address)`, value `Commitment { quote, wallet_cap }`.
- `claim<S, Q>(presale, participant)` is permissionless and pays the participant. It removes the field, so the storage rebate goes to the claim's gas owner, the relayer.
- `claim` aborts with `ENoCommitment` when the field is absent, and with `EInvalidLifecycle` unless the sale is `Migrated` or `Cancelled`.

## Each visit

A record is due when T-023 has closed it as `migrated` or `cancelled` and its `next_check_at` has passed. An `unpayable` record is due again hourly.

1. **Read the sale fresh** (`PresaleClient.getPresale`). It must be `Migrated` or `Cancelled`, of the record's types.
2. **List who is owed.** The job reads the sale's dynamic fields from the fullnode, every page, and keeps those named `<original package>::blast_presale::CommitmentKey`. It sorts the addresses ascending by their 32 bytes (`claims.ts`). The `Presale` object is the authority; no indexer is consulted.
3. **Batches, in order.** Each batch takes the next `size` wallets. `size` is `PRESALE_CLAIM_BATCH` (default 100), or the record's smaller `claim_batch_size` after a shrink. Wallets already set aside as unpayable are skipped, except on an `unpayable` record's hourly recheck.
   - **Before each batch**, each wallet's field is read again (8 at a time). Wallets someone else claimed are dropped.
   - **Size.** The batch's transaction kind is built and measured. If it is over 96 KiB, the batch is halved before it is submitted, since the node refuses an oversized transaction before simulating it.
   - **Submission.** The batch is one PTB of `PresaleTransactions.claim({ participants })`, sent through `context.submit`: simulate, record the digest (on the record and in the ledger), send once, read the effects.
4. **After the listed wallets**, the job lists again.
   - **Delivered.** An empty listing, with the sale's `participants` (generation 2: the wallets still holding a commitment) read again as zero, makes the record `delivered`. An empty listing while the sale still holds commitments is not trusted: the record is read again in 2 s (`error_class` `commitments-remaining`).
   - **Unpayable.** A listing of only set-aside wallets makes the record `unpayable` (see below).
   - **Awaiting the chain.** A listing of only wallets the node already said someone claimed means its reads lag. The record is read again in 2 s (`awaiting-chain`).

**After a failed simulation.** Each failure is classified by `classifyClaimFailure`. The failing command's index names the wallet, since command i is participant i.

| Simulation failure | What happens |
| --- | --- |
| Size, object or gas limit (`SizeError`, `…TooLarge`, `Max…Objects`, `MEMORY_LIMIT…`, `InsufficientGas`) | The batch halves and is tried again at once. The halved size is kept in `claim_batch_size` only when the failing batch was a full one. A short last batch shrinks for that visit only. The kept size never grows back for that sale. |
| `ENoCommitment` | Someone claimed the wallet at the failing command after its check. That wallet is dropped, and the rest is tried again. |
| `EInvalidLifecycle`, `InsufficientCoinBalance` (the key cannot fund it), or a gas limit at a batch of one | The sale is blocked; see **Blocked** below. |
| `CoinDenyListError` naming a wallet of the batch | That wallet is set aside at once. Sui raises `AddressDeniedForCoin` after the commands ran, with no command index, but with the denied address. |
| Anything else (another package's abort, an unknown failure, a deny-list error without an address) | The wallet at the failing command, or the one a split isolates, may be one that cannot be paid; see **Unpayable wallets** below. |

**Blocked.**
- `delivery_blocked:<id>` is raised first, so a failing record write cannot suppress it. Its details are `reason` (the abort name, `external_abort` or a gas class), `errorClass` and `closed`.
- The record then gets `error_class` `claim-blocked` and `claim_blocked_reason` = the reason, and is read again in 60 s.
- `error_class` always stays kebab-case (0048's CHECK). Abort names live in `claim_blocked_reason`.

**Unpayable wallets.** A wallet is set aside only on positive evidence, never on a single failure:
- **A deny-list error names it.** It is set aside at once.
- **It was set aside before.** On an `unpayable` record's hourly recheck, a set-aside wallet that fails again stays aside. Such a failure never counts towards blocking the sale.
- **It failed alone twice.** It failed alone in an earlier pass, and fails again alone, the same way, in a later pass while the sale pays others: a batch landed in this visit, or another wallet was found claimed by someone else in it (generation 2 keeps no remaining-commitment total).

How suspects are found and confirmed:
- **The first failure** (at the failing command, or isolated by splitting a batch with no index in halves) only makes the wallet a *suspect*. It is skipped for the rest of that pass, and the others carry on. A suspect is kept in the worker process; a restart only makes it fail once more first.
- **In a later pass**, once the others are done, each suspect is tried alone. If it lands, it was transient. If it fails the same way, it is set aside. A transient failure therefore costs a payable wallet one 2 s pass, never an hour.
- **When the sale is blocked instead.** Three single-wallet failures in a row with nothing landing between, each at a batch's first command or isolated by a split, mean every claim fails (`SALE_WIDE_FAILURES`). The sale is blocked, and nobody is set aside. A failure at a later command (the claims before it ran) or a landed batch starts the count over. A suspect failing alone again while the sale has paid no one also blocks it.

What happens next:
- **Set aside.** A set-aside wallet goes into `unpaid_wallets`. `claim_unpayable:<id>` names every set-aside wallet, raised afresh whenever the set grows or shrinks. Delivery carries on with everyone else.
- **Unpayable state.** When only set-aside wallets remain, the record becomes `unpayable` (`error_class` `claim-unpayable`). It is tried again hourly, which also repeats the alert.
- **Delivered later.** Once those wallets are paid, by the relayer's recheck or by anyone, the record becomes `delivered` and the alert clears.

**After the submission:**

| Outcome | What happens |
| --- | --- |
| Executed | The single-wallet failure count starts over, and the next batch follows. |
| Failed on chain, `ENoCommitment` | Someone's claim landed between the simulation and the execution. This race is benign: the wallet is dropped, the sale is listed again at once, and nothing is counted or backed off. |
| Failed on chain, any other reason | The bytes are never sent again. `claim_failures` counts it, and the record backs off: 30 s, doubling, at most 10 minutes. Then it lists afresh. |
| Unknown | The signer gate closes. The gate settles the digest, resending only the same bytes, before anything else is signed. The record is read again after 2 s. |
| Not submitted | Gate closed, an address balance below the gas budget, or a lost lease. Retried after 10 s. |

**Pass budget.**
- A pass lands at most 5 batches across records (`CLAIM_BATCHES_PER_PASS`), and a visit tries at most 43 simulations. That is enough to isolate three failing wallets by halving a 500-wallet batch.
- After a visit that landed a batch, the record is due again at once, and the host is asked for the next pass. So the relay job, which runs first in every pass, keeps its settle timing while a large sale is delivered.
- A visit that landed nothing waits 2 s (`no-progress`), so lagging reads cannot make it spin.

**Overdue.**
- A record still `migrated` or `cancelled` 15 minutes after it closed raises `delivery_overdue:<id>`, whatever stalls it: `signer-refused`, `internal-error`, repeated on-chain failures, `signer-busy`, or visits that make no progress. This is AC-092's bound, alerted per AC-096.
- The sweep reads the records only, so it also runs on a pass the host blocked (`blockedPass`).
- `unpayable` records are not overdue; `claim_unpayable` covers them.

**Throughput.** One batch is one transaction, about 1–3 s. 3,000 wallets in batches of 100 is 30 transactions, about 2 minutes. The requirement is 15 minutes. The fixture run (3,000 + 50 wallets, 31 transactions, 3 s each plus 1 s per pass) takes 113 s of fixture time. The mainnet measurement belongs to the mainnet operations-readiness verification.

**No duplicate submission.** Every digest is in `mission_control_worker_submissions` before the bytes leave. A kill after a batch is recorded and before its effects are read leaves an open ledger row. The next process's gate resends exactly those bytes, or settles them, before it signs anything new. The listing after that no longer holds the wallets the batch paid.

## Records

Migration `0050_presale_delivery` adds to `presale_lifecycle_records` (0048). Grants are unchanged.

| Column or state | Meaning |
| --- | --- |
| state `delivered` | Final. Every commitment was claimed, by the relayer or anyone. `closed_at` stays set. |
| state `unpayable` | Every wallet that can be paid was claimed. The wallets in `unpaid_wallets` cannot be, and they keep their commitment. Rechecked hourly; `delivered` once they are paid. |
| `claim_digest` | The relayer's latest claim batch, recorded before its bytes were sent. |
| `claim_batches` | Claim batches the relayer recorded. |
| `claim_failures` | Claim batches that failed on chain since the last one that landed, not counting someone else's claim racing a batch. |
| `claim_batch_size` | The batch size in force after a full batch shrank; null means `PRESALE_CLAIM_BATCH`. |
| `claim_blocked_reason` | Why delivery is blocked (`error_class` `claim-blocked`): an SDK abort name, `external_abort` or a gas class. |
| `unpaid_wallets` | The wallets set aside as unpayable, ascending. |
| `delivered_at` | When delivery was confirmed complete. |
| `next_check_at`, `error_class` | Delivery's own while the record is `migrated`, `cancelled` or `unpayable`. `error_class` is kebab-case: for example `claim-blocked`, `claim-unpayable`, `commitments-remaining`, `awaiting-chain`, `suspect-recheck` (a wallet that failed once is tried alone again in 2 s), `no-progress` or `execution-failed`. |

**How a sale closed.** In both `delivered` and `unpayable`, `migrated_by` (a migration) or `cancel_reason` (a cancellation) still tells how the sale closed. Consumers must read those columns, not `state`: a migrated sale is `migrated_by IS NOT NULL`, whatever its delivery state.

0050's down migration refuses, with an error that says so, while any record is `delivered` or `unpayable`. Otherwise it restores 0048's checks.

## The guarded method

`presale-claim-batch` (`delivery/guard.ts`) is added to `PRESALE_SIGNER_GUARDS["presale-lifecycle"]` next to T-023's three. It signs only:

- 1..N calls of `blast_presale::claim<S, Q>(presale, participant)` from the identity's presale package, where N is the intent's participant count and at most 500, the ceiling of `PRESALE_CLAIM_BATCH`. The ceiling, not the setting, lets the gate resend a batch recorded before an operator lowered the setting;
- with the intent's sale types;
- with one sale: every call takes the same shared input, the intent's `presaleId`;
- with call i's participant equal to intent participant i, as a pure input of exactly 32 bytes. The intent lists the participants strictly ascending.

The inputs are exactly that sale and those N addresses, each used.

The signer's gas-only check runs first. The relayer must be sender and gas owner, within the gas budget. The claim guard is not a fee guard, so no command may touch the gas coin. Anything else is refused: a second sale, `settle`, `migrate`, `cancel_unlaunched`, a transfer, a split, an owned object, an unused input.

## Configuration

| Variable | Meaning |
| --- | --- |
| `PRESALE_CLAIM_BATCH` | Optional. The starting claim batch size, 1 to 500, default 100. Read only by the lifecycle role (`config.presaleClaimBatch`). The guard signs up to the ceiling, 500. |

**Gas.**
- **Who pays.** The relayer pays for each claim's new coins. A migrated claim makes up to two (tokens and a refund), roughly 2,000,000 MIST of storage each. Each removed commitment field's rebate, roughly 2,000,000 MIST, is returned to the relayer.
- **Budget.** Sui checks computation plus the *gross* storage against the gas budget before the rebate. A 100-claim batch therefore needs a `PRESALE_LIFECYCLE_GAS_BUDGET_MIST` of about **0.4–0.5 SUI**. The 0.5 SUI that T-023 starts with covers it.
- **Net cost.** A 3,000-wallet sale costs the key on the order of several SUI net. Fund it ([runbooks/relayer-keys.md](runbooks/relayer-keys.md)).
- **When the budget is too small**, simulation fails with `InsufficientGas`, and the batch halves until it fits. Check `claim_batch_size` after the first mainnet deliveries: a size well under 100 means the budget is the limit.

## Alerts and logs

| Key | Raised when | Cleared when |
| --- | --- | --- |
| `delivery_blocked:<id>` | The sale is blocked: `EInvalidLifecycle`, a key that cannot fund the transaction, a batch of one over the gas budget, or a failure every claim shares. Details: `reason`, `errorClass`, `closed`, and `wallet` when one was suspected. | The sale is delivered or left unpayable. |
| `claim_unpayable:<id>` | A wallet is set aside as unpayable, raised again at once when the set grows and hourly while the record is `unpayable`. Details: `wallets` (comma-separated, ascending), `count`, `wallet` and `reason` of the latest one, `closed`. | The sale is delivered. |
| `delivery_overdue:<id>` | A `migrated` or `cancelled` record is not delivered 15 minutes after it closed, whatever the cause; also on a blocked pass. Details: `closedAtMs`, `overdueMs`, `errorClass`. | The sale is delivered or left unpayable. |

Logs:
- `presale.delivery.visit`: `delivered`, `unpayable`, `continuing`, `awaiting-chain`, `raced` or `failed`;
- `.submitted`;
- `.shrunk` (with `kept`);
- `.blocked`;
- `.unpayable`;
- `.backlog`.

If delivery stays blocked, or wallets stay unpayable, any participant or operator can claim by hand: [runbooks/manual-claim.md](runbooks/manual-claim.md).

## Verification

```bash
node --no-warnings --import ./scripts/test-tsx-hooks.mjs --test --experimental-strip-types apps/workers/src/modules/presale/delivery/delivery.test.ts
npm run test:integration -w @blast/workers   # includes delivery.integration.test.ts: fixture node, fake blast-infra, disposable PostgreSQL
```
