# Runbook: bridge transfers that do not reach `minted`

This runbook is for operators on call for the presale's USDC bridge. It covers:

- a relayer outage;
- a nonce found already used;
- an `attestation_timeout`, and parked registrations;
- invalid burns;
- burns that wait for their Sui CCTP version;
- several burns in one source transaction;
- a burn that was never registered;
- the bridge alerts.

The relayer is the `bridge-relay` job of the `presale-bridge` worker process (T-021). Its code is in `apps/workers/src/modules/presale/bridge/relayer.ts`. The process host is in [../worker.md](../worker.md), and activation is in [bridge-activation.md](bridge-activation.md).

## Who gets the money (invariant, spec A-008)

The beneficiary is the burn's own `mintRecipient`. It is part of the bytes Circle signs. Sui's `handle_receive_message` mints straight to it, and the relayer only pays gas.

- **What a registration cannot do.** A registration's `sui_address`, `amount`, `presale_id` and `privy_did` are **unauthenticated hints**, and the first registration wins. They are logged when they differ from the burn (`registration_differs`), and they never decide where USDC goes or whether a burn is minted. A front-running registration cannot redirect funds and cannot get a valid burn failed.
- **Why the relayer must never mint to itself.** Its key moves coins only as gas, so a mint to the relayer would strand the USDC. That is why the relayer is never accepted as a recipient.
- **What a future design must keep.** Any design that mints to the relayer, for example to auto-commit into a presale, would make routing depend on these hints. It must first bind the beneficiary in signed data.

## How a transfer moves

Every registered transfer is processed, whatever the activation gate says. That includes the operator's `register-test` burns before activation, and burns in flight after a deactivation.

| Status | What the relayer does |
| --- | --- |
| `sent` | It asks Circle (`GET /v2/messages/{source domain}?transactionHash=`) every 2 s until the quoted ETA, then every 15 s. Circle's `delayReason`, if any, is shown as `error`. |
| `sent` (Circle has never seen it) | It polls every 2 s in the first minute of the observation window (from registration). Then it backs off from 60 s, doubling as the window ages, to at most 1 h. Circle's "not found" past that first minute is recorded (`circle_not_found_at`). |
| `sent` → `failed` (`invalid_burn`) | The decoded message, as soon as Circle shows it, or the attested bytes, fail a [validation rule](#invalid-burns). The burn is never minted by Blast. |
| `sent` → `failed` (`attestation_timeout`) | There is still no attestation at the quoted ETA plus `PRESALE_BRIDGE_ATTESTATION_GRACE_MS`. Polling goes on every 60 s, or on the backoff above if Circle has never seen it. |
| `failed` (`attestation_timeout`) → `attested` | A late attestation arrived. The failure is cleared, and the transfer is minted as usual. |
| `failed` (`attestation_timeout`) → `failed` (`invalid_burn`) | A late message proved the burn invalid. It leaves the queue. |
| `failed` (`attestation_timeout`), parked | Circle has never seen it, 24 h into its observation window. `next_poll_at` is set to `9999-12-31`, it is not polled again, and `bridge_parked:<id>` is raised once (low severity). Registering the same burn again re-arms it for one more window, with the same id. |
| `attested` | The message, attestation and nonce are stored. The relayer settles the mint exactly once (below). |
| `minted` | `sui_digest` is the Sui transaction that received the message. |

**Queue order.** Each pass takes due transfers in this order:

1. `attested` transfers.
2. Every other transfer **without** durable evidence that Circle has never seen it. That includes new registrations, and every transfer after a restart.
3. Transfers with that evidence (`circle_not_found_at`: Circle answered "not found" past the first minute).

Within each group the most overdue transfer comes first, so a saturated Circle budget is shared round-robin and never starves a transfer. Junk registrations back off and fall into group 3, so they never delay a real burn. Circle calls go through one token bucket: 10 per second, with a burst of 20 that covers one 2 s pass.

**The mint, exactly once.** Each visit to an `attested` transfer re-reads the truth, in this order:

1. **The ledger.** An executed receive of this transfer in `mission_control_worker_submissions` (job `bridge-relay`, `record_key` = the transfer id) is the mint. Its digest is recorded.
2. **Sui CCTP's used-nonce table.** If the message's `(source domain, nonce)` is already used, the relayer submits nothing. The used-nonce field is created by the receive and never changed, so its `previousTransaction` is the mint, and that digest is recorded. If a node does not report it, the relayer looks for the `MessageReceived` event among the newest 1,000.
3. **Only then** (`blast` mode) does it submit one receive-and-mint. This goes through the runtime: simulate, record, send once, reconcile.
   - If Sui refuses the receive while the nonce is unused, the relayer takes Circle's current attestation for the same message. Circle re-signs when Sui's attesters rotate. The next attempt uses the new attestation.

A crash at any point leaves state that the next process settles from the ledger and the chain. The signer gate resends only the same bytes. A used nonce is never received twice, because Sui would abort it.

In `circle` mode the relayer never submits. It records `minted` when Circle's `forwardTxHash` has successful effects, or when it observes the nonce used.

## Invalid burns

Spec A-008 lists these classes. Each one is `failed`/`invalid_burn`, and the burn is never minted by Blast:

- the destination domain is not 8 (Sui);
- the source domain is not the registration's;
- the message sender is not the source's Circle TokenMessenger (V1 or V2; `SOURCE_TOKEN_MESSENGER`). Anything else is a generic message;
- the burn token is not the source's USDC;
- there is no burn body, or it is truncated (V1 needs 132 bytes, V2 228);
- the amount is 0 or above u64;
- the mint recipient is zero, or is the relayer itself;
- in `blast` mode, the destination caller is not the relayer. This includes a **zero** caller.

**A zero-caller burn is not stranded.** In `blast` mode it is `invalid_burn` *for Blast*: the quote always pins the relayer, and a zero-caller burn is not Blast's to pay for. Anyone can still receive it on Sui, including the user, with Circle's message and attestation, and it mints to its recipient. If a user asks, point them to any CCTP receive tool, or to Circle's `receiveMessage` reference.

The relayer never changes an `invalid_burn` back. To check a decision, fetch the message from Circle (the curl below) and compare it against the list above.

**Recovery after a wrong constant** (review R-002 Q-012). If a mainnet constant was wrong, every valid burn it judged failed `invalid_burn`. That can happen after Circle redeploys a TokenMessenger, or adds a chain. In `blast` mode only the relayer can receive those burns, so recover them:

1. Fix `SOURCE_TOKEN_MESSENGER` or `SOURCE_USDC_BURN_TOKEN` in `packages/core/src/modules/presale/bridge/cctp-message.ts`, and deploy the worker. The guard uses the same constants.
2. As the table owner (the migration login), return the affected rows to `sent`. Restrict the statement to the source and the time window of the incident:

   ```sql
   UPDATE presale_bridge_transfers
   SET status = 'sent', error = NULL, failed_at = NULL, next_poll_at = now(), circle_not_found_at = NULL
   WHERE status = 'failed' AND error = 'invalid_burn' AND attested_at IS NULL
     AND source = '<source>' AND failed_at >= '<incident start>';
   ```

3. The relayer polls them again and re-validates each attested message with the fixed constant. A valid burn attests and mints. A burn that really is invalid fails `invalid_burn` again.

Write the source, window and row count into the incident record.

## Alerts

| Alert | Meaning | First step |
| --- | --- | --- |
| `bridge_stuck` | At least one transfer this relayer can mint has been `attested` for more than 5 minutes. The details carry `count`, `oldestTransfer` and `oldestAttestedAt`. | [Find why it waits](#find-why-a-transfer-waits). |
| `bridge_version_pending` | Some `attested` transfers carry a message version the configured Sui CCTP package cannot receive, such as a V2 burn while `PRESALE_BRIDGE_CCTP_VERSION=1`. They are not counted in `bridge_stuck` and do not block the job. The details carry `count`. | [Waiting for a Sui CCTP version](#waiting-for-a-sui-cctp-version). |
| `bridge_extra_burns:<transfer id>` | The transfer's source transaction carries more than one burn to Sui. The row relays one of them; the details carry `extraSuiBurns`. The alert's row is cleared once the transfer is minted or invalid. | [Several burns in one transaction](#several-burns-in-one-transaction). |
| `bridge_parked:<transfer id>` | Low severity. A registration Circle never showed was parked, 24 h into its observation window. It is sent once per parking; the details carry `source` and `txHash`. | Usually junk. If it is a real burn, for example one stuck in a mempool or behind an Iris outage, see [an `attestation_timeout`](#an-attestation_timeout). |
| `circle_rate_limited` | Circle answered 429. Every Circle call is paused for 5 minutes. The pause survives a restart, because it is read back from this alert's row, which is stamped with the database's clock. The alert clears on the first answer after the pause. | Check what else calls Circle from the same egress, such as the web quote. The relayer itself makes at most 10 calls per second. |
| `job_stalled:bridge-relay` | The job was blocked or failed for more than 5 minutes. | Read `reasons` (next table). |
| `relayer_low:presale-bridge` | The bridge key cannot keep paying gas. | Fund it ([relayer-keys.md](relayer-keys.md)). |

## Find why a transfer waits

```sql
SELECT id, source, tx_hash, status, error, attested_at, next_poll_at, poll_count, nonce, left(message, 10) AS version
FROM presale_bridge_transfers
WHERE status IN ('sent', 'attested') OR error = 'attestation_timeout'
ORDER BY sent_at;
```

To see the poll backlog, which is large under a flood of junk registrations:

```sql
SELECT count(*) FILTER (WHERE next_poll_at <= now()) AS due_now,
       count(*) FILTER (WHERE next_poll_at >= '9999-01-01') AS parked
FROM presale_bridge_transfers
WHERE status IN ('sent', 'attested') OR (status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL);
```

Then read the worker's `presale.bridge.transfer` lines for the id. Their `reason` or `outcome` says why the transfer waits:

| `reason` / `outcome` | Meaning | Action |
| --- | --- | --- |
| `own-submission-open` | The relayer's own receive is in flight. The signer gate settles it. | Wait. If it persists, check the node (`worker.gate` lines). |
| `signer-busy` | Another submission of the key is unsettled. | Wait. |
| `insufficient-gas` | The key cannot pay its gas budget. | Fund the key. |
| `mint-digest-not-found` | The nonce is used on Sui, but neither the used-nonce field nor the newest 1,000 events named the transaction. | [A nonce found already used](#a-nonce-found-already-used). |
| `version-pending` | Waiting for its Sui CCTP version. | [Waiting for a Sui CCTP version](#waiting-for-a-sui-cctp-version). |
| `attestation-refreshed` | Sui refused the receive, and Circle had a newer attestation. The next attempt uses it. | None. |
| `simulation-failed` (repeating) | Sui refuses the receive, and Circle has no newer attestation. | Read the node's abort, from a dry run of the ledger's bytes. Check the identity's `cctp` ids, and whether Sui CCTP is paused. |
| `another-destination-caller` | Seen only after a change from `circle` to `blast` mode: a burn validated without the caller rule. | Switch back, or let anyone receive it. |
| `awaiting-forward` | `circle` mode: Circle has not forwarded yet. | Check Circle's `forwardState`. |
| `never_seen`, `parked` | Circle has never seen this transaction hash. | [An `attestation_timeout`](#an-attestation_timeout). |
| `sui-cctp-missing` | The identity has no `cctp` block. The job is blocked. | Fix `PRESALE_DEPLOYMENT_MANIFEST`. |
| `cctp-v2-unpublished` | `PRESALE_BRIDGE_CCTP_VERSION=2`, whose builder is not written yet. The job is blocked. | Activation completes V2 (`SUI_CCTP_RECEIVE_BUILDERS` in `sui-cctp.ts`). |

## Waiting for a Sui CCTP version

A V2 burn, Fast or Standard through `TokenMessengerV2`, cannot be received by Sui CCTP V1. Until `PRESALE_BRIDGE_CCTP_VERSION` and the identity's `cctp` ids name a package that receives it, the transfer waits `attested`:

- `bridge_version_pending` is raised;
- it is not counted in `bridge_stuck`;
- it does not block the job.

Once the switch names that version and its builder exists, the next pass mints it. Nothing is lost, because Circle's attestation stays valid.

## A relayer outage

In `blast` mode the quote pins `destinationCaller` to the relayer's address. Only that address can receive those burns, so while the relayer is down they wait. Nothing is lost: every burn stays registered, and Circle keeps its attestation.

1. **Restore the process** with the **same key** (`PRESALE_BRIDGE_SIGNER_KEY`). A standby takes over on its own once the active process's lease lapses ([../worker.md](../worker.md)).
2. **Let it catch up.** Due transfers are taken in queue order, `PRESALE_WORKER_BATCH_SIZE` per pass:
   - `sent` transfers are polled again;
   - those that timed out meanwhile are revived by their attestation;
   - `attested` transfers are minted;
   - a stale attestation, after attesters rotated, is refreshed from Circle.
3. **Watch** `bridge_stuck` clear and the `sent`/`attested` backlog fall (the queries above).

**If the key is lost**, burns pinned to its address can be received only by that address. They cannot be minted until the key is recovered. Keep keys recoverable, and rotate a relayer key only this way:

1. Deactivate the bridge (`presale:bridge-activation -- deactivate`), so that no new quote pins the old address.
2. Wait until no `sent` or `attested` transfer remains.
3. Rotate the key ([relayer-keys.md](relayer-keys.md)) and set `PRESALE_BRIDGE_RELAYER_ADDRESS` to the new address. The worker refuses to start when the two differ.
4. Record a new activation checklist.

## A burn that was never registered

Suppose a user burned with the quote's relayer caller, but the page never registered the burn, for example because it closed first. The relayer does not know the burn exists. While the bridge is active, the user, or support for them, registers it through the page or `POST /api/presale/bridge/transfers`.

After a deactivation the public route answers `503 bridge_unavailable`, so register it as the operator:

```bash
npm run presale:bridge-activation -w @blast/web -- register-test <source> <tx_hash> <sui_address> <amount> <presale_id>
```

The address and amount are hints. Use the user's, or the burn's own values from Circle. The relayer processes the transfer whatever the gate says, and mints it to the burn's own recipient.

## Several burns in one transaction

A row is one `(source, tx_hash)`, and it relays one message. When the transaction burns to Sui more than once, which the presale page never does, the relayer:

- relays the first burn to Sui, or the one the registration's hints name among the Sui burns;
- raises `bridge_extra_burns:<transfer id>`.

The other burns are attested by Circle but not relayed. If they pin the relayer, only the relayer key can receive them. Fetch their message and attestation from Circle (the curl below lists every message in the transaction), and escalate to the owner for a manual receive with the relayer key. A burn with a zero caller can be received by anyone.

## A nonce found already used

In `blast` mode the burn pins the relayer, so only the relayer key can have received it. A used nonce therefore means an earlier receive by this key that the ledger does not name, such as one made by hand. In `circle` mode it is normally Circle's forward. Either way, the relayer records the existing mint's digest and submits nothing.

If the transfer stays `attested` with `mint-digest-not-found`:

1. Find the Sui transaction that received the message. Use the used-nonce field's `previousTransaction`, or the `<messageTransmitter>::receive_message::MessageReceived` event with the message's `source_domain` and `nonce` (the transfer's `nonce`, in hex). Confirm that it succeeded and minted to the attested recipient.
2. Record it as the table owner (the migration login). The worker's own login can only advance its progress columns.

   ```sql
   UPDATE presale_bridge_transfers
   SET status = 'minted', minted_at = greatest(attested_at, now()), sui_digest = '<digest>'
   WHERE id = '<transfer id>' AND status = 'attested';
   ```

   Write the transfer id, the digest and how it was found into the incident record.

## An `attestation_timeout`

The transfer had no attestation at its quoted ETA plus the grace period.

- **If Circle has seen the burn,** the worker keeps polling it every 60 s. A late attestation moves it to `attested` and mints it. You do not need to do anything for that to happen.
- **If Circle has never seen the transaction hash,** the worker backs off to hourly, then **parks** the transfer 24 h into its observation window and raises `bridge_parked:<id>`. A parked transfer stays `attestation_timeout` and is not polled again. This bounds the cost of junk registrations.

To see what Circle says, ask it directly:

```bash
curl -s "https://iris-api.circle.com/v2/messages/<source domain>?transactionHash=<tx_hash>"
```

The source domains are Ethereum 0, Arbitrum 3, Solana 5 and Base 6.

- **`pending_confirmations` with a `delayReason`:**
  - `insufficient_fee`: the burn waits for Standard finality.
  - `amount_above_max` or `insufficient_allowance_available`: the burn waits for the Fast allowance or for Standard finality.
  - In each case, wait.
- **404:** Circle has not seen a burn in that transaction. Check the hash on the source chain. A transaction that is not a CCTP burn never attests, and it ends parked.
- **`complete`:** the next poll attests and mints the burn, or fails it `invalid_burn`. If it does neither, read the transfer's `presale.bridge.transfer` lines.

**Re-arming a parked transfer.** Register the same burn again: through the page, `POST /api/presale/bridge/transfers`, or `presale:bridge-activation -- register-test` while the bridge is off. The answer is the same id. A parked transfer is re-armed for one more 24 h observation window: it is polled at once, and Circle's "not found" record is cleared. A transfer that is not parked is unchanged.

As the table owner, the same re-arm is:

```sql
UPDATE presale_bridge_transfers SET next_poll_at = now(), observed_from = now(), circle_not_found_at = NULL
WHERE id = '<transfer id>' AND status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL;
```

## Settings

The relayer reads these, besides the shared worker settings in [../worker.md](../worker.md). Every setting is required.

| Variable | Meaning |
| --- | --- |
| `PRESALE_BRIDGE_FORWARDING` | `blast` (the relayer mints) or `circle` (it only observes). It must be the same value as the web's. |
| `PRESALE_BRIDGE_RELAYER_ADDRESS` | Required in `blast` mode. It must be the address of `PRESALE_BRIDGE_SIGNER_KEY`. |
| `PRESALE_BRIDGE_CCTP_VERSION` | `1` or `2`: the Sui CCTP version switch. `1` is Sui's published CCTP. `2` is completed at activation. |
| `PRESALE_BRIDGE_ATTESTATION_GRACE_MS` | The grace after the quoted ETA before `attestation_timeout`. |
| `PRESALE_WORKER_POLL_INTERVAL_MS` | Set it to `2000` for the bridge process: due transfers are taken every pass. |

`PRESALE_BRIDGE_CIRCLE_ORIGIN` is for tests only. It must be a loopback fixture and is refused in production, where the relayer always reads Circle mainnet.

The source TokenMessenger addresses (`SOURCE_TOKEN_MESSENGER`) and USDC tokens (`SOURCE_USDC_BURN_TOKEN`) are mainnet constants, checked on 2026-10-02. Re-verify them against Circle's lists on activation day.
