import { financialPlainCoinTypeSchema } from "./financial-wire.ts";
import { z } from "zod";

import { base64Schema, addressSchema } from "../../presale/contracts/primitives.ts";
import { sponsorResponseSchema } from "../../presale/contracts/transaction-responses.ts";

/**
 * A launch's creator caps (`blast_fun::creator_authority`, contracts ADR 0080 and 0082).
 *
 * A launch names its creator recipient once, in the generated coin package: an `Address`, or an
 * `Account` — a 32-byte opaque commitment for a Blast account or a verified X assignment. The recipient claims
 * the launch's `CurveFeeCap` and `BlastMetadataCap` once with `launch::claim_creator_caps`. An
 * account claim carries an expiring Ed25519 attestation that this backend signs over
 * `CreatorClaimMessage { meme, account_commitment, claimant, expiry_ms }`; the contract verifies
 * it against `RuntimeConfig.creator_claim_signer_public_key`.
 *
 * `GET /api/social/me/creator-commitment`: signed in with an account, bucket `social_read`,
 * primary, `private, no-store`. The account's commitment, minted at random on first read and
 * never changed; a launch names it to make this account its creator recipient.
 *
 * `GET /api/social/me/creator-caps?launch_id=…`: private eligibility for the signed-in
 * caller. Performs the same identity and live signer checks as preparation. Success
 * returns the launch ID and eligible wallet. This read does not record a claim or
 * prepare a transaction.
 *
 * `POST /api/social/me/creator-caps` (`{ launch_id }`): signed in with an account, bucket
 * `social_claim`, `private, no-store`. The route reads the launch from the chain, checks its
 * recipient is still unclaimed and is this caller. It checks the verified X user ID,
 * the Blast account commitment, or the claimant's wallet, then signs an account claim for the Blast
 * wallet, builds the claim with the SDK (both caps to the Blast wallet), and dry-runs it. Every
 * caller's claim, a Privy embedded wallet's or a wallet session's, is sponsored in-process
 * (server-built `creator_caps` intent; the public sponsor route refuses it). Nothing is logged: the claim's `CreatorCapsClaimed` event, which
 * blast-infra indexes, is its record.
 *
 * Refusals besides the kit's: `400 invalid_request` (the body), `403 not_creator_recipient`,
 * `409 blast_wallet_missing`, `409 creator_caps_claimed` (already claimed or reassigned),
 * `409 claim_unavailable` (no released launchpad deployment, no configured signer, or a signer
 * the chain does not hold), `409 nothing_to_claim` (the claim's dry run aborts), `429`/`503`
 * from the sponsor, `503 service_unavailable` (the node or the database).
 */
export const CREATOR_COMMITMENT_ROUTE = "GET /api/social/me/creator-commitment";
export const CREATOR_CAPS_ELIGIBILITY_ROUTE = "GET /api/social/me/creator-caps";
export const CREATOR_CAPS_ROUTE = "POST /api/social/me/creator-caps";

export const CREATOR_COMMITMENT_PATH = "/api/social/me/creator-commitment";
export const CREATOR_CAPS_PATH = "/api/social/me/creator-caps";

export const creatorCommitmentSchema = z.looseObject({
  account_commitment: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CreatorCommitment = Readonly<z.infer<typeof creatorCommitmentSchema>>;

export const creatorCapsEligibilitySchema = z.looseObject({
  launch_id: addressSchema,
  claimant: addressSchema,
});
export type CreatorCapsEligibility = Readonly<z.infer<typeof creatorCapsEligibilitySchema>>;

export const creatorCapsClaimSchema = z.looseObject({
  launch_id: addressSchema,
  meme_type: financialPlainCoinTypeSchema,
  recipient: z.enum(["address", "account"]),
  claimant: addressSchema,
  fee: z.enum(["sponsored", "wallet"]),
  transaction_kind_bytes: base64Schema,
  sponsored: sponsorResponseSchema.nullable(),
  attestation_expires_at_ms: z.number().refine(Number.isSafeInteger).nullable(),
}).refine((claim) => claim.recipient === "account"
  ? claim.attestation_expires_at_ms !== null
  : claim.attestation_expires_at_ms === null);
export type CreatorCapsClaim = Readonly<z.infer<typeof creatorCapsClaimSchema>>;
