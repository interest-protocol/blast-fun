import { encodeCreatorClaimAttestation, encodeCreatorClaimMessage, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import { normalizeStructTag, normalizeSuiAddress, toBase64, toHex } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SponsorResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import type { SocialTransferFee } from "@blast/core/modules/social/contracts/coins.ts";
import {
  CREATOR_CAPS_ELIGIBILITY_ROUTE,
  CREATOR_CAPS_ROUTE,
  CREATOR_COMMITMENT_ROUTE,
  type CreatorCapsClaim,
  type CreatorCapsEligibility,
  type CreatorCommitment,
} from "@blast/core/modules/social/contracts/creator-claims.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { SponsorCaller } from "@blast/server/modules/sponsor/caller.ts";
import type { CreatorCapsChain } from "./chain.ts";
import type { ReadPublishedLaunch } from "@blast/server/modules/social/launch/reconcile.ts";
import { readLaunchCreatorXRecipient, recordLaunchPublished } from "@blast/server/modules/social/launch/store.ts";
import { creatorCommitmentOf, readCreatorCommitment } from "./commitment.ts";
import type { CreatorClaimSigner } from "./signer.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The creator commitment and creator-caps routes (contract in `contracts/creator-claims.ts`).
 * The launch on chain determines the recipient. Account claims require server-verified identity.
 */

export type CreatorCapsSponsorRequest = Readonly<{ caller: SponsorCaller; sender: string; kindBytes: Uint8Array; ip: string; signal: AbortSignal }>;

export type CreatorClaimRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary: a commitment minted a moment ago is read back at once. */
  database: () => ReadableDatabase;
  /** The released launchpad deployment's chain, or null while none is released: claiming is off. */
  chain: () => Promise<CreatorCapsChain | null>;
  /** The configured attestation signer, or null while none is: account claims are off. */
  signer: () => CreatorClaimSigner | null;
  /** The caller's Blast wallet: a Privy session's embedded Sui wallet, a wallet session's own address. */
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
  linkedXSubject: (did: string) => Promise<string | null>;
  readPublishedLaunch: ReadPublishedLaunch;
  /** The presale sponsor's server-built `creator_caps`; throws its `PresaleRouteError`s. */
  sponsor: (request: CreatorCapsSponsorRequest) => Promise<SponsorResponse>;
  now?: () => number;
}>;

/** How long a signed account attestation verifies: long enough to sign and send, short enough to be useless once leaked. */
export const CREATOR_CLAIM_ATTESTATION_MS = 5 * 60_000;

const sameBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((byte, index) => byte === right[index]);

/** A sponsor refusal in the route's own codes: its budgets are a rate limit, anything else is unavailable. */
function sponsorRefusal(error: unknown): never {
  if (!(error instanceof PresaleRouteError)) throw error;
  const limited = error.code === "budget_exceeded" || error.code === "rate_limited";
  throw new SocialRouteError(limited ? "rate_limited" : "service_unavailable", {
    extra: { reasons: ["sponsorship_unavailable"] },
    retryAfterSeconds: error.retryAfterSeconds ?? undefined,
  });
}

export function createCreatorClaimRoutes(dependencies: CreatorClaimRouteDependencies) {
  const { kit, database, chain, signer, blastWallet, linkedXSubject, sponsor } = dependencies;
  const now = dependencies.now ?? Date.now;

  async function verifyAccountRecipient(context: SocialRequestContext, launch: LaunchState, commitment: Uint8Array) {
    const caller = context.caller!;
    const db = database();
    const assignedX = await readLaunchCreatorXRecipient(db, launch.objectId, commitment);
    if (assignedX === null) {
      const own = await readCreatorCommitment(db, context.account!.account_id);
      if (own === null || !sameBytes(own, commitment)) {
        throw new SocialRouteError("not_creator_recipient");
      }
      return null;
    }

    if (caller.kind !== "privy" || !sameBytes(assignedX.creator_x_commitment, commitment)
      || (assignedX.published_launch_id !== null && assignedX.published_launch_id !== launch.objectId)) {
      throw new SocialRouteError("not_creator_recipient");
    }
    const subject = await linkedXSubject(caller.did).catch(() => {
      throw new SocialRouteError("service_unavailable");
    });
    if (subject !== assignedX.creator_x_subject) {
      throw new SocialRouteError("not_creator_recipient");
    }
    if (assignedX.published_launch_id === launch.objectId) return null;

    const proof = assignedX.creation && await dependencies.readPublishedLaunch(assignedX.creation, context.request.signal);
    if (!proof || proof.launchId !== launch.objectId || normalizeStructTag(proof.memeType) !== normalizeStructTag(launch.memeType)) {
      throw new SocialRouteError("not_creator_recipient");
    }
    return { accountId: assignedX.account_id, draftId: assignedX.draft_id };
  }

  async function admittedSigner(reads: CreatorCapsChain, signal: AbortSignal): Promise<CreatorClaimSigner> {
    const key = signer();
    if (key === null || !(await reads.signerPublicKeys({ signal })).includes(Buffer.from(key.publicKey).toString("hex"))) {
      recordMetric("social.creator_caps", { outcome: "claim_unavailable", reason: key === null ? "no_signer" : "signer_mismatch" });
      throw new SocialRouteError("claim_unavailable");
    }
    return key;
  }

  async function accountAttestation(launch: LaunchState, commitment: Uint8Array, claimant: string, key: CreatorClaimSigner) {
    const expiresAtMs = now() + CREATOR_CLAIM_ATTESTATION_MS;
    const message = encodeCreatorClaimMessage({ memeType: launch.memeType, accountCommitment: commitment, claimant, expiryMs: BigInt(expiresAtMs) });
    return { attestation: encodeCreatorClaimAttestation(BigInt(expiresAtMs), await key.sign(message)), expiresAtMs };
  }

  async function eligibleClaim(context: SocialRequestContext, launchId: unknown) {
    if (typeof launchId !== "string" || !SUI_OBJECT_ID_PATTERN.test(launchId)) throw new SocialRouteError("invalid_request");
    const caller = context.caller!;
    const wallet = await blastWallet(caller);
    if (wallet === null) throw new SocialRouteError("blast_wallet_missing");
    const claimant = normalizeSuiAddress(wallet);

    const reads = await chain();
    if (reads === null) throw new SocialRouteError("claim_unavailable");
    const launch = await reads.launch(launchId);
    if (launch === null) throw new SocialRouteError("not_found");
    // The recipient is consumed by the claim or cleared by an administrator's reassignment.
    const recipient = launch.creatorRecipient;
    if (recipient === null) throw new SocialRouteError("creator_caps_claimed");
    const target = { caller, claimant, reads, launch };
    if (recipient.kind === "address") {
      if (normalizeSuiAddress(recipient.address) !== claimant) throw new SocialRouteError("not_creator_recipient");
      return { ...target, recipient: "address" as const, account: null };
    }

    const assignment = await verifyAccountRecipient(context, launch, recipient.accountCommitment);
    const key = await admittedSigner(reads, context.request.signal);
    return { ...target, recipient: "account" as const, account: { assignment, key, commitment: recipient.accountCommitment } };
  }

  const commitment = kit.route(
    { name: CREATOR_COMMITMENT_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
    async (context) => {
      const accountId = context.account!.account_id;
      const own =
        (await readCreatorCommitment(database(), accountId)) ??
        (await context.transaction((social) => creatorCommitmentOf(social, accountId), { label: "social.creator_commitment" }));
      return context.json({ account_commitment: toHex(own) } satisfies CreatorCommitment);
    },
  );

  const eligibility = kit.route(
    { name: CREATOR_CAPS_ELIGIBILITY_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
    async (context) => {
      const launchId = new URL(context.request.url).searchParams.get("launch_id");
      const { launch, claimant } = await eligibleClaim(context, launchId);
      return context.json({ launch_id: launch.objectId, claimant } satisfies CreatorCapsEligibility);
    },
  );

  const caps = kit.route(
    { name: CREATOR_CAPS_ROUTE, auth: "account", account: "required", bucket: "social_claim", cache: "private" },
    async (context) => {
      const { launch_id: launchId } = await readSocialJson(context.request, ["launch_id"]);
      const { caller, claimant, reads, launch, recipient, account } = await eligibleClaim(context, launchId);
      const assignment = account?.assignment;
      if (assignment) {
        const outcome = await context.transaction(
          (social) => recordLaunchPublished(social, assignment.accountId, assignment.draftId, launch.objectId),
          { label: "social.launch_published" },
        );
        if (outcome.kind !== "already" && outcome.kind !== "recorded") throw new SocialRouteError("not_creator_recipient");
      }

      const { signal } = context.request;
      // Blast pays for embedded wallets and wallet sessions alike.
      const fee: SocialTransferFee = "sponsored";
      const signed = account ? await accountAttestation(launch, account.commitment, claimant, account.key) : null;
      const labels = { recipient, fee };
      const kindBytes = await reads.kind({ launch, claimant, attestation: signed?.attestation ?? null });
      const simulation = await reads.simulate(kindBytes, claimant, { signal });
      if (simulation.status === "failure") {
        recordMetric("social.creator_caps", { outcome: "dry_run_failed", reason: simulation.reason, ...labels });
        throw new SocialRouteError("nothing_to_claim");
      }
      const sponsored = await sponsor({ caller, sender: claimant, kindBytes, ip: context.client.rateKey, signal }).catch(sponsorRefusal);
      recordMetric("social.creator_caps", { outcome: "prepared", ...labels });
      return context.json({
        launch_id: launch.objectId,
        meme_type: launch.memeType,
        recipient,
        claimant,
        fee,
        transaction_kind_bytes: toBase64(kindBytes),
        sponsored,
        attestation_expires_at_ms: signed?.expiresAtMs ?? null,
      } satisfies CreatorCapsClaim);
    },
  );

  return Object.freeze({ commitment, eligibility, caps });
}

export type CreatorClaimRoutes = ReturnType<typeof createCreatorClaimRoutes>;
