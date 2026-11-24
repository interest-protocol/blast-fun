import { assertTrustedMutationRequest } from "@blast/core/lib/web-security/mutation-guard.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import { WebSecurityError } from "@blast/core/lib/web-security/errors.ts";
import { WalletChallengeError } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { randomUUID } from "node:crypto";

import type { PrivyOnboardingProof } from "@blast/core/lib/privy-adapter/types.ts";
import type {
  RateLimitPort,
  WalletRateSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { MemberSessionError } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import type {
  IssuedWalletChallenge,
  WalletChallengeService,
  WalletControlProof,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import {
  parseCrewRestoreChallengeRequest,
  parseCrewRestoreVerifyRequest,
  type CrewRestoreChallengeRequest,
} from "./contracts.ts";
import { CrewAccessError } from "./errors.ts";
import type { CrewAccessService } from "./service.ts";

const MAX_REQUEST_BYTES = 16 * 1_024;

type WalletChallengePort = Pick<WalletChallengeService, "issue" | "verify">;

export interface CrewAccessRouteDependencies {
  challenge: WalletChallengePort;
  createRequestId?: () => string;
  expectedOrigin: string;
  limiter: RateLimitPort;
  rateSubject(address: string): WalletRateSubject;
  resolveEmbedded(accessToken: string): Promise<PrivyOnboardingProof>;
  service: Pick<CrewAccessService, "restore" | "resume">;
}

function response(
  requestId: string,
  body: Record<string, unknown>,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Request-ID", requestId);
  return publicJson({ requestId, ...body }, { ...init, headers });
}

function denied(requestId: string, status = 401): Response {
  return response(
    requestId,
    {
      restored: false,
      error: {
        code: "CREW_ACCESS_DENIED",
        message: "Crew access could not be restored.",
      },
    },
    { status },
  );
}

async function body(request: Request): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new CrewAccessError("CREW_ACCESS_DENIED");
  }
  const source = await request.text();
  if (new TextEncoder().encode(source).byteLength > MAX_REQUEST_BYTES) {
    throw new CrewAccessError("CREW_ACCESS_DENIED");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new CrewAccessError("CREW_ACCESS_DENIED");
  }
}

function bearer(request: Request): string {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer ([^\s]{1,8192})$/)?.[1];
  if (!token) throw new CrewAccessError("CREW_ACCESS_DENIED");
  return token;
}

async function embeddedIdentity(
  dependencies: CrewAccessRouteDependencies,
  request: Request,
  restore: CrewRestoreChallengeRequest,
): Promise<string | null> {
  if (restore.walletKind === "slush") return null;
  const proof = await dependencies.resolveEmbedded(bearer(request));
  if (proof.wallet.address !== restore.address) {
    throw new CrewAccessError("CREW_ACCESS_DENIED");
  }
  return proof.identity.privyDid;
}

async function takeRecoveryRateLimit(
  dependencies: CrewAccessRouteDependencies,
  address: string,
): Promise<boolean> {
  const subject = dependencies.rateSubject(address);
  // Review L3: the client IP alone first, so rotating addresses cannot multiply `recovery`.
  const perIp = await dependencies.limiter.consume("recovery_ip", {
    ip: subject.ip,
  });
  if (!perIp.allowed) return false;
  const decision = await dependencies.limiter.consume("recovery", subject);
  return decision.allowed;
}

function challengeDto(challenge: IssuedWalletChallenge) {
  return {
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    message: challenge.message,
  };
}

function unavailable(requestId: string): Response {
  return response(
    requestId,
    {
      restored: false,
      error: {
        code: "CREW_ACCESS_UNAVAILABLE",
        message: "Crew access is temporarily unavailable.",
      },
    },
    { status: 503 },
  );
}

function recoveryFailure(requestId: string, error: unknown): Response {
  if (error instanceof CrewAccessError)
    return error.status >= 500 ? unavailable(requestId) : denied(requestId);
  if (error instanceof WebSecurityError)
    return error.status >= 500 ? unavailable(requestId) : denied(requestId);
  if (error instanceof WalletChallengeError)
    return error.status >= 500 ? unavailable(requestId) : denied(requestId);
  if (
    error instanceof PrivyAdapterError &&
    [
      "ACCESS_TOKEN_EXPIRED",
      "INVALID_ACCESS_TOKEN",
      "IDENTITY_NOT_FOUND",
    ].includes(error.code)
  )
    return denied(requestId);
  return unavailable(requestId);
}

function parseRecovery<T>(parse: (body: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new CrewAccessError("CREW_ACCESS_DENIED");
  }
}

export function createCrewAccessRouteHandlers(
  dependencies: CrewAccessRouteDependencies,
): {
  issue(request: Request): Promise<Response>;
  resume(request: Request): Promise<Response>;
  verify(request: Request): Promise<Response>;
} {
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  return {
    async issue(request) {
      const requestId = createRequestId();
      try {
        assertTrustedMutationRequest(request, dependencies.expectedOrigin);
        const restore = parseRecovery(
          parseCrewRestoreChallengeRequest,
          await body(request),
        );
        if (
          !(await takeRecoveryRateLimit(dependencies, restore.address))
        ) {
          return denied(requestId, 429);
        }
        await embeddedIdentity(dependencies, request, restore);
        const challenge = await dependencies.challenge.issue(
          {
            action: "restore_crew_access",
            address: restore.address,
            context: { kind: "recovery", id: restore.recoveryId },
            origin: dependencies.expectedOrigin,
          },
          dependencies.rateSubject(restore.address),
        );
        return response(
          requestId,
          { challenge: challengeDto(challenge) },
          { status: 201 },
        );
      } catch (error) {
        return recoveryFailure(requestId, error);
      }
    },
    async resume(request) {
      const requestId = createRequestId();
      try {
        await dependencies.service.resume(request);
        return response(requestId, { authenticated: true });
      } catch (error) {
        if (
          error instanceof MemberSessionError &&
          error.code === "SESSION_INVALID"
        ) {
          return response(
            requestId,
            {
              authenticated: false,
              error: {
                code: "SESSION_INVALID",
                message: "The member session is invalid or expired.",
              },
            },
            { status: 401 },
          );
        }
        return unavailable(requestId);
      }
    },
    async verify(request) {
      const requestId = createRequestId();
      try {
        assertTrustedMutationRequest(request, dependencies.expectedOrigin);
        const restore = parseRecovery(
          parseCrewRestoreVerifyRequest,
          await body(request),
        );
        if (
          !(await takeRecoveryRateLimit(dependencies, restore.address))
        ) {
          return denied(requestId, 429);
        }
        const privyDid = await embeddedIdentity(dependencies, request, restore);
        const proof: WalletControlProof = await dependencies.challenge.verify(
          {
            action: "restore_crew_access",
            address: restore.address,
            challengeId: restore.challengeId,
            context: { kind: "recovery", id: restore.recoveryId },
            message: restore.message,
            origin: dependencies.expectedOrigin,
            signature: restore.signature,
          },
          dependencies.rateSubject(restore.address),
        );
        let sessionCookie = "";
        await dependencies.service.restore({
          expectedOrigin: dependencies.expectedOrigin,
          privyDid,
          proof,
          request,
          setCookie: (cookie) => {
            sessionCookie = cookie;
          },
        });
        if (!sessionCookie)
          throw new CrewAccessError("CREW_ACCESS_UNAVAILABLE");
        return response(
          requestId,
          { restored: true },
          { status: 201, headers: { "Set-Cookie": sessionCookie } },
        );
      } catch (error) {
        return recoveryFailure(requestId, error);
      }
    },
  };
}
