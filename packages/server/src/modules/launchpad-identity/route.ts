import { launchpadCsrfResponse } from "@blast/server/modules/launchpad-identity/csrf.ts";
export { launchpadCsrfResponse } from "@blast/server/modules/launchpad-identity/csrf.ts";
import { randomUUID } from "node:crypto";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import {
  assertTrustedMutationRequest,
} from "@blast/core/lib/web-security/mutation-guard.ts";
import {
  canonicalSuiAddress,
  hasExactKeys,
  parseLaunchpadProofAction,
} from "@blast/server/modules/launchpad-identity/contracts.ts";
import {
  LaunchpadMutationError,
  launchpadErrorResponse,
  launchpadJson,
  publicLaunchpadError,
} from "@blast/server/modules/launchpad-identity/errors.ts";
import { assertJsonContentType, readBoundedJson } from "@blast/server/modules/launchpad-identity/http.ts";
import type { LaunchpadIdentityService } from "@blast/server/modules/launchpad-identity/service.ts";

/** `{ action, address }` is about 110 bytes. */
const CHALLENGE_BODY_LIMIT = 1_024;

export interface LaunchpadWalletProofRouteDependencies {
  expectedOrigin: string;
  identity: Pick<LaunchpadIdentityService, "issueChallenge">;
  createRequestId?: () => string;
}

/**
 * `POST /api/launchpad/wallet-proofs` issues a challenge for one named
 * action to the requester, who signs its message with the wallet and sends
 * it with the protected write. Origin, CSRF, content type, size and exact
 * fields are checked before the `wallet` rate bucket or any row is touched.
 */
export function createLaunchpadWalletProofRoutes(
  dependencies: LaunchpadWalletProofRouteDependencies,
): Readonly<{
  issue(request: Request, client: ClientAddress): Promise<Response>;
  csrf(request: Request): Promise<Response>;
}> {
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  return {
    async issue(request, client) {
      const requestId = createRequestId();
      try {
        if (request.method !== "POST") {
          throw new LaunchpadMutationError("LAUNCHPAD_METHOD_NOT_ALLOWED");
        }
        assertTrustedMutationRequest(request, dependencies.expectedOrigin);
        assertJsonContentType(request);
        const body = await readBoundedJson(request, CHALLENGE_BODY_LIMIT);
        if (!hasExactKeys(body, ["action", "address"])) {
          throw new LaunchpadMutationError("LAUNCHPAD_REQUEST_INVALID");
        }
        let action, address;
        try {
          action = parseLaunchpadProofAction(body.action);
          address = canonicalSuiAddress(body.address);
        } catch {
          throw new LaunchpadMutationError("LAUNCHPAD_REQUEST_INVALID");
        }
        const challenge = await dependencies.identity.issueChallenge(
          { action, address, origin: dependencies.expectedOrigin },
          { ip: client.rateKey },
        );
        recordMetric("launchpad.wallet_proof.issue", { requestId, action, outcome: "ok" });
        return launchpadJson(
          requestId,
          {
            challenge: {
              action: challenge.action,
              address: challenge.address,
              challengeId: challenge.challengeId,
              expiresAt: challenge.expiresAt,
              message: challenge.message,
            },
          },
          201,
        );
      } catch (error) {
        const safe = publicLaunchpadError(error);
        recordMetric("launchpad.wallet_proof.issue", { requestId,
          code: safe.code,
          outcome: safe.status >= 500 ? "error" : "refused",
          status: safe.status,
        });
        return launchpadErrorResponse(requestId, safe);
      }
    },
    csrf: launchpadCsrfResponse,
  };
}
