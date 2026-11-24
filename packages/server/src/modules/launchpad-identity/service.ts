import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";

import { parseSerializedSignature } from "@mysten/sui/cryptography";
import type { Pool } from "pg";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import type { PrivySession } from "@blast/core/lib/privy-adapter/types.ts";
import type { RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import {
  verifySuiPersonalMessage,
  type WalletPersonalMessageVerifier,
} from "@blast/server/modules/mission-control/wallet-challenges/service.ts";
import {
  LAUNCHPAD_WALLET_PROOF_TTL_MS,
  canonicalOrigin,
  canonicalSuiAddress,
  parseLaunchpadProofAction,
  type LaunchpadActor,
  type LaunchpadProofAction,
  type LaunchpadWalletProof,
} from "@blast/server/modules/launchpad-identity/contracts.ts";
import { LaunchpadMutationError } from "@blast/server/modules/launchpad-identity/errors.ts";
import {
  buildLaunchpadProofMessage,
  extractProofNonce,
  isProofNonce,
  sha256,
} from "@blast/server/modules/launchpad-identity/message.ts";
import type { CheckedWalletProof, LaunchpadIdentity } from "@blast/server/modules/launchpad-identity/mutation.ts";
import { LaunchpadChallengeRepository } from "@blast/server/modules/launchpad-identity/repository.ts";

export interface IssueLaunchpadChallengeRequest {
  action: LaunchpadProofAction;
  address: string;
  origin: string;
}

/** Returned to the requester only, to sign; never stored or logged. */
export interface IssuedLaunchpadChallenge extends IssueLaunchpadChallengeRequest {
  challengeId: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
}

export interface LaunchpadIdentityServiceDependencies {
  /**
   * Counts challenge issues (`launchpad_wallet_proof_issue`, per client IP)
   * and proof checks (`launchpad_wallet_proof`, per IP and address).
   */
  limiter: RateLimitPort;
  /** A verified Privy session of any login method (`createPrivySessionVerifier`). */
  verifyPrivySession(accessToken: string): Promise<PrivySession>;
  /** Keys the Privy subject hash; at least 32 characters. */
  subjectPepper: string;
  clock?: () => Date;
  createId?: () => string;
  createNonce?: () => string;
  /** Throws only when verification is unavailable (default `verifyLaunchpadSignature`). */
  verifyPersonalMessage?: WalletPersonalMessageVerifier;
  repository?: LaunchpadChallengeRepository;
}

const encoder = new TextEncoder();

/**
 * gRPC statuses with which a fullnode rejects the signature it was sent: the
 * input is wrong, so the proof is invalid. Every other status, and any error
 * without one (network, transport, abort), means the fullnode could not answer.
 */
const FULLNODE_INVALID_INPUT = new Set(["INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE"]);

/**
 * Only plain zkLogin proofs report a verifier outage to launchpad callers.
 */
function reportFullnodeOutage(parsed: ReturnType<typeof parseSerializedSignature>): boolean {
  return parsed.signatureScheme === "ZkLogin";
}

function fullnodeRejectedInput(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && FULLNODE_INVALID_INPUT.has(code);
}

/**
 * Verifies a Wallet Proof signature and says only valid (true) or invalid
 * (false); it throws only when the verifier is unavailable.
 *
 * - A signature that does not decode, has the wrong length or names an
 *   unknown scheme is invalid.
 * - Ed25519, secp256k1, secp256r1, passkey and ordinary multisig verify
 *   locally. A multisig with a submitted zkLogin partial uses a fullnode.
 *   A verification failure for any of these signatures counts as invalid.
 * - A plain zkLogin signature needs a fullnode. A fullnode that rejects the
 *   input (`INVALID_ARGUMENT`,
 *   `FAILED_PRECONDITION`, `OUT_OF_RANGE`) or answers "not valid" makes it
 *   invalid; any other status or a network failure is an outage and throws.
 */
export async function verifyLaunchpadSignature(
  message: Uint8Array,
  signature: string,
  address: string,
  verify: WalletPersonalMessageVerifier = verifySuiPersonalMessage,
): Promise<boolean> {
  let reportOutage: boolean;
  try {
    reportOutage = reportFullnodeOutage(parseSerializedSignature(signature));
  } catch {
    return false;
  }
  try {
    return await verify(message, signature, address);
  } catch (error) {
    if (reportOutage && !fullnodeRejectedInput(error)) throw error;
    return false;
  }
}

function authInvalid(): LaunchpadMutationError {
  return new LaunchpadMutationError("LAUNCHPAD_AUTH_INVALID");
}

/**
 * The launchpad's identity boundary: Privy sessions and free Wallet Proofs
 * (signed personal messages, never transactions) for protected writes. Its
 * challenges live in their own table, apart from Mission Control's.
 */
export class LaunchpadIdentityService implements LaunchpadIdentity {
  readonly #pool: Pool;
  readonly #limiter: RateLimitPort;
  readonly #verifyPrivySession: (accessToken: string) => Promise<PrivySession>;
  readonly #subjectPepper: string;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #createNonce: () => string;
  readonly #verifyPersonalMessage: WalletPersonalMessageVerifier;
  readonly #repository: LaunchpadChallengeRepository;

  constructor(pool: Pool, dependencies: LaunchpadIdentityServiceDependencies) {
    if (dependencies.subjectPepper.length < MINIMUM_SECRET_LENGTH) {
      throw new TypeError("The launchpad subject pepper must be at least 32 characters.");
    }
    this.#pool = pool;
    this.#limiter = dependencies.limiter;
    this.#verifyPrivySession = dependencies.verifyPrivySession;
    this.#subjectPepper = dependencies.subjectPepper;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createNonce = dependencies.createNonce ?? (() => randomBytes(32).toString("base64url"));
    this.#verifyPersonalMessage = dependencies.verifyPersonalMessage ?? verifyLaunchpadSignature;
    this.#repository = dependencies.repository ?? new LaunchpadChallengeRepository();
  }

  async #takeBudget(
    bucket: "launchpad_wallet_proof" | "launchpad_wallet_proof_issue",
    subject: RateLimitSubject,
  ): Promise<void> {
    let decision;
    try {
      decision = await this.#limiter.consume(bucket, subject);
    } catch {
      throw new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE");
    }
    if (!decision.allowed) {
      throw new LaunchpadMutationError("LAUNCHPAD_RATE_LIMITED", decision.retryAfterSeconds);
    }
  }

  async issueChallenge(
    request: IssueLaunchpadChallengeRequest,
    context: Readonly<{ ip: string }>,
  ): Promise<IssuedLaunchpadChallenge> {
    let binding: IssueLaunchpadChallengeRequest;
    try {
      binding = {
        action: parseLaunchpadProofAction(request.action),
        address: canonicalSuiAddress(request.address),
        origin: canonicalOrigin(request.origin),
      };
    } catch {
      throw new LaunchpadMutationError("LAUNCHPAD_REQUEST_INVALID");
    }
    await this.#takeBudget("launchpad_wallet_proof_issue", { ip: context.ip });

    const issuedAt = this.#clock();
    const expiresAt = new Date(issuedAt.getTime() + LAUNCHPAD_WALLET_PROOF_TTL_MS);
    const nonce = this.#createNonce();
    if (!isProofNonce(nonce)) throw new Error("The nonce source returned an invalid nonce.");
    const message = buildLaunchpadProofMessage({
      ...binding,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const challengeId = this.#createId();
    await this.#repository.create(this.#pool, {
      challengeId,
      ...binding,
      nonceHash: sha256(nonce),
      messageHash: sha256(message),
      issuedAt,
      expiresAt,
      consumedAt: null,
    });
    return {
      challengeId,
      ...binding,
      message,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async authenticatePrivy(accessToken: string): Promise<LaunchpadActor> {
    let session: PrivySession;
    try {
      session = await this.#verifyPrivySession(accessToken);
    } catch (error) {
      const code = error instanceof PrivyAdapterError ? error.code : "unknown";
      if (code === "INVALID_ACCESS_TOKEN" || code === "ACCESS_TOKEN_EXPIRED") {
        throw authInvalid();
      }
      recordMetric("launchpad.identity", { error: errorLabel(error), outcome: "error", step: "privy" });
      throw new LaunchpadMutationError("LAUNCHPAD_AUTH_UNAVAILABLE");
    }
    return {
      method: "privy",
      subjectKey: createHmac("sha256", this.#subjectPepper)
        .update(`launchpad-privy-subject\0${session.privyDid}`)
        .digest("hex"),
      walletAddress: session.suiWalletAddress,
    };
  }

  async checkWalletProof(
    proof: LaunchpadWalletProof,
    binding: Readonly<{ action: LaunchpadProofAction; origin: string }>,
    context: Readonly<{ ip: string }>,
  ): Promise<CheckedWalletProof> {
    await this.#takeBudget("launchpad_wallet_proof", {
      ip: context.ip,
      address: proof.address,
      operation: "verify",
    });
    const stored = await this.#repository.find(this.#pool, proof.challengeId);
    const now = this.#clock();
    const nonce = extractProofNonce(proof.message);
    const messageHash = sha256(proof.message);
    if (
      !stored ||
      stored.consumedAt !== null ||
      now.getTime() >= stored.expiresAt.getTime() ||
      stored.action !== binding.action ||
      stored.origin !== binding.origin ||
      stored.address !== proof.address ||
      stored.messageHash !== messageHash ||
      !nonce ||
      stored.nonceHash !== sha256(nonce)
    ) {
      throw authInvalid();
    }

    let valid: boolean;
    try {
      valid = await this.#verifyPersonalMessage(
        encoder.encode(proof.message),
        proof.signature,
        stored.address,
      );
    } catch (error) {
      recordMetric("launchpad.identity", { error: errorLabel(error), outcome: "error", step: "signature" });
      throw new LaunchpadMutationError("LAUNCHPAD_AUTH_UNAVAILABLE");
    }
    if (!valid) throw authInvalid();

    return {
      action: binding.action,
      address: stored.address,
      challengeId: stored.challengeId,
      messageHash,
      origin: stored.origin,
    };
  }

  async consumeWalletProof(
    transaction: TransactionContext,
    proof: CheckedWalletProof,
  ): Promise<LaunchpadActor> {
    if (!(await this.#repository.consume(transaction, proof, this.#clock()))) {
      throw authInvalid();
    }
    return { method: "wallet_proof", walletAddress: proof.address };
  }
}
