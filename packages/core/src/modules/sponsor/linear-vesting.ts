import { linearVestingBcs, VESTING_MODULE_BY_KIND, vestingEventBcs } from "@interest-protocol/blast-util-sdk/vesting";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";

import type { SponsorDerivedCall } from "./policy.ts";

/**
 * The vesting claim the `claim` intent sponsors beside the presale's own
 * (P-13): `blast_fun_linear_vesting::claim<T>(vesting, clock)`. At migration
 * the presale pays a vested share by creating and sharing a schedule of the
 * vesting package it links (util-contracts `sui/vesting` at `63b6cf8`,
 * T-036); `claim` pays what has vested since the last claim to the schedule's
 * `beneficiary`, whoever sends it, and aborts `ENothingClaimable` when
 * nothing has. Pinned here whole, as the Aftermath swap is: the package, the
 * function, its counts and the clock; the schedule (argument 0) is the one
 * the policy's facts name for the sender. A vesting upgrade that moves the
 * package makes these claims refused until this file is updated and reviewed.
 */

export const LINEAR_VESTING_MODULE = VESTING_MODULE_BY_KIND.linear;

/** `claim<T>(&mut Vesting<T>, &Clock, &mut TxContext)`: the schedule, then the system clock. */
export const LINEAR_VESTING_CLAIM_CALL: SponsorDerivedCall = {
  target: `${LINEAR_VESTING_MODULE}::claim`,
  argumentCount: 2,
  typeArgumentCount: 1,
  argumentKinds: [["shared"], ["shared"]],
  recipientArguments: [],
  fixedArguments: [],
  sharedObjects: [
    { position: 0, objectId: null },
    { position: 1, objectId: normalizeSuiAddress("0x6") },
  ],
};

/** The abort codes of `claim` (the clever errors' `errorCode`), by the module's names. */
export const LINEAR_VESTING_ABORTS: Readonly<Record<number, string>> = { 7: "ENothingClaimable" };

/** A schedule as the chain holds it: shared, its coin, and whom it pays. */
export type LinearVestingSchedule = Readonly<{ objectId: string; initialSharedVersion: string; coinType: string; beneficiary: string }>;

/**
 * A `Vesting<T>` object of the pinned package, read from a node's object
 * (its type, its shared owner and its BCS contents); null for anything else.
 */
export function decodeLinearVesting(object: Readonly<{
  objectId: string;
  type: string;
  owner: Readonly<{ $kind: string; Shared?: Readonly<{ initialSharedVersion: string | number }> }>;
  content: Uint8Array;
}>): LinearVestingSchedule | null {
  try {
    const tag = parseStructTag(object.type);
    if (normalizeSuiAddress(tag.address) !== VESTING_PACKAGE || tag.module !== LINEAR_VESTING_MODULE || tag.name !== "Vesting") return null;
    const [coinType, ...extra] = tag.typeParams;
    if (coinType === undefined || extra.length > 0 || object.owner.$kind !== "Shared" || !object.owner.Shared) return null;
    return {
      objectId: normalizeSuiAddress(object.objectId),
      initialSharedVersion: String(object.owner.Shared.initialSharedVersion),
      coinType: normalizeStructTag(coinType),
      beneficiary: normalizeSuiAddress(linearVestingBcs.parse(object.content).beneficiary),
    };
  } catch {
    return null;
  }
}

/** The claim of one schedule: every input resolved, so building needs no node. */
export function linearVestingClaim(schedule: Pick<LinearVestingSchedule, "objectId" | "initialSharedVersion" | "coinType">): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${VESTING_PACKAGE}::${LINEAR_VESTING_CLAIM_CALL.target}`,
    typeArguments: [normalizeStructTag(schedule.coinType)],
    arguments: [
      tx.sharedObjectRef({ objectId: schedule.objectId, initialSharedVersion: schedule.initialSharedVersion, mutable: true }),
      tx.object.clock(),
    ],
  });
  return tx;
}

/** The schedules a transaction's `VestingClaimed` events paid, and to whom. */
export function vestingClaimedEvents(events: readonly Readonly<{ eventType: string; bcs: Uint8Array }>[]): { vestingId: string; beneficiary: string; coinType: string }[] {
  return events.flatMap((event) => {
    try {
      const tag = parseStructTag(event.eventType);
      if (normalizeSuiAddress(tag.address) !== VESTING_PACKAGE || tag.module !== LINEAR_VESTING_MODULE || tag.name !== "VestingClaimed") return [];
      const payload = vestingEventBcs.linear.VestingClaimed.parse(event.bcs);
      return [{ vestingId: payload.vesting_id, beneficiary: payload.beneficiary, coinType: payload.coin_type }];
    } catch {
      return [];
    }
  });
}
