import { socialDigestSchema } from "./primitives.ts";
import { z } from "zod";
import {
  financialAddressSchema,
  financialUuidSchema,
  financialAtomsSchema,
  financialDigestSchema,
  financialBase64Schema,
  financialIntegerSchema,
  financialTextSchema,
  type FinancialReadonly,
} from "./financial-wire.ts";

/**
 * A launch creator's fee claim (LP-12): what a launch's `CurveFeeCap` can claim — the bonding
 * curve's creator fees (`claim_launch_fees`, the launchpad's `claim_creator_fees`), and once the
 * launch migrated, its vault's creator LP fees (`claim_launch_lp_fees`, the migrators'
 * `claim_creator_fees`). The cap is the entitlement: whoever holds it claims, and the fees pay
 * the cap's holder.
 *
 * `PUT /api/social/me/launch-claims/{request_id}`: signed in with an account, bucket
 * `social_claim`, primary, `private, no-store`. The client picks `request_id` (a UUID v4) per
 * attempt and calls it as the presale claim route is called (`claims.ts`):
 *
 * 1. **Record** (`launch_id`, `kind`): the route reads the launch's live `CurveFeeCap` from the
 *    launch object and checks the Blast wallet owns it, and that the ledger holds fees unclaimed
 *    — on chain, never from the client or the indexer. A vault claim takes its vault from
 *    blast-infra's launch rewards and holds it only if the chain shows it is the launch's (its
 *    coin types are the launch's own Meme and Quote). It then
 *    builds the claim from the released deployment with the SDK, dry-runs it as the wallet, and
 *    logs the attempt **before anything is signed**: `submitted` with the kind bytes to sign
 *    and the sponsored transaction, for every caller (the presale sponsor's server-built
 *    `launch_claim` intent); or `failed` / `dry_run_failed`.
 * 2. **Digest**, once the wallet signed and before the transaction is executed: recorded, then
 *    settled against the fullnode — `confirmed` when the wallet's transaction emitted the claim's
 *    event for that launch, else `failed` (`execution_failed`, `mismatch`). `202` while the
 *    fullnode does not show it yet. The social worker settles it from blast-infra's native
 *    evidence if the client never comes back, and expires an attempt never sent.
 * 3. **Failure**, when nothing was sent (`rejected`, `dry_run_failed`).
 *
 * Refusals besides the kit's: `400 invalid_parameter` (the id), `400 invalid_request` (the
 * body), `404 not_found`, `409 blast_wallet_missing`, `409 nothing_to_claim` (the Blast wallet
 * holds no cap of that launch, it has no migration vault for `claim_launch_lp_fees`, or the
 * chain shows nothing unclaimed), `409 claim_conflict`, `409 claim_unavailable` (no released launchpad
 * deployment), `429 rate_limited` (the sponsor's budgets), `503 service_unavailable`.
 */
export const LAUNCH_CLAIM_ROUTE =
  "PUT /api/social/me/launch-claims/{request_id}";

export function launchClaimPath(requestId: string): string {
  return `/api/social/me/launch-claims/${encodeURIComponent(requestId)}`;
}

/** The curve's creator fees, and the migration vault's creator LP fees. */
export const LAUNCH_CLAIM_KINDS = [
  "claim_launch_fees",
  "claim_launch_lp_fees",
] as const;
export type LaunchClaimKind = (typeof LAUNCH_CLAIM_KINDS)[number];

export function isLaunchClaimKind(value: unknown): value is LaunchClaimKind {
  return value === "claim_launch_fees" || value === "claim_launch_lp_fees";
}

export const launchClaimRequestSchema = z
  .strictObject({
    launch_id: financialAddressSchema,
    kind: z.enum(LAUNCH_CLAIM_KINDS),
    digest: financialDigestSchema.optional(),
    transaction_bytes: financialBase64Schema
      .min(1)
      .max(180000)
      .describe(
        "Canonical base64 full Sui TransactionData bytes, sent with the first digest. Its digest and sender must match the caller’s Blast wallet.",
      )
      .optional(),
    failure: z.enum(["rejected", "dry_run_failed"]).optional(),
  })
  .refine(claimOutcomeIsExclusive)
  .meta({
    title: "Record, then settle, a launch creator fee claim",
    description:
      "PUT /api/social/me/launch-claims/{request_id} (LP-12): the launch and which ledger's fees, the curve's or the migration vault's; then the same body with the signed transaction's digest, or with why nothing was sent. Never both. The server finds the cap and the vault.",
  });

export type LaunchClaimRequest = FinancialReadonly<
  z.infer<typeof launchClaimRequestSchema>
>;

export const launchClaimSchema = z
  .strictObject({
    request_id: financialUuidSchema,
    launch_id: financialAddressSchema,
    kind: z.enum(LAUNCH_CLAIM_KINDS),
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
    sponsored: z.xor([
      z.null(),
      z.strictObject({
        reservation_id: financialTextSchema({ minLength: 1, maxLength: 64 }),
        transaction_bytes: financialBase64Schema.max(32768),
        sponsor_signature: z.literal(""),
        expires_at_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
        gas_budget: financialAtomsSchema,
      }),
    ]),
    created_at_ms: financialIntegerSchema.min(0).meta({ type: "integer" }),
    settled_at_ms: financialIntegerSchema
      .min(0)
      .meta({ type: "integer" })
      .nullable(),
  })
  .meta({
    title: "A launch creator fee claim attempt",
    description:
      "PUT /api/social/me/launch-claims/{request_id} (LP-12): the attempt as the account's transaction log holds it, and while it is submitted with no digest, on the record's answer only, the claim's transaction kind and the sponsored transaction to sign (Blast pays gas for embedded and outside wallets alike).",
  });

export type LaunchClaim = FinancialReadonly<z.infer<typeof launchClaimSchema>>;

function claimOutcomeIsExclusive(body: {
  digest?: string;
  failure?: string;
}): boolean {
  return !(body.digest !== undefined && body.failure !== undefined);
}

export const launchClaimInputSchema = z
  .strictObject({
    ...launchClaimRequestSchema.shape,
    digest: socialDigestSchema.optional(),
    transaction_bytes: z.unknown().optional(),
  })
  .refine(claimOutcomeIsExclusive)
  .refine(
    (body) => body.transaction_bytes === undefined || body.digest !== undefined,
  );
