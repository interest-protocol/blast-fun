import { encodeCreatorClaimAttestation, encodeCreatorClaimMessage, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import { normalizeSuiAddress, toBase64, toHex } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SponsorResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import type { SocialTransferFee } from "@blast/core/modules/social/contracts/coins.ts";
import {
  CREATOR_CAPS_ROUTE,
  CREATOR_COMMITMENT_ROUTE,
  type CreatorCapsClaim,
  type CreatorCommitment,
} from "@blast/core/modules/social/contracts/creator-claims.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialJson, type SocialCaller, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { SponsorCaller } from "@blast/server/modules/sponsor/caller.ts";
import type { CreatorCapsChain } from "./chain.ts";
import { creatorCommitmentOf, readCreatorCommitment } from "./commitment.ts";
import type { CreatorClaimSigner } from "./signer.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The creator commitment and creator-caps routes (contract in `contracts/creator-claims.ts`).
 * Who may claim is read from the launch on chain, never taken from the client or the indexer.
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
  const { kit, database, chain, signer, blastWallet, sponsor } = dependencies;
  const now = dependencies.now ?? Date.now;

  /** An account recipient's attestation for `claimant`, once the launch names this account and the chain holds our key. */
  async function accountAttestation(
    launch: LaunchState,
    commitment: Uint8Array,
    accountId: string,
    claimant: string,
    reads: CreatorCapsChain,
    signal: AbortSignal,
  ): Promise<Readonly<{ attestation: Uint8Array; expiresAtMs: number }>> {
    const own = await readCreatorCommitment(database(), accountId);
    if (own === null || !sameBytes(own, commitment)) throw new SocialRouteError("not_creator_recipient");
    const key = signer();
    if (key === null || !(await reads.signerPublicKeys({ signal })).includes(Buffer.from(key.publicKey).toString("hex"))) {
      recordMetric("social.creator_caps", { outcome: "claim_unavailable", reason: key === null ? "no_signer" : "signer_mismatch" });
      throw new SocialRouteError("claim_unavailable");
    }
    const expiresAtMs = now() + CREATOR_CLAIM_ATTESTATION_MS;
    const message = encodeCreatorClaimMessage({ memeType: launch.memeType, accountCommitment: commitment, claimant, expiryMs: BigInt(expiresAtMs) });
    return { attestation: encodeCreatorClaimAttestation(BigInt(expiresAtMs), await key.sign(message)), expiresAtMs };
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

  const caps = kit.route(
    { name: CREATOR_CAPS_ROUTE, auth: "account", account: "required", bucket: "social_claim", cache: "private" },
    async (context) => {
      const { launch_id: launchId } = await readSocialJson(context.request, ["launch_id"]);
      if (typeof launchId !== "string" || !SUI_OBJECT_ID_PATTERN.test(launchId)) throw new SocialRouteError("invalid_request");
      const caller = context.caller!;
      // Blast's gas pool pays for a Privy embedded wallet and a wallet session alike (owner ruling 2026-11-20).
      const fee: SocialTransferFee = "sponsored";
      const claimant = await blastWallet(caller);
      if (claimant === null) throw new SocialRouteError("blast_wallet_missing");

      const reads = await chain();
      if (reads === null) throw new SocialRouteError("claim_unavailable");
      const launch = await reads.launch(launchId);
      if (launch === null) throw new SocialRouteError("not_found");
      // The recipient is consumed by the claim and cleared by an administrator's reassignment.
      const recipient = launch.creatorRecipient;
      if (recipient === null) throw new SocialRouteError("creator_caps_claimed");

      const { signal } = context.request;
      let attestation: Uint8Array | null = null;
      let expiresAtMs: number | null = null;
      if (recipient.kind === "address") {
        if (normalizeSuiAddress(recipient.address) !== normalizeSuiAddress(claimant)) throw new SocialRouteError("not_creator_recipient");
      } else {
        ({ attestation, expiresAtMs } = await accountAttestation(launch, recipient.accountCommitment, context.account!.account_id, claimant, reads, signal));
      }

      const labels = { recipient: recipient.kind, fee };
      const kindBytes = await reads.kind({ launch, claimant, attestation });
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
        recipient: recipient.kind,
        claimant: normalizeSuiAddress(claimant),
        fee,
        transaction_kind_bytes: toBase64(kindBytes),
        sponsored,
        attestation_expires_at_ms: expiresAtMs,
      } satisfies CreatorCapsClaim);
    },
  );

  return Object.freeze({ commitment, caps });
}

export type CreatorClaimRoutes = ReturnType<typeof createCreatorClaimRoutes>;
