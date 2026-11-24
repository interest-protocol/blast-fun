import type { MePresalePosition } from "@blast/core/web/contracts/profile-page.ts";
import type { ClaimKind } from "./claims";
import type { Claims } from "./use-claims";

/** A confirmed execution wins over stale reads. */
export function claimDone(claims: Claims, id: string, kind: Exclude<ClaimKind, "claim_vesting">): boolean {
  return claims.view(`${kind === "claim_tokens" ? "tokens" : "refund"}:${id}`).state === "done";
}

export function projectClaimPosition(position: MePresalePosition, claims: Claims): MePresalePosition {
  const kind = position.presale.status === "cancelled" ? "claim_refund" : "claim_tokens";
  // The pre-claim row may contain zero placeholders; delivered amounts are still unknown.
  return position.status === "claimable" && claimDone(claims, position.presale.presale_id, kind)
    ? { ...position, status: "delivered", claimed_tokens: null, value_usd: null }
    : position;
}
