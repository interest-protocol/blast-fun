import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { z } from "zod";
import { randomBytes, randomUUID } from "node:crypto";

import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidPersonalMessageSignature } from "@mysten/sui/verify";
import type { Pool } from "pg";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import type {
  WalletChallengeRateLimiter,
  WalletRateSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import {
  parseIssueWalletChallengeRequest,
  parseVerifyWalletChallengeRequest,
  type IssueWalletChallengeRequest,
  type IssuedWalletChallenge,
  type VerifyWalletChallengeRequest,
  type WalletControlProof,
} from "@blast/server/modules/mission-control/wallet-challenges/contracts.ts";
import { WalletChallengeError } from "@blast/server/modules/mission-control/wallet-challenges/errors.ts";
import {
  WALLET_CHALLENGE_TTL_MS,
  buildWalletChallengeMessage,
  extractWalletChallengeNonce,
  sha256,
} from "@blast/server/modules/mission-control/wallet-challenges/message.ts";
import {
  WalletChallengeRepository,
  type StoredWalletChallenge,
} from "@blast/server/modules/mission-control/wallet-challenges/repository.ts";


export type WalletPersonalMessageVerifier = (
  message: Uint8Array,
  signature: string,
  address: string,
) => Promise<boolean>;

export interface WalletChallengeServiceDependencies {
  rateLimiter: WalletChallengeRateLimiter;
  clock?: () => Date;
  createId?: () => string;
  createNonce?: () => string;
  verifyPersonalMessage?: WalletPersonalMessageVerifier;
  repository?: WalletChallengeRepository;
}

const encoder = new TextEncoder();

// Signatures carrying a zkLogin proof need a fullnode.
let suiVerifier: WalletPersonalMessageVerifier | undefined;

/**
 * Construction-only transport seam; request data cannot select an RPC
 * endpoint. The node defaults to the process's mainnet node
 * (`RuntimeConfig.suiNodeUrl`).
 */
export function createSuiPersonalMessageVerifier(
  options: Readonly<{
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  }> = {},
): WalletPersonalMessageVerifier {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const baseUrl = options.baseUrl ?? runtimeConfig().suiNodeUrl;
  const client = new SuiGrpcClient({
    network: "mainnet",
    baseUrl,
    format: "text",
    timeout: timeoutMs,
    fetch: boundedFetch(timeoutMs, options.fetch),
  });
  return async (message, signature, address) => {
    let parsed: ReturnType<typeof parseSerializedSignature>;
    try {
      parsed = parseSerializedSignature(signature);
    } catch {
      return false;
    }
    if (
      parsed.signatureScheme === "ZkLogin" ||
      (parsed.signatureScheme === "MultiSig" &&
        parsed.multisig.sigs.some((partial) => "ZkLogin" in partial))
    ) {
      return isValidPersonalMessageSignature(message, signature, {
        address,
        client,
        checkAddressAliases: false,
      });
    }
    return isValidPersonalMessageSignature(message, signature, { address, offline: true });
  };
}

/** Verifies a Sui personal-message signature (shared with launchpad-identity). */
export async function verifySuiPersonalMessage(
  message: Uint8Array,
  signature: string,
  address: string,
): Promise<boolean> {
  suiVerifier ??= createSuiPersonalMessageVerifier();
  return suiVerifier(message, signature, address);
}

function sameContext(
  left: StoredWalletChallenge["context"],
  right: StoredWalletChallenge["context"],
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export class WalletChallengeService {
  readonly #pool: Pool;
  readonly #rateLimiter: WalletChallengeRateLimiter;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #createNonce: () => string;
  readonly #verifyPersonalMessage: WalletPersonalMessageVerifier;
  readonly #repository: WalletChallengeRepository;

  constructor(pool: Pool, dependencies: WalletChallengeServiceDependencies) {
    this.#pool = pool;
    this.#rateLimiter = dependencies.rateLimiter;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#createNonce =
      dependencies.createNonce ?? (() => randomBytes(32).toString("base64url"));
    this.#verifyPersonalMessage =
      dependencies.verifyPersonalMessage ?? verifySuiPersonalMessage;
    this.#repository =
      dependencies.repository ?? new WalletChallengeRepository();
  }

  async #takeRateLimit(
    operation: "issue" | "verify",
    subject: WalletRateSubject,
  ): Promise<void> {
    const rate = await this.#rateLimiter.consume({ operation, subject });
    if (!rate.allowed) {
      throw new WalletChallengeError(
        "WALLET_CHALLENGE_RATE_LIMITED",
        rate.retryAfterSeconds,
      );
    }
  }

  async issue(
    requestValue: IssueWalletChallengeRequest,
    subject: WalletRateSubject,
  ): Promise<IssuedWalletChallenge> {
    await this.#takeRateLimit("issue", subject);
    let request: IssueWalletChallengeRequest;
    try {
      request = parseIssueWalletChallengeRequest(requestValue);
    } catch {
      throw new WalletChallengeError("WALLET_CHALLENGE_REQUEST_INVALID");
    }

    const issuedAt = this.#clock();
    const expiresAt = new Date(issuedAt.getTime() + WALLET_CHALLENGE_TTL_MS);
    const nonce = this.#createNonce();
    if (!z.string().regex(/^[A-Za-z0-9_-]{43}$/).safeParse(nonce).success) {
      throw new Error("Wallet challenge nonce source returned an invalid nonce.");
    }
    const message = buildWalletChallengeMessage({
      ...request,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const challengeId = this.#createId();

    await this.#repository.create(this.#pool, {
      challengeId,
      ...request,
      nonceHash: sha256(nonce),
      messageHash: sha256(message),
      issuedAt,
      expiresAt,
      consumedAt: null,
    });

    return {
      challengeId,
      ...request,
      message,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(
    requestValue: VerifyWalletChallengeRequest,
    subject: WalletRateSubject,
  ): Promise<WalletControlProof> {
    await this.#takeRateLimit("verify", subject);
    let request: VerifyWalletChallengeRequest;
    try {
      request = parseVerifyWalletChallengeRequest(requestValue);
    } catch {
      throw new WalletChallengeError("WALLET_PROOF_INVALID");
    }

    return withTransaction(this.#pool, async (transaction) => {
      const database = transaction.forModule("wallet-challenge");
      const stored = await this.#repository.lockById(
        database,
        request.challengeId,
      );
      const verifiedAt = this.#clock();
      const nonce = extractWalletChallengeNonce(request.message);

      if (
        !stored ||
        stored.consumedAt !== null ||
        verifiedAt.getTime() >= stored.expiresAt.getTime() ||
        stored.action !== request.action ||
        stored.address !== request.address ||
        stored.origin !== request.origin ||
        !sameContext(stored.context, request.context) ||
        stored.messageHash !== sha256(request.message) ||
        !nonce ||
        stored.nonceHash !== sha256(nonce)
      ) {
        throw new WalletChallengeError("WALLET_PROOF_INVALID");
      }

      let signatureIsValid: boolean;
      try {
        signatureIsValid = await this.#verifyPersonalMessage(
          encoder.encode(request.message),
          request.signature,
          stored.address,
        );
      } catch (error) {
        recordMetric("wallet_challenge.verify", {
          error: errorLabel(error),
          outcome: "error",
        });
        throw new WalletChallengeError("WALLET_PROOF_UNAVAILABLE");
      }
      if (!signatureIsValid) {
        throw new WalletChallengeError("WALLET_PROOF_INVALID");
      }

      if (
        !(await this.#repository.consume(
          database,
          stored.challengeId,
          verifiedAt,
        ))
      ) {
        throw new WalletChallengeError("WALLET_PROOF_INVALID");
      }

      return {
        proofType: "sui_personal_message",
        challengeId: stored.challengeId,
        action: stored.action,
        address: stored.address,
        origin: stored.origin,
        context: stored.context,
        verifiedAt: verifiedAt.toISOString(),
      };
    });
  }
}
