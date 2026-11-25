import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { assertTrustedMutationRequest } from "@blast/core/lib/web-security/mutation-guard.ts";
import type {
  RateBucket,
  RateLimitPort,
  RateLimitSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import {
  withTransaction,
  type ReadableDatabase,
  type TransactionContext,
} from "@blast/core/modules/database/transaction.ts";
import {
  hasExactKeys,
  isRecord,
  parseWalletProof,
  type LaunchpadActor,
  type LaunchpadProofAction,
  type LaunchpadWalletProof,
} from "@blast/server/modules/launchpad-identity/contracts.ts";
import { assertJsonContentType, readBoundedJson } from "@blast/server/modules/launchpad-identity/http.ts";
import {
  LaunchpadMutationError,
  invalidRequest,
  launchpadErrorResponse,
  launchpadJson,
  publicLaunchpadError,
} from "@blast/server/modules/launchpad-identity/errors.ts";

/** A Wallet Proof whose binding and signature were checked; not yet consumed. */
export type CheckedWalletProof = Readonly<{
  action: LaunchpadProofAction;
  address: string;
  challengeId: string;
  messageHash: string;
  origin: string;
}>;

/** How a protected write learns who is making it (implemented by `LaunchpadIdentityService`). */
export interface LaunchpadIdentity {
  /** A verified Privy session of any login method. */
  authenticatePrivy(accessToken: string): Promise<LaunchpadActor>;
  /** Checks a Wallet Proof's binding and signature without consuming it. */
  checkWalletProof(
    proof: LaunchpadWalletProof,
    binding: Readonly<{ action: LaunchpadProofAction; origin: string }>,
    context: Readonly<{ ip: string }>,
  ): Promise<CheckedWalletProof>;
  /** Consumes a checked proof inside the write's transaction, exactly once. */
  consumeWalletProof(
    transaction: TransactionContext,
    proof: CheckedWalletProof,
  ): Promise<LaunchpadActor>;
}

export interface LaunchpadMutationDefinition<Input, Result> {
  /** The action a Wallet Proof must name to authorize this write. */
  action: LaunchpadProofAction;
  /** The exact keys of the request's `input` object. */
  fields: readonly string[];
  /** Largest accepted body in bytes (default 16 KiB, at most 64 KiB). */
  maxBodyBytes?: number;
  /** Bounds, normalizes, and types `input`; any throw is a 400. */
  parse(input: Record<string, unknown>): Input;
  /** The configured registry bucket this write counts against, and whom. */
  rateLimit: Readonly<{
    bucket: RateBucket;
    subject(context: Readonly<{ ip: string; input: Input }>): RateLimitSubject;
  }>;
  /**
   * Optional slow work kept out of the database transaction (decoding, external
   * storage). It runs after the credential is verified and before a Wallet
   * Proof is consumed, so any throw ends the request with no proof spent (the
   * rate budgets are already spent). It runs before `authorize`, once for every
   * concurrent use of a proof, and is never rolled back: it must be idempotent
   * and safe to leave behind. `actor` is who is writing: the verified Privy
   * actor, or the checked Wallet Proof's wallet (not yet consumed), so a step
   * may refuse a request that is not the writer's before any slow work.
   */
  prepare?(input: Input, context: Readonly<{ actor: LaunchpadActor }>): Promise<Input>;
  /** Runs inside the write's transaction; false is a 403 and nothing commits. */
  authorize?(context: Readonly<{
    actor: LaunchpadActor;
    input: Input;
    database: ReadableDatabase;
  }>): Promise<boolean>;
  /** The owning module's repository writes, in one transaction with the proof's consumption. */
  write(context: Readonly<{
    actor: LaunchpadActor;
    input: Input;
    transaction: TransactionContext;
    /** The request's `Idempotency-Key` header, or null when none was sent. */
    idempotencyKey: string | null;
  }>): Promise<Result>;
  /** The public response body; it must not echo credentials. */
  present(result: Result): Record<string, unknown>;
  successStatus?: 200 | 201;
}

export interface LaunchpadMutationDependencies {
  expectedOrigin: string;
  identity: LaunchpadIdentity;
  limiter: RateLimitPort;
  pool: Pool;
  createRequestId?: () => string;
}

const DEFAULT_BODY_BYTES = 16 * 1_024;
const MAX_BODY_BYTES = 64 * 1_024;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$/;
/** A client-chosen retry key: 16 to 64 URL-safe characters (a UUID fits). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;

type Credential =
  | { kind: "privy"; accessToken: string }
  | { kind: "wallet_proof"; proof: LaunchpadWalletProof };

function credentialFrom(request: Request, envelope: Record<string, unknown>): Credential {
  const authorization = request.headers.get("authorization");
  const hasProof = Object.hasOwn(envelope, "proof");
  if (authorization !== null && hasProof) throw invalidRequest();
  if (hasProof) {
    try {
      return { kind: "wallet_proof", proof: parseWalletProof(envelope.proof) };
    } catch {
      throw invalidRequest();
    }
  }
  if (authorization === null) throw new LaunchpadMutationError("LAUNCHPAD_AUTH_REQUIRED");
  const accessToken = authorization.match(BEARER)?.[1];
  if (!accessToken) throw new LaunchpadMutationError("LAUNCHPAD_AUTH_INVALID");
  return { kind: "privy", accessToken };
}

async function readMutationInput<Input, Result>(
  request: Request,
  definition: LaunchpadMutationDefinition<Input, Result>,
  expectedOrigin: string,
  limit: number,
): Promise<{ envelope: Record<string, unknown>; input: Input; idempotencyKey: string | null }> {
  if (request.method !== "POST") {
    throw new LaunchpadMutationError("LAUNCHPAD_METHOD_NOT_ALLOWED");
  }
  assertTrustedMutationRequest(request, expectedOrigin);
  assertJsonContentType(request);
  const envelope = await readBoundedJson(request, limit);
  if (
    !hasExactKeys(envelope, ["input"]) &&
    !hasExactKeys(envelope, ["input", "proof"])
  ) {
    throw invalidRequest();
  }
  if (!isRecord(envelope.input) || !hasExactKeys(envelope.input, definition.fields)) {
    throw invalidRequest();
  }
  let input: Input;
  try {
    input = definition.parse(envelope.input);
  } catch {
    throw invalidRequest();
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY.test(idempotencyKey)) throw invalidRequest();
  return { envelope, input, idempotencyKey };
}

/**
 * A launchpad write that accepts a verified Privy session or one unconsumed
 * Wallet Proof for its action. In order, and before any repository runs:
 *
 * 1. Method (405), origin and CSRF (403), content type (415), body size (413).
 * 2. Exact JSON: `{ input }` with a Privy `Authorization: Bearer` header, or
 *    `{ input, proof }` with no header (400; neither is 401). `input` has
 *    exactly the definition's fields and passes its parser.
 * 3. The definition's configured rate bucket (429, 503 when unavailable).
 * 4. The credential: Privy verified with the provider, or the proof's
 *    binding and signature checked (401, 503 when the provider fails); then
 *    the definition's optional `prepare`, outside any transaction.
 * 5. One transaction: the proof is consumed, the actor authorized (403) and
 *    the owning module writes. Any refusal or failure rolls all of it back, so
 *    a proof is spent only by the write it authorized.
 */
export function createLaunchpadMutationHandler<Input, Result>(
  definition: LaunchpadMutationDefinition<Input, Result>,
  dependencies: LaunchpadMutationDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  const limit = definition.maxBodyBytes ?? DEFAULT_BODY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BODY_BYTES) {
    throw new TypeError("A launchpad mutation body limit must be 1 byte to 64 KiB.");
  }

  return async (request, client) => {
    const requestId = createRequestId();
    let credential: Credential["kind"] | undefined;
    try {
      const { envelope, input, idempotencyKey } = await readMutationInput(request, definition, dependencies.expectedOrigin, limit);
      const presented = credentialFrom(request, envelope);
      credential = presented.kind;

      const ip = client.rateKey;
      let decision;
      try {
        decision = await dependencies.limiter.consume(
          definition.rateLimit.bucket,
          definition.rateLimit.subject({ ip, input }),
        );
      } catch {
        throw new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE");
      }
      if (!decision.allowed) {
        throw new LaunchpadMutationError("LAUNCHPAD_RATE_LIMITED", decision.retryAfterSeconds);
      }

      const privyActor = presented.kind === "privy"
        ? await dependencies.identity.authenticatePrivy(presented.accessToken)
        : null;
      const checkedProof = presented.kind === "wallet_proof"
        ? await dependencies.identity.checkWalletProof(
          presented.proof,
          { action: definition.action, origin: dependencies.expectedOrigin },
          { ip },
        )
        : null;
      const writer: LaunchpadActor | null = privyActor ??
        (checkedProof ? { method: "wallet_proof", walletAddress: checkedProof.address } : null);
      if (!writer) throw new LaunchpadMutationError("LAUNCHPAD_AUTH_REQUIRED");
      const prepared = definition.prepare ? await definition.prepare(input, { actor: writer }) : input;

      const result = await withTransaction(dependencies.pool, async (transaction) => {
        const actor = checkedProof
          ? await dependencies.identity.consumeWalletProof(transaction, checkedProof)
          : privyActor;
        if (!actor) throw new LaunchpadMutationError("LAUNCHPAD_AUTH_REQUIRED");
        if (
          definition.authorize &&
          !(await definition.authorize({ actor, input: prepared, database: transaction }))
        ) {
          throw new LaunchpadMutationError("LAUNCHPAD_FORBIDDEN");
        }
        return definition.write({ actor, input: prepared, transaction, idempotencyKey });
      }, { label: `launchpad.${definition.action}` });

      const status = definition.successStatus ?? 201;
      recordMetric("launchpad.mutation", {
        requestId,
        action: definition.action,
        credential,
        outcome: "ok",
        status,
      });
      return launchpadJson(requestId, definition.present(result), status);
    } catch (error) {
      const safe = publicLaunchpadError(error);
      recordMetric("launchpad.mutation", {
        requestId,
        action: definition.action,
        code: safe.status >= 500 && safe.code === "LAUNCHPAD_INTERNAL_ERROR" ? errorLabel(error) : safe.code,
        credential,
        outcome: safe.status >= 500 ? "error" : "refused",
        status: safe.status,
      });
      return launchpadErrorResponse(requestId, safe);
    }
  };
}
