import { evaluateBridgeActivation, ACTIVATION_MIN_TEST_ATOMS } from "./activation.ts";
import type {
  BridgeActivationChecklist,
  BridgeActivationRecord,
  BridgeActivationRecords,
  BridgeConfiguration,
  BridgeInactiveReason,
  BridgeWithdrawChecklist,
} from "@blast/core/modules/presale/bridge/contracts.ts";
import { suiBurnIds, WITHDRAW_DESTINATIONS, type SuiBurnIds, type WithdrawDestination } from "@blast/core/modules/presale/bridge/sui-burn.ts";

/**
 * Withdrawals out of Sui (social coins: USDC burned on Sui, minted by Circle's
 * Forwarding Service on another chain) are off by default, like the bridge.
 * A destination is live only while all of these hold:
 *
 * - the bridge itself is on: the latest activation record is a complete
 *   checklist recorded for this deployment's forwarding mode, relayer and
 *   Sui CCTP ids (`evaluateBridgeActivation`);
 * - the identity's `cctp` block names CCTP V2's stablecoin handler (the
 *   burn goes through it), and so did the record's;
 * - that record's `withdraw` part lists a passing test transfer to the
 *   destination: at least $5, burned on Sui and minted there by Circle in
 *   under `WITHDRAW_ACTIVATION_MAX_SECONDS`. A repeated Sui digest or
 *   destination hash counts once.
 *
 * Anything else (no `withdraw` part, a destination never tested) keeps that
 * destination off, and the sheet shows it as unavailable.
 */

/** A withdrawal test passes when Circle minted it on the destination in under this (Sui's half-second finality, the attestation, the forward). */
export const WITHDRAW_ACTIVATION_MAX_SECONDS = 300;

export type BridgeWithdrawInactiveReason = BridgeInactiveReason | "sui_burn_ids_missing" | "no_withdraw_tests";

export type BridgeWithdrawState =
  | Readonly<{ active: true; recordId: string; ids: SuiBurnIds; live: readonly WithdrawDestination[] }>
  | Readonly<{ active: false; reason: BridgeWithdrawInactiveReason; live: readonly [] }>;

/** The destinations the checklist's withdrawal part proved, in the sheet's order. */
export function bridgeWithdrawDestinations(withdraw: BridgeWithdrawChecklist | undefined): WithdrawDestination[] {
  if (!withdraw) return [];
  const digests = new Set<string>();
  const hashes = new Set<string>();
  const proven = new Set<string>();
  for (const transfer of withdraw.test_transfers) {
    const hash = `${transfer.destination}:${transfer.destination_tx_hash}`;
    const repeated = digests.has(transfer.sui_digest) || hashes.has(hash);
    digests.add(transfer.sui_digest);
    hashes.add(hash);
    if (repeated) continue;
    if (BigInt(transfer.amount_atoms) < ACTIVATION_MIN_TEST_ATOMS) continue;
    if (transfer.burn_to_mint_seconds >= WITHDRAW_ACTIVATION_MAX_SECONDS) continue;
    proven.add(transfer.destination);
  }
  return WITHDRAW_DESTINATIONS.filter((destination) => proven.has(destination));
}

function checklistOf(record: Pick<BridgeActivationRecord, "kind" | "checklist">): BridgeActivationChecklist | null {
  return record.kind === "checklist" ? (record.checklist as BridgeActivationChecklist) : null;
}

/** Which destinations a withdrawal may go to now, under `configuration`. */
export function evaluateBridgeWithdraw(
  latest: (Pick<BridgeActivationRecord, "id" | "kind" | "complete" | "forwarding" | "relayerAddress" | "hookData" | "suiCctp" | "checklist">) | null,
  configuration: BridgeConfiguration,
): BridgeWithdrawState {
  const off = (reason: BridgeWithdrawInactiveReason): BridgeWithdrawState => ({ active: false, reason, live: [] });
  const bridge = evaluateBridgeActivation(latest, configuration);
  if (!bridge.active) return off(bridge.reason);
  const identity = configuration.identity;
  const ids = identity.status === "ready" ? suiBurnIds(identity.identity.cctp) : null;
  if (ids === null) return off("sui_burn_ids_missing");
  const live = bridgeWithdrawDestinations(checklistOf(latest!)?.withdraw);
  if (live.length === 0) return off("no_withdraw_tests");
  return { active: true, recordId: bridge.recordId, ids, live: Object.freeze(live) };
}

export type BridgeWithdrawGate = Readonly<{ current(): Promise<BridgeWithdrawState> }>;

/** The withdrawal gate over the activation records, read on every call (records are few and never change). */
export function createBridgeWithdrawGate(input: Readonly<{
  records: Pick<BridgeActivationRecords, "latest">;
  configuration: BridgeConfiguration | (() => BridgeConfiguration);
}>): BridgeWithdrawGate {
  const configuration = typeof input.configuration === "function" ? input.configuration : () => input.configuration as BridgeConfiguration;
  return Object.freeze({
    async current() {
      return evaluateBridgeWithdraw(await input.records.latest(), configuration());
    },
  });
}
