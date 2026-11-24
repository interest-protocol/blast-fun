# Bridge activation (5 October checklist)

The presale's USDC bridge (CCTP V2 to Sui) is **off by default**. Only an operator's complete checklist record turns it on. This runbook is that checklist. The code is in `apps/web/src/modules/presale/bridge/` (activation and routes), `apps/workers/src/modules/presale/bridge/` (the relayer) and `packages/core/src/modules/presale/bridge/` (T-020).

## What "off" means

While the bridge is off:

- `GET /api/presale/bridge/quote` answers `503 bridge_unavailable` with `Retry-After`.
- `POST /api/presale/bridge/transfers` answers the same.
- `GET /api/presale/bridge/transfers/{id}` answers `bridge_unavailable` until the bridge has been activated once. After that it keeps answering, so a burn in flight stays visible after a later deactivation.

The bridge is on only while **all** of these hold:

1. The newest record in `presale_bridge_activations` is a complete checklist.
2. The record's forwarding mode equals `PRESALE_BRIDGE_FORWARDING`.
3. In `"blast"` mode, the record's relayer address equals `PRESALE_BRIDGE_RELAYER_ADDRESS`.
4. The record's Sui CCTP ids equal the `cctp` block of `PRESALE_DEPLOYMENT_MANIFEST`.

Changing the forwarding mode, the relayer, the hook, or any Sui CCTP id therefore needs a new checklist record. Until then the bridge is off.

## Before the run

- Migrations `0044_presale_bridge` and `0051_presale_bridge_observation` (the relayer's queue evidence, T-021) are applied.
- `PRESALE_DEPLOYMENT_MANIFEST` has a `cctp` block with Circle's Sui **V2** package and object ids: `messageTransmitter`, `tokenMessengerMinter`, `mtState`, `tmmState`, `usdcTreasury`, `usdcType`, and `denyList`. Check them against Circle's published Sui V2 contract addresses.
- `PRESALE_BRIDGE_FORWARDING` is set:
  - `blast`: Blast's relayer submits the Sui mint. This is the expected mode, because Circle's Forwarding Service does not list Sui.
  - `circle`: the burn carries Circle's forward request, and the relayer only observes.
- `PRESALE_BRIDGE_RELAYER_ADDRESS` is the relayer worker's Sui address (`0x` + 64 hex). The quote returns it as `destination_caller`, so only the relayer can mint those burns.
- The relayer worker is deployed with the same three settings.
- The operator command has its credentials: `MISSION_CONTROL_OPERATOR_ALLOWED_ID`, `MISSION_CONTROL_OPERATOR_TOKEN_SHA256`, `BLAST_OPERATOR_ID`, `BLAST_OPERATOR_TOKEN`, and `DATABASE_URL`.

Mainnet only: the bridge never uses Circle's sandbox or testnet.

## The checklist

Work through each item and write the results into a checklist file (below).

1. **Circle lists domain 8 for V2 and Fast Transfer.** Read the fee API for each source:

   ```bash
   for src in 0 3 5 6; do curl -s "https://iris-api.circle.com/v2/burn/USDC/fees/$src/8"; echo; done
   ```

   Domains: Ethereum 0, Arbitrum 3, Solana 5, Base 6, Sui 8. Each answer must be a fee list. `domain8_v2` is true when Circle answers with a list for domain 8. `domain8_fast` is true when the list has a `finalityThreshold: 1000` entry. Keep this to a few requests: Circle allows 40 per second, and a breach blocks every request for 5 minutes.

2. **Sui V2 ids.** Confirm that the identity's `cctp` block holds the V2 package and object ids. The command copies them from the identity into the record.

3. **Forwarding mode.** Choose `blast` or `circle`, as set in the environment. In `blast` mode, set `relayer_address` and leave `hook_data` null. In `circle` mode, set `hook_data` to the forward request that Circle documents for the Sui route. Circle's EVM reference is `0x636374702d666f72776172640000000000000000000000000000000000000000` (`cctp-forward`, version 0, no extra data); confirm it against Circle's Sui documentation on the day.

4. **Fast allowance.** Read `https://iris-api.circle.com/v2/fastBurn/USDC/allowance`. Record the allowance in USDC next to the raise cap and the wallet cap in USDC atoms. A wallet's Fast quote shows `allowance_ok: false` when its amount is above the global allowance; Standard still works.

5. **Three $5 mainnet Fast transfers:**
   - two from Solana to Sui;
   - one from Base to Sui.

   Each must be at least 5 USDC (5,000,000 atoms) and minted on Sui **in under 60 seconds** from the burn. Record the source transaction, the Sui mint digest, and the seconds. The presale page cannot make these transfers while the bridge is off: the quote and the public registration answer `503 bridge_unavailable`. Build each burn by hand, then register it with `register-test` (next section).

## Test transfers while the bridge is off

### 1. Build the burn

Read Circle's Fast fee for the source (`finalityThreshold: 1000` in step 1), then compute the parameters:

| Parameter | Value |
| --- | --- |
| `amount` | `5000000` (5 USDC) or more |
| `destinationDomain` | `8` (Sui) |
| `mintRecipient` | The test wallet's Sui address as 32 bytes (`0x` + 64 hex) |
| `destinationCaller` | `blast` mode: the relayer's Sui address (`PRESALE_BRIDGE_RELAYER_ADDRESS`) as 32 bytes. `circle` mode: 32 zero bytes. |
| `maxFee` | `ceil(amount × fee_bps × 1.25 / 10000)` atoms. For 5 USDC at 1.3 bps this is `ceil(812.5)` = `813`. |
| `minFinalityThreshold` | `1000` (Fast) |
| `hookData` | `circle` mode only: the recorded hook. `blast` mode: no hook. |

Call the source chain's CCTP V2 burn:

- **Base (EVM), `blast` mode:** approve USDC to `TokenMessengerV2`, then call `depositForBurn(amount, 8, mintRecipient, USDC, destinationCaller, maxFee, 1000)`.
- **Base (EVM), `circle` mode:** approve USDC to `TokenMessengerV2`, then call `depositForBurnWithHook(amount, 8, mintRecipient, USDC, bytes32(0), maxFee, 1000, hookData)`.
- **Solana, `blast` mode:** call the `TokenMessengerMinterV2` instruction `deposit_for_burn` with `amount`, `destination_domain: 8`, `mint_recipient`, `destination_caller`, `max_fee`, and `min_finality_threshold: 1000`.
- **Solana, `circle` mode:** call `deposit_for_burn_with_hook` with the same values plus `hook_data`, and a zero `destination_caller`.

In `blast` mode only the relayer can mint the burn, because `destinationCaller` pins it.

### 2. Register it at once

```bash
npm run presale:bridge-activation -w @blast/web -- register-test <source> <tx_hash> <sui_address> <amount> <presale_id>
```

- This uses the public registration's validation and table: an EVM hash is `0x` + 64 hex (stored lowercase), and a Solana signature is base58.
- It works while the bridge is off, and it is idempotent on `(source, tx_hash)`.
- It prints the transfer id. Follow the transfer with `GET /api/presale/bridge/transfers/{id}`, which answers once the bridge has been activated, or with the transfer row.

**Dependency on T-021.** The bridge relayer worker processes every registered transfer, whatever the gate state. That is how the test burns are minted before activation, and how burns in flight finish after a deactivation.

The relayer (`bridge-relay` in the `presale-bridge` process) mints through the Sui CCTP version that `PRESALE_BRIDGE_CCTP_VERSION` selects (`SUI_CCTP_RECEIVE_BUILDERS` in `bridge/sui-cctp.ts`). Only V1, Sui's published CCTP, is written. A test burn mints only through a version whose builder exists, and whose message version matches the burn. A V2 burn needs the V2 builder, which activation completes. Stuck transfers: [bridge-stuck-transfers.md](bridge-stuck-transfers.md).

## Record it

Write the checklist file:

```json
{
  "forwarding": "blast",
  "relayer_address": "0x<relayer address>",
  "hook_data": null,
  "circle": { "domain8_v2": true, "domain8_fast": true, "checked_at": "2026-10-05T09:00:00Z" },
  "fast_allowance": { "allowance_usdc": "<allowance>", "raise_atoms": "<raise cap>", "wallet_cap_atoms": "<wallet cap>" },
  "test_transfers": [
    { "source": "solana", "amount_atoms": "5000000", "source_tx_hash": "<signature>", "sui_digest": "<digest>", "burn_to_mint_seconds": 21 },
    { "source": "solana", "amount_atoms": "5000000", "source_tx_hash": "<signature>", "sui_digest": "<digest>", "burn_to_mint_seconds": 19 },
    { "source": "base", "amount_atoms": "5000000", "source_tx_hash": "0x<hash>", "sui_digest": "<digest>", "burn_to_mint_seconds": 33 }
  ],
  "note": "5 October activation"
}
```

Then record it (a relative path is read from `apps/web`, where the script runs):

```bash
npm run presale:bridge-activation -w @blast/web -- record checklist.json
```

The command prints one JSON line with the record and the bridge's state. A malformed file (an unknown key, a wrong type, or a source hash not in its source's format) is refused with `OPERATOR_INPUT_INVALID` and nothing is recorded. A well-formed file that fails an item is recorded with its `problems` and keeps the bridge off:

| Problem | Meaning |
| --- | --- |
| `domain8_v2_unconfirmed` | Circle's fee API does not list domain 8 |
| `domain8_fast_unconfirmed` | No Fast (threshold 1000) entry for domain 8 |
| `relayer_address_required` | `blast` mode without a relayer |
| `hook_data_not_allowed` | `blast` mode with a hook |
| `hook_data_required` | `circle` mode without a hook |
| `test_transfers_duplicated` | Two entries share a source hash or a Sui digest. Any such entry makes the record incomplete; remove it and record again. |
| `test_transfer_below_5_usdc` | An entry is under 5,000,000 atoms. Any such entry makes the record incomplete, even next to enough valid transfers; remove it and record again. |
| `solana_transfers_missing` | Fewer than two distinct Solana transfers of $5 or more, minted in under 60 s |
| `base_transfers_missing` | No Base transfer of $5 or more minted in under 60 s |
| `sui_cctp_missing` | The identity has no `cctp` block |

The output also lists `warnings`. They compare the Fast allowance with the raise and the wallet cap: `fast_allowance_below_wallet_cap`, `fast_allowance_below_raise`, and `wallet_cap_above_raise`. The ticket asks for this comparison but states no rule that blocks activation, because Standard always works. Warnings never make a record incomplete; read them and decide.

## Check and operate

```bash
npm run presale:bridge-activation -w @blast/web -- status        # the state now and the latest record
npm run presale:bridge-activation -w @blast/web -- history 20    # every record, newest first
npm run presale:bridge-activation -w @blast/web -- deactivate "incident 42"
```

`status` prints `activation.active`. `record` and `deactivate` print the state the gate reads after the write. When the bridge is off, `reason` says why: `no_record`, `deactivated`, `incomplete`, `identity_unavailable`, `sui_cctp_changed`, `forwarding_changed`, or `relayer_changed`.

After recording, check one quote:

```bash
curl -s "https://<site>/api/presale/bridge/quote?source=solana&amount=5000000"
```

It must show `destination_domain: 8`, the recorded `forwarding`, and, in `blast` mode, the relayer as `destination_caller` with `hook_data: null`.

Records are never changed or deleted. To turn the bridge off, record a deactivation. To turn it on again, record a new complete checklist.

## Reference

- **Quote.**
  - `fee_bps` is Circle's `minimumFee` for the threshold, as Circle reports it.
  - `max_fee` = `ceil(amount × fee_bps × 1.25 / 10000)` atoms.
  - `allowance_ok` = `amount ≤ allowance × 10^6`.
  - `fast` is null without a threshold-1000 entry.
  - ETA: Fast is 20 s (Ethereum) or 8 s (others), plus 10 s for the Sui mint. Standard is 1,140 s (Ethereum, Base, Arbitrum) or 25 s (Solana), plus 10 s.
- **Circle load.** Each instance caches each fee list and the allowance for 30 s, with one request in flight per key. A failed request is not retried for 5 s. After a 429, no request is sent for 5 minutes. Every such failure is `503 bridge_unavailable` with `Retry-After`.
- **Transfers** (`presale_bridge_transfers`).
  - Registration is idempotent on `(source, tx_hash)`: 201 `{id}` when new, 200 `{id}` on a repeat. EVM hashes are stored in lowercase.
  - The relayer worker validates the burn; the web route does not.
  - The registered `sui_address`, `amount` and `presale_id` are unauthenticated hints. Anyone who sees a burn can register it first, and a repeat returns that first id. The worker (T-021) mints from the attested message, using its recipient and amount, and never fails a valid burn because a registration disagrees.
  - Status only moves forward: `sent → attested → minted`. `failed` is reachable from `sent` or `attested`. A late attestation moves an `attestation_timeout` failure to `attested`, so `recordPoll` and the due index keep timed-out transfers on the poll schedule.
  - Timestamps never run backwards. Each transition stores `greatest(previous stamps, at ?? now())`, so a worker clock behind the database's, or an `at` read back in milliseconds from a microsecond stamp, is clamped and never fails the move. The table's CHECKs (`attested_at ≥ sent_at`, `minted_at ≥ attested_at`, `failed_at ≥` both) remain as the backstop. The worker (T-021) should normally omit `at` and let the database clock stamp each move.
  - The worker uses `PostgresBridgeTransfers`, exported from `packages/core/src/modules/presale/bridge/repository.ts`: `markAttested`, `markMinted`, `markFailed`, and `recordPoll`. As `blast_watcher` it may update only the progress columns.
