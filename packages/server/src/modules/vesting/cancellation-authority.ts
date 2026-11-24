import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import { VESTING_MODULE_BY_KIND } from "@interest-protocol/blast-util-sdk/vesting";
import { bcs } from "@mysten/sui/bcs";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { SuiClientTypes } from "@mysten/sui/client";
import type { PublicVesting } from "@blast/core/modules/vesting/model.ts";

const cancelCapBcs = bcs.struct("CancelCap", {
  id: bcs.Address,
  vesting_id: bcs.Address,
});

type Schedule = Pick<
  PublicVesting,
  | "schedule_id"
  | "status"
  | "cancel_cap_id"
  | "refund_recipient"
  | "coin_type"
  | "terms"
>;
type CapObject = Pick<
  SuiClientTypes.Object<{ content: true }>,
  "objectId" | "type" | "owner" | "content"
>;

/** An unavailable authority read must not become a confirmed denial. */
export async function cancellationCapForWallet(
  schedule: Schedule,
  sender: string,
  packageId: string,
  getObject: (id: string) => Promise<CapObject | null>,
): Promise<string | null> {
  if (schedule.status !== "active" || !schedule.refund_recipient) return null;
  if (!schedule.cancel_cap_id)
    throw new VestingReadError("authority_unavailable");
  const object = await getObject(schedule.cancel_cap_id);
  if (!object) return null;
  const contractModule = VESTING_MODULE_BY_KIND[schedule.terms.kind];
  const expectedType = `${packageId}::${contractModule}::CancelCap<${schedule.coin_type}>`;
  if (
    normalizeStructTag(object.type) !== normalizeStructTag(expectedType) ||
    object.owner.$kind !== "AddressOwner" ||
    normalizeSuiAddress(object.owner.AddressOwner) !==
      normalizeSuiAddress(sender)
  )
    return null;
  const cap = cancelCapBcs.parse(object.content);
  if (
    cap.id !== schedule.cancel_cap_id ||
    cap.vesting_id !== schedule.schedule_id
  )
    return null;
  return object.objectId;
}
