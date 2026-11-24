import { decodePresaleCreatorEvents } from "@interest-protocol/blast-sdk/presale";
import { vaultEventBcs } from "@interest-protocol/blast-sdk/vault";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import type { CreatorActionKind } from "../contracts/creator-earnings.ts";

export type CreatorEvent = Readonly<{ kind: CreatorActionKind; vaultId: string }>;

export function creatorEvents(
  events: readonly Readonly<{ eventType: string; bcs: Uint8Array }>[],
  vaultOriginalPackageId: string,
): CreatorEvent[] {
  const original = normalizeSuiAddress(vaultOriginalPackageId);
  const receipts: CreatorEvent[] = decodePresaleCreatorEvents(events, original);
  for (const event of events) {
    try {
      const tag = parseStructTag(event.eventType);
      if (tag.address !== original || tag.module !== "blast_vault_events" ||
        tag.name !== "OwnerBalancesClaimed" || tag.typeParams.length !== 2) continue;
      const receipt = vaultEventBcs.OwnerBalancesClaimed.parse(event.bcs);
      receipts.push({ kind: "claim_residuals", vaultId: normalizeSuiAddress(receipt.vault_id) });
    } catch {
      // Other events and malformed receipts do not prove this claim.
    }
  }
  return receipts;
}
