import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@blast/core/lib/web-security/mutation-guard.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import type { PrivyOnboardingProof } from "#web/lib/privy-adapter/public-types.ts";
import type {
  WalletChallengeService,
  WalletControlProof,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { CrewAccessError } from "@blast/server/modules/mission-control/crew-access/errors.ts";
import { createCrewAccessRouteHandlers } from "@blast/server/modules/mission-control/crew-access/route.ts";
import { DEFAULT_RATE_POLICIES } from "@blast/core/lib/web-security/rate-limits.ts";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import type { CrewAccessService } from "@blast/server/modules/mission-control/crew-access/service.ts";

const ORIGIN = "https://blast.fun";
const CSRF = "c".repeat(43);
const ADDRESS = `0x${"1".repeat(64)}`;
const PRIVY_DID = "did:privy:crew-member";
const REQUEST_ID = "request-safe";

function mutation(
  method: "POST" | "PUT",
  body: unknown,
  token?: string,
): Request {
  return new Request(`${ORIGIN}/api/mission-control/restore`, {
    method,
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      Cookie: `${CSRF_COOKIE_NAME}=${CSRF}`,
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      [CSRF_HEADER_NAME]: CSRF,
    },
    body: JSON.stringify(body),
  });
}

function proof(): PrivyOnboardingProof {
  return {
    identity: {
      authProvider: "privy",
      avatarReference: null,
      callsignSuggestion: null,
      displayNameSuggestion: null,
      handle: null,
      privyDid: PRIVY_DID,
      proofReference: "provider-session",
      socialProvider: "x",
      verifiedAtEpochSeconds: 1,
      xSubject: "x-subject",
    },
    wallet: {
      address: ADDRESS,
      chain: "sui",
      created: false,
      custodyProvider: "privy",
      privyDid: PRIVY_DID,
      providerWalletReference: "wallet-reference",
    },
  };
}

function dependencies(
  overrides: Partial<Parameters<typeof createCrewAccessRouteHandlers>[0]> = {},
) {
  const controlProof: WalletControlProof = {
    action: "restore_crew_access",
    address: ADDRESS,
    challengeId: "11111111-1111-4111-8111-111111111111",
    context: { kind: "recovery", id: "11111111-1111-4111-8111-111111111112" },
    origin: ORIGIN,
    proofType: "sui_personal_message",
    verifiedAt: "2026-09-20T00:00:00.000Z",
  };
  return {
    challenge: {
      async issue(request: Parameters<WalletChallengeService["issue"]>[0]) {
        return {
          ...request,
          challengeId: controlProof.challengeId,
          expiresAt: "2026-09-20T00:05:00.000Z",
          issuedAt: "2026-09-20T00:00:00.000Z",
          message: "BLAST.FUN wallet authorization\nNonce: safe",
        };
      },
      async verify() {
        return controlProof;
      },
    },
    createRequestId: () => REQUEST_ID,
    expectedOrigin: ORIGIN,
    limiter: {
      async consume() {
        return {
          allowed: true,
          bucket: "recovery",
          policyVersion: 1,
          retryAfterSeconds: 0,
        };
      },
    } satisfies RateLimitPort,
    rateSubject: (address: string) => ({ ip: "203.0.113.10", address }),
    resolveEmbedded: async () => proof(),
    service: {
      async restore({ privyDid, proof: walletProof, setCookie }) {
        assert.equal(privyDid, PRIVY_DID);
        assert.equal(walletProof.address, ADDRESS);
        setCookie(
          "__Host-blast_session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax",
        );
        return { profileId: "profile-id" };
      },
      async resume() {
        throw new Error("not used");
      },
    } satisfies Pick<CrewAccessService, "restore" | "resume">,
    ...overrides,
  };
}

test("recovery rate limit runs before provider or challenge state", async () => {
  let providerCalls = 0;
  let challengeCalls = 0;
  const handlers = createCrewAccessRouteHandlers(
    dependencies({
      limiter: {
        async consume() {
          return {
            allowed: false,
            bucket: "recovery",
            policyVersion: 1,
            retryAfterSeconds: 60,
          };
        },
      },
      resolveEmbedded: async () => {
        providerCalls += 1;
        return proof();
      },
      challenge: {
        async issue() {
          challengeCalls += 1;
          throw new Error("must not issue");
        },
        async verify() {
          challengeCalls += 1;
          throw new Error("must not verify");
        },
      },
    }),
  );
  const response = await handlers.issue(
    mutation(
      "PUT",
      {
        address: ADDRESS,
        recoveryId: "11111111-1111-4111-8111-111111111112",
        walletKind: "embedded",
      },
      "verified-x-token",
    ),
  );
  assert.equal(response.status, 429);
  assert.equal(providerCalls, 0);
  assert.equal(challengeCalls, 0);
});

test("review L3: rotating the address does not multiply recovery attempts from one client IP", async () => {
  let providerCalls = 0;
  const limiter = new MemoryRateLimiter();
  const handlers = createCrewAccessRouteHandlers(
    dependencies({
      limiter,
      rateSubject: (address) => ({ ip: "203.0.113.10", address }),
      resolveEmbedded: async () => {
        providerCalls += 1;
        return proof();
      },
    }),
  );
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const response = await handlers.issue(
      mutation(
        "PUT",
        {
          address: `0x${attempt.toString(16).padStart(64, "a")}`,
          recoveryId: "11111111-1111-4111-8111-111111111112",
          walletKind: "embedded",
        },
        "verified-x-token",
      ),
    );
    statuses.push(response.status);
  }
  const ipLimit = DEFAULT_RATE_POLICIES.recovery_ip.windows[0]!.limit;
  assert.equal(
    providerCalls,
    ipLimit,
    "each address had room under `recovery`; the IP's budget stopped them",
  );
  assert.deepEqual(statuses.slice(ipLimit), Array(25 - ipLimit).fill(429));
});

test("embedded X proof for another address stays generic and creates no challenge", async () => {
  let challengeCalls = 0;
  const handlers = createCrewAccessRouteHandlers(
    dependencies({
      challenge: {
        async issue() {
          challengeCalls += 1;
          throw new Error("must not issue");
        },
        async verify() {
          throw new Error("not used");
        },
      },
    }),
  );
  const response = await handlers.issue(
    mutation(
      "PUT",
      {
        address: `0x${"2".repeat(64)}`,
        recoveryId: "11111111-1111-4111-8111-111111111112",
        walletKind: "embedded",
      },
      "verified-x-token",
    ),
  );
  assert.equal(response.status, 401);
  assert.equal(challengeCalls, 0);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "CREW_ACCESS_DENIED",
  );
});

test("embedded restore requires verified X, matching wallet, signature, then session", async () => {
  let restores = 0;
  const base = dependencies();
  const handlers = createCrewAccessRouteHandlers({
    ...base,
    service: {
      ...base.service,
      async restore(input) {
        restores += 1;
        return base.service.restore(input);
      },
    } as Pick<CrewAccessService, "restore" | "resume">,
  });
  const recoveryId = "11111111-1111-4111-8111-111111111112";
  const issued = await handlers.issue(
    mutation(
      "PUT",
      {
        address: ADDRESS,
        recoveryId,
        walletKind: "embedded",
      },
      "verified-x-token",
    ),
  );
  assert.equal(issued.status, 201);
  assert.equal(restores, 0, "X unlock alone must never issue a session");
  const issuedBody = (await issued.json()) as {
    challenge: { challengeId: string; message: string };
  };
  const verified = await handlers.verify(
    mutation(
      "POST",
      {
        address: ADDRESS,
        challengeId: issuedBody.challenge.challengeId,
        message: issuedBody.challenge.message,
        recoveryId,
        signature: "valid-sui-personal-message-signature",
        walletKind: "embedded",
      },
      "verified-x-token",
    ),
  );
  assert.equal(verified.status, 201);
  assert.equal(restores, 1);
  assert.match(
    verified.headers.get("set-cookie") ?? "",
    /HttpOnly; Secure; SameSite=Lax/,
  );
  assert.doesNotMatch(
    JSON.stringify(await verified.json()),
    /verified-x-token|valid-sui/,
  );
});

test("Slush restore skips X while all authentication failures stay indistinguishable", async () => {
  let providerCalls = 0;
  const handlers = createCrewAccessRouteHandlers(
    dependencies({
      resolveEmbedded: async () => {
        providerCalls += 1;
        return proof();
      },
      service: {
        async restore() {
          throw new CrewAccessError("CREW_ACCESS_DENIED");
        },
        async resume() {
          throw new Error("not used");
        },
      } as Pick<CrewAccessService, "restore" | "resume">,
    }),
  );
  const response = await handlers.verify(
    mutation("POST", {
      address: ADDRESS,
      challengeId: "11111111-1111-4111-8111-111111111111",
      message: "BLAST.FUN wallet authorization\nNonce: safe",
      recoveryId: "11111111-1111-4111-8111-111111111112",
      signature: "valid-sui-personal-message-signature",
      walletKind: "slush",
    }),
  );
  assert.equal(providerCalls, 0);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    requestId: REQUEST_ID,
    restored: false,
    error: {
      code: "CREW_ACCESS_DENIED",
      message: "Crew access could not be restored.",
    },
  });
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a restoration dependency outage is retryable rather than a credential denial", async () => {
  const handlers = createCrewAccessRouteHandlers(
    dependencies({
      challenge: {
        async issue() {
          throw new Error("private database credentials");
        },
        async verify() {
          throw new Error("unused");
        },
      },
    }),
  );
  const response = await handlers.issue(
    mutation("PUT", {
      address: ADDRESS,
      recoveryId: "11111111-1111-4111-8111-111111111112",
      walletKind: "slush",
    }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(response.headers.get("x-request-id"), REQUEST_ID);
  const text = await response.text();
  assert.match(text, /CREW_ACCESS_UNAVAILABLE/);
  assert.doesNotMatch(text, /private database credentials/);
});

test("restore preserves its inclusive byte cap and JSON prefix before spending recovery quota", async () => {
  let consumed = 0;
  const handlers = createCrewAccessRouteHandlers(
    dependencies({
      limiter: {
        async consume() {
          consumed++;
          return {
            allowed: true,
            bucket: "recovery",
            policyVersion: 1,
            retryAfterSeconds: 0,
          };
        },
      },
    }),
  );
  const source = JSON.stringify({
    address: ADDRESS,
    recoveryId: "existing-recovery",
    walletKind: "slush",
  });
  const send = (
    bytes: number,
    contentType = "application/json; charset=utf-8",
  ) => {
    const initial = mutation("PUT", {});
    const headers = new Headers(initial.headers);
    headers.set("content-type", contentType);
    return handlers.issue(
      new Request(initial.url, {
        method: "PUT",
        headers,
        body: source + " ".repeat(bytes - source.length),
      }),
    );
  };
  assert.equal((await send(16_384)).status, 201);
  assert.equal(consumed, 2, "recovery_ip and recovery are each spent once");
  assert.equal((await send(16_385)).status, 401);
  assert.equal((await send(16_384, "text/plain")).status, 401);
  assert.equal(
    consumed,
    2,
    "refused transport bodies do not spend recovery quota",
  );
});
