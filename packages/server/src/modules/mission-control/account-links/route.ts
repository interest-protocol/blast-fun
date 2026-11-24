import { WebSecurityError } from "@blast/core/lib/web-security/errors.ts";
import { z } from "zod";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { randomUUID } from "node:crypto";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import type { PrivyOnboardingProof } from "@blast/core/lib/privy-adapter/types.ts";
import type { WalletRateSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  assertTrustedMutationRequest,
} from "@blast/core/lib/web-security/mutation-guard.ts";
import type { MemberAuthorization } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import { MemberSessionError } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import type {
  WalletChallengeService,
  WalletControlProof,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { canonicalSuiAddress } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { WalletChallengeError } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import {
  ACCOUNT_WALLET_KINDS,
  type AccountWalletKind,
} from "@blast/core/modules/mission-control/account-links/contracts.ts";
import { AccountLinksError } from "./errors.ts";
import type { AccountLinksService } from "./service.ts";

const MAX_REQUEST_BYTES = 16 * 1_024;

export interface AccountLinksRouteDependencies {
  authenticate(request: Request): Promise<MemberAuthorization>;
  challenge: Pick<WalletChallengeService, "issue" | "verify">;
  createRequestId?: () => string;
  expectedOrigin: string;
  rateSubject(address: string): WalletRateSubject;
  resolveEmbedded(accessToken: string): Promise<PrivyOnboardingProof>;
  service: Pick<AccountLinksService, "attachWallet" | "listWallets" | "setPrimary">;
}

function json(
  requestId: string,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return publicJson(
    { requestId, ...body },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-ID": requestId,
      },
    },
  );
}

function failure(requestId: string, error: unknown): Response {
  const response = failureResponse(requestId, error);
  if (response.status >= 500) {
    recordMetric("account_links.request", { requestId, error: errorLabel(error), outcome: "error" });
  }
  return response;
}

function failureResponse(requestId: string, error: unknown): Response {
  if (error instanceof AccountLinksError) {
    const status = error.code === "ACCOUNT_LINK_INVALID"
      ? 400
      : error.code === "ACCOUNT_LINK_UNAVAILABLE"
        ? 503
        : error.code === "WALLET_NOT_FOUND"
          ? 404
          : 409;
    return json(requestId, { error: { code: error.code, message: error.message } }, status);
  }
  if (
    error instanceof WebSecurityError ||
    error instanceof MemberSessionError ||
    error instanceof WalletChallengeError
  ) {
    return json(
      requestId,
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  return json(
    requestId,
    {
      error: {
        code: "ACCOUNT_LINK_UNAVAILABLE",
        message: "Account linking is temporarily unavailable.",
      },
    },
    503,
  );
}

const stringSchema = z.string();

function isString(value: unknown): value is string {
  return stringSchema.safeParse(value).success;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return z.strictObject(Object.fromEntries(keys.map((key) => [key, z.unknown().nonoptional()]))).safeParse(value).success;
}

async function parseJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.toLowerCase() !== "application/json") {
    throw new AccountLinksError("ACCOUNT_LINK_INVALID");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength >= MAX_REQUEST_BYTES) {
    throw new AccountLinksError("ACCOUNT_LINK_INVALID");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AccountLinksError("ACCOUNT_LINK_INVALID");
  }
}

function walletKind(value: unknown): AccountWalletKind {
  if ((ACCOUNT_WALLET_KINDS as readonly unknown[]).includes(value)) {
    return value as AccountWalletKind;
  }
  throw new AccountLinksError("ACCOUNT_LINK_INVALID");
}

function address(value: unknown): string {
  try {
    return canonicalSuiAddress(value);
  } catch {
    throw new AccountLinksError("ACCOUNT_LINK_INVALID");
  }
}

function bearer(request: Request): string {
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]{1,8192})$/)?.[1];
  if (!token) throw new AccountLinksError("ACCOUNT_LINK_INVALID");
  return token;
}

function accountContext(profileId: string, kind: AccountWalletKind) {
  return { kind: "account" as const, id: `${profileId}:${kind}` };
}

export function createAccountLinksRouteHandlers(
  dependencies: AccountLinksRouteDependencies,
): Readonly<{
  issue(request: Request): Promise<Response>;
  link(request: Request): Promise<Response>;
  list(request: Request): Promise<Response>;
  primary(request: Request): Promise<Response>;
}> {
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  return {
    async issue(request) {
      const requestId = createRequestId();
      try {
        assertTrustedMutationRequest(request, dependencies.expectedOrigin);
        const member = await dependencies.authenticate(request);
        const body = await parseJson(request);
        if (!exactObject(body, ["address", "kind"])) {
          throw new AccountLinksError("ACCOUNT_LINK_INVALID");
        }
        const walletAddress = address(body.address);
        const kind = walletKind(body.kind);
        const challenge = await dependencies.challenge.issue(
          {
            action: "link_wallet",
            address: walletAddress,
            context: accountContext(member.profileId, kind),
            origin: dependencies.expectedOrigin,
          },
          dependencies.rateSubject(walletAddress),
        );
        return json(
          requestId,
          {
            challenge: {
              challengeId: challenge.challengeId,
              expiresAt: challenge.expiresAt,
              kind,
              message: challenge.message,
            },
          },
          201,
        );
      } catch (error) {
        return failure(requestId, error);
      }
    },
    async link(request) {
      const requestId = createRequestId();
      try {
        assertTrustedMutationRequest(request, dependencies.expectedOrigin);
        const member = await dependencies.authenticate(request);
        const body = await parseJson(request);
        if (
          !exactObject(body, ["address", "challengeId", "kind", "message", "signature"]) ||
          !isString(body.challengeId) ||
          !isString(body.message) ||
          !isString(body.signature)
        ) {
          throw new AccountLinksError("ACCOUNT_LINK_INVALID");
        }
        const walletAddress = address(body.address);
        const kind = walletKind(body.kind);
        const proof: WalletControlProof = await dependencies.challenge.verify(
          {
            action: "link_wallet",
            address: walletAddress,
            challengeId: body.challengeId,
            context: accountContext(member.profileId, kind),
            message: body.message,
            origin: dependencies.expectedOrigin,
            signature: body.signature,
          },
          dependencies.rateSubject(walletAddress),
        );
        const embedded = kind === "embedded"
          ? await dependencies.resolveEmbedded(bearer(request))
          : null;
        if (embedded && embedded.wallet.address !== proof.address) {
          throw new AccountLinksError("ACCOUNT_LINK_INVALID");
        }
        const wallets = await dependencies.service.attachWallet({
          address: proof.address,
          identity: embedded
            ? { provider: "privy", subject: embedded.identity.privyDid }
            : undefined,
          kind,
          profileId: member.profileId,
          providerWalletReference:
            embedded?.wallet.providerWalletReference ?? `slush:${proof.challengeId}`,
        });
        return json(requestId, { wallets }, 201);
      } catch (error) {
        return failure(requestId, error);
      }
    },
    async list(request) {
      const requestId = createRequestId();
      try {
        const member = await dependencies.authenticate(request);
        const wallets = await dependencies.service.listWallets(member.profileId);
        return json(requestId, { wallets });
      } catch (error) {
        return failure(requestId, error);
      }
    },
    async primary(request) {
      const requestId = createRequestId();
      try {
        assertTrustedMutationRequest(request, dependencies.expectedOrigin);
        const member = await dependencies.authenticate(request);
        const body = await parseJson(request);
        if (!exactObject(body, ["walletId"]) || !isString(body.walletId)) {
          throw new AccountLinksError("ACCOUNT_LINK_INVALID");
        }
        const wallets = await dependencies.service.setPrimary(
          member.profileId,
          body.walletId,
        );
        return json(requestId, { wallets });
      } catch (error) {
        return failure(requestId, error);
      }
    },
  };
}
