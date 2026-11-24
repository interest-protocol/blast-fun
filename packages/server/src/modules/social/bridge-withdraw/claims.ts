import { createHash, randomUUID } from "node:crypto";

import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import type { SocialRequestContext } from "@blast/server/modules/social/route-kit/route.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/** Network work is bounded below this lease; ownership is also checked on commit. */
export const WITHDRAWAL_CLAIM_MS = 120_000;
export type WithdrawalClaim = Readonly<{ withdrawal_id: string; owner_token: string }>;

export function withdrawalRequestHash(facts: Readonly<{ destination: string; recipient: string; amount: bigint; maxFee: bigint }>): string {
  return createHash("sha256").update(JSON.stringify([facts.destination, facts.recipient, facts.amount.toString(), facts.maxFee.toString()])).digest("hex");
}

export async function claimWithdrawal(context: SocialRequestContext, key: string, requestHash: string, at: number): Promise<WithdrawalClaim> {
  const owner = randomUUID();
  const claim = await context.transaction(async (social) => {
    const result = await social.write<WithdrawalClaim>("social_bridge_withdraw_claims", `INSERT INTO social_bridge_withdraw_claims
      (account_id, idempotency_key, request_hash, withdrawal_id, owner_token, lease_until_ms)
      VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::bigint)
      ON CONFLICT (account_id, idempotency_key) DO UPDATE
        SET owner_token = EXCLUDED.owner_token, lease_until_ms = EXCLUDED.lease_until_ms
        WHERE social_bridge_withdraw_claims.request_hash = EXCLUDED.request_hash
          AND social_bridge_withdraw_claims.lease_until_ms <= $7::bigint
      RETURNING withdrawal_id::text, owner_token::text`,
    [context.account!.account_id, key, requestHash, randomUUID(), owner, at + WITHDRAWAL_CLAIM_MS, at]);
    return result.rows[0];
  }, { label: "social.bridge_withdraw_claim" });
  // A concurrent owner can finish and the client then replays the ledger. A
  // different in-flight request cannot change the facts of this key either.
  if (!claim) throw new SocialRouteError("bridge_unavailable", { retryAfterSeconds: 1 });
  return claim;
}

export async function fenceWithdrawal(social: ModuleTransaction<"social">, claim: WithdrawalClaim, at: number): Promise<void> {
  const result = await social.read<{ owner_token: string; lease_until_ms: string }>(
    `SELECT owner_token::text, lease_until_ms::text FROM social_bridge_withdraw_claims WHERE withdrawal_id = $1::uuid FOR UPDATE`,
    [claim.withdrawal_id]);
  const held = result.rows[0];
  if (!held || held.owner_token !== claim.owner_token || Number(held.lease_until_ms) <= at)
    throw new SocialRouteError("bridge_unavailable", { retryAfterSeconds: 1 });
}

/** A failed owner can retry promptly; a dead process instead loses its bounded lease. */
export async function releaseWithdrawal(context: SocialRequestContext, claim: WithdrawalClaim, at: number): Promise<void> {
  await context.transaction(async (social) => {
    await social.write("social_bridge_withdraw_claims", `UPDATE social_bridge_withdraw_claims SET lease_until_ms = $3::bigint
      WHERE withdrawal_id = $1::uuid AND owner_token = $2::uuid`, [claim.withdrawal_id, claim.owner_token, at]);
  }, { label: "social.bridge_withdraw_release" });
}
