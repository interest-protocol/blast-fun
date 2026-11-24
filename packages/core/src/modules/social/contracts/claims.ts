import { socialDigestSchema } from "./primitives.ts";
import {
  financialAddressSchema,
  financialUuidSchema,
  financialDigestSchema,
  financialBase64Schema,
  financialIntegerSchema,
  type FinancialReadonly,
} from "./financial-wire.ts";
import { z } from "zod";

import type { SocialTransactionFailure } from "./transactions.ts";

/**
 * The presale claim transaction (social feed R3-63): a backer claims what a
 * settled sale owes their Blast wallet — a cancelled sale's refund, or a
 * launched sale's tokens together with any oversubscribed remainder (the
 * contract pays both in one `blast_presale::claim`) — or what has vested of
 * a schedule the sale pays them (`claim_vesting`, P-13:
 * `blast_fun_linear_vesting::claim` of `schedule_id`). The operator's
 * delivery job relays the same call for everyone eventually; this is the
 * backer's own button.
 *
 * `PUT /api/social/me/claims/{request_id}`: signed in with an account, bucket
 * `social_claim`, primary, `private, no-store`. The client picks
 * `request_id` (a UUID v4) per attempt and calls it three times at most:
 *
 * 1. **Record** (`presale_id`, `kind`, and `schedule_id` exactly for
 *    `claim_vesting`): the route checks the claim against
 *    `chain_read_v1.presale_positions` (the Blast wallet still holds a
 *    commitment in a `cancelled` or `migrated` sale), or for a vesting claim
 *    `chain_read_v1.vesting_schedules` (the schedule of that sale pays the
 *    Blast wallet and has vested more than it paid), builds the claim's
 *    transaction kind from the deployment manifest, dry-runs it as the
 *    wallet, and logs the attempt in the account's transaction log (R3-27)
 *    **before anything is signed**: `submitted` with the kind bytes to sign,
 *    or `failed` / `dry_run_failed` naming the published abort.
 * 2. **Digest** (the same body plus `digest`), once the wallet signed and
 *    before the transaction is executed: recorded, then settled against the
 *    fullnode — `confirmed` when it executed as this claim, `failed` with
 *    `execution_failed` (it aborted) or `mismatch` (another transaction).
 *    `202` while the fullnode does not show it yet: send it again shortly.
 *    The social worker recovers it if the client never does: refund/token
 *    claims from the indexer, vesting claims from bounded fullnode reads of
 *    the recorded digest and immutable schedule binding.
 * 3. **Failure** (the same body plus `failure`), when nothing was sent: the
 *    wallet declined (`rejected`) or the sponsor's or wallet's own simulation
 *    refused it (`dry_run_failed`). Only for an attempt with no digest; a
 *    digest settles from the chain alone.
 *
 * Answers: `201` recorded now; `200` already recorded or settled; `202` a
 * digest awaiting the chain. Refusals besides the kit's: `400
 * invalid_parameter` (the id), `400 invalid_request` (the body), `404
 * not_found` (another account's id, or a digest or failure for an attempt
 * never recorded), `409 blast_wallet_missing`, `409 nothing_to_claim` (no
 * claim of that kind is open for the Blast wallet in that sale), `409
 * claim_conflict` (the id was recorded with another sale, kind or schedule, a second
 * digest, a digest another row holds, or a failure for an attempt with a
 * digest), `409 claim_unavailable` (no mainnet presale deployment manifest:
 * claiming is off, exactly as committing is), `503 service_unavailable`
 * (the node or the database).
 */
export const SOCIAL_CLAIM_ROUTE = "PUT /api/social/me/claims/{request_id}";

export function socialClaimPath(requestId: string): string {
  return `/api/social/me/claims/${encodeURIComponent(requestId)}`;
}

/** The log's supported backer and creator claim actions. */
export const SOCIAL_CLAIM_KINDS = [
  "claim_refund",
  "claim_tokens",
  "claim_vesting",
  "collect_fees",
  "claim_residuals",
] as const;
export type SocialClaimKind = (typeof SOCIAL_CLAIM_KINDS)[number];

export const socialClaimKindSchema = z.enum(SOCIAL_CLAIM_KINDS);

export function isSocialClaimKind(value: unknown): value is SocialClaimKind {
  return socialClaimKindSchema.safeParse(value).success;
}

/** What the client may report about an attempt it never sent (no digest). */
export const SOCIAL_CLAIM_CLIENT_FAILURES = [
  "rejected",
  "dry_run_failed",
] as const satisfies readonly SocialTransactionFailure[];
export type SocialClaimClientFailure =
  (typeof SOCIAL_CLAIM_CLIENT_FAILURES)[number];

export const socialClaimRequestSchema = z
  .strictObject({
    presale_id: financialAddressSchema,
    kind: socialClaimKindSchema,
    schedule_id: financialAddressSchema.optional(),
    vault_id: financialAddressSchema.optional(),
    digest: financialDigestSchema.optional(),
    failure: z.enum(SOCIAL_CLAIM_CLIENT_FAILURES).optional(),
    transaction_bytes: financialBase64Schema
      .min(1)
      .max(180000)
      .describe(
        "Canonical base64 full Sui TransactionData bytes. Required before execution; digest and sender must match the caller’s server-proven Blast wallet.",
      )
      .optional(),
  })
  .refine(claimIdentifiersMatch)
  .meta({
    title: "Record, then settle, a presale claim",
    description:
      "PUT /api/social/me/claims/{request_id} (R3-63): the sale and the kind of claim, with a schedule for vesting or a vault for creator actions; then the same body with the signed transaction's digest, or with why nothing was sent. Never both.",
  });

export type SocialClaimRequest = FinancialReadonly<
  z.infer<typeof socialClaimRequestSchema>
>;

export const socialClaimSchema = z
  .strictObject({
    request_id: financialUuidSchema,
    presale_id: financialAddressSchema,
    kind: socialClaimKindSchema,
    state: z.enum(["submitted", "confirmed", "failed"]),
    digest: financialDigestSchema.nullable(),
    failure_code: z
      .enum([
        "execution_failed",
        "mismatch",
        "dry_run_failed",
        "rejected",
        "expired",
      ])
      .nullable(),
    move_abort: z
      .string()
      .regex(/^E[A-Za-z]{1,63}$/)
      .nullable(),
    fee: z.enum(["sponsored", "wallet"]),
    transaction_kind_bytes: financialBase64Schema.max(21848).nullable(),
    created_at_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
    settled_at_ms: financialIntegerSchema
      .min(0)
      .meta({ type: "integer" })
      .nullable(),
  })
  .meta({
    title: "A presale claim attempt",
    description:
      "PUT /api/social/me/claims/{request_id} (R3-63): the attempt as the account's transaction log holds it, the claim's transaction kind to sign while it is submitted with no digest, and the presale abort the answer saw.",
  });

export type SocialClaim = FinancialReadonly<z.infer<typeof socialClaimSchema>>;

/** How long an attempt may stay `submitted` before the social worker marks it `expired`: one with no digest was never sent. */
export const CLAIM_UNSENT_EXPIRY_MS = 60 * 60_000;
/** A sent refund/token claim the indexer never showed, on the chain's clock: the commits' 24 hours. A sent vesting claim expires after the same day only while the indexer has no evidence for its digest. */
export const CLAIM_SENT_EXPIRY_MS = 24 * 60 * 60_000;

function claimIdentifiersMatch(body: {
  kind: SocialClaimKind;
  schedule_id?: string;
  vault_id?: string;
  digest?: string;
  failure?: string;
}): boolean {
  const creator =
    body.kind === "collect_fees" || body.kind === "claim_residuals";
  return (
    (body.kind === "claim_vesting") === (body.schedule_id !== undefined) &&
    creator === (body.vault_id !== undefined) &&
    !(body.digest !== undefined && body.failure !== undefined)
  );
}

/** Keep byte provenance validation at its existing transaction/ownership boundary. */
export const socialClaimInputSchema = z
  .strictObject({
    ...socialClaimRequestSchema.shape,
    digest: socialDigestSchema.optional(),
    transaction_bytes: z.unknown().optional(),
  })
  .refine(claimIdentifiersMatch);
