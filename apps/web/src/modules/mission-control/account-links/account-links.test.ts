import assert from "node:assert/strict";
import test from "node:test";

import type { PrivyOnboardingProof } from "#web/lib/privy-adapter/public-types.ts";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@blast/core/lib/web-security/mutation-guard.ts";
import { MemberSessionError } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import type {
  WalletChallengeService,
  WalletControlProof,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import type { LinkedWalletDto } from "@blast/core/modules/mission-control/account-links/contracts.ts";
import { createAccountLinksRouteHandlers } from "@blast/server/modules/mission-control/account-links/route.ts";
import type { AccountLinksService } from "@blast/server/modules/mission-control/account-links/service.ts";

const ORIGIN = "https://blast.fun";
const CSRF = "c".repeat(43);
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const CHALLENGE_ID = "22222222-2222-4222-8222-222222222222";
const ADDRESS = `0x${"1".repeat(64)}`;
const OTHER_ADDRESS = `0x${"2".repeat(64)}`;

function mutation(body: unknown, token?: string, csrf = true): Request {
  return new Request(`${ORIGIN}/api/mission-control/owner/wallets`, {
    method: "POST",
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
      Cookie: csrf ? `${CSRF_COOKIE_NAME}=${CSRF}` : "",
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      [CSRF_HEADER_NAME]: csrf ? CSRF : "",
    },
    body: JSON.stringify(body),
  });
}

function embeddedProof(address = ADDRESS): PrivyOnboardingProof {
  return {
    identity: {
      authProvider: "privy",
      avatarReference: null,
      callsignSuggestion: null,
      displayNameSuggestion: null,
      handle: null,
      privyDid: "did:privy:member",
      proofReference: "provider-session",
      socialProvider: "x",
      verifiedAtEpochSeconds: 1,
      xSubject: "x-member",
    },
    wallet: {
      address,
      chain: "sui",
      created: false,
      custodyProvider: "privy",
      privyDid: "did:privy:member",
      providerWalletReference: "privy-wallet",
    },
  };
}

function dependencies(
  overrides: Partial<Parameters<typeof createAccountLinksRouteHandlers>[0]> = {},
) {
  const linked: readonly LinkedWalletDto[] = [{
    address: ADDRESS,
    id: "33333333-3333-4333-8333-333333333333",
    kind: "slush",
    primary: true,
    state: "verified",
  }];
  const proof: WalletControlProof = {
    action: "link_wallet",
    address: ADDRESS,
    challengeId: CHALLENGE_ID,
    context: { kind: "account", id: `${PROFILE_ID}:slush` },
    origin: ORIGIN,
    proofType: "sui_personal_message",
    verifiedAt: "2026-09-21T00:00:00.000Z",
  };
  return {
    authenticate: async () => ({ profileId: PROFILE_ID, scope: "member" as const }),
    challenge: {
      async issue(request: Parameters<WalletChallengeService["issue"]>[0]) {
        return {
          ...request,
          challengeId: CHALLENGE_ID,
          expiresAt: "2026-09-21T00:05:00.000Z",
          issuedAt: "2026-09-21T00:00:00.000Z",
          message: "BLAST.FUN wallet authorization\nNonce: safe",
        };
      },
      async verify() {
        return proof;
      },
    },
    createRequestId: () => "request-safe",
    expectedOrigin: ORIGIN,
    rateSubject: (address: string) => ({ ip: "203.0.113.10", address }),
    resolveEmbedded: async () => embeddedProof(),
    service: {
      async attachWallet() {
        return linked;
      },
      async listWallets() {
        return linked;
      },
      async setPrimary() {
        return linked;
      },
    } satisfies Pick<AccountLinksService, "attachWallet" | "listWallets" | "setPrimary">,
    ...overrides,
  };
}

test("wallet-link challenge is bound to the authenticated account and requested wallet kind", async () => {
  let observedContext = "";
  const base = dependencies();
  const handlers = createAccountLinksRouteHandlers({
    ...base,
    challenge: {
      ...base.challenge,
      async issue(request) {
        observedContext = `${request.context.kind}:${request.context.id}`;
        return base.challenge.issue(request, { ip: "test", address: ADDRESS });
      },
    },
  });
  const response = await handlers.issue(mutation({ address: ADDRESS, kind: "slush" }));
  assert.equal(response.status, 201);
  assert.equal(observedContext, `account:${PROFILE_ID}:slush`);
});

test("wallet-link mutations reject missing CSRF before reading the member session", async () => {
  let authenticationCalls = 0;
  const handlers = createAccountLinksRouteHandlers(dependencies({
    authenticate: async () => {
      authenticationCalls += 1;
      return { profileId: PROFILE_ID, scope: "member" };
    },
  }));
  const response = await handlers.issue(
    mutation({ address: ADDRESS, kind: "slush" }, undefined, false),
  );
  assert.equal(response.status, 403);
  assert.equal(authenticationCalls, 0);
  assert.equal(
    (await response.json() as { error: { code: string } }).error.code,
    "CSRF_INVALID",
  );
});

test("Slush linking uses the signed proof and never initializes Privy", async () => {
  let providerCalls = 0;
  let attachedProfile = "";
  let attachedIdentity: unknown = "unset";
  const base = dependencies();
  const handlers = createAccountLinksRouteHandlers({
    ...base,
    resolveEmbedded: async () => {
      providerCalls += 1;
      throw new Error("Privy must not be used for Slush.");
    },
    service: {
      ...base.service,
      async attachWallet(input) {
        attachedProfile = input.profileId;
        attachedIdentity = input.identity;
        return base.service.attachWallet(input);
      },
    },
  });
  const response = await handlers.link(mutation({
    address: ADDRESS,
    challengeId: CHALLENGE_ID,
    kind: "slush",
    message: "BLAST.FUN wallet authorization\nNonce: safe",
    signature: "valid-personal-message-signature",
  }));
  assert.equal(response.status, 201);
  assert.equal(providerCalls, 0);
  assert.equal(attachedProfile, PROFILE_ID);
  assert.equal(attachedIdentity, undefined);
});

test("embedded linking rejects a provider wallet that differs from the signed address", async () => {
  let attachmentCalls = 0;
  const base = dependencies();
  const handlers = createAccountLinksRouteHandlers({
    ...base,
    challenge: {
      ...base.challenge,
      async verify() {
        return {
          ...(await base.challenge.verify({} as never, {} as never)),
          context: { kind: "account", id: `${PROFILE_ID}:embedded` },
        };
      },
    },
    resolveEmbedded: async () => embeddedProof(OTHER_ADDRESS),
    service: {
      ...base.service,
      async attachWallet(input) {
        attachmentCalls += 1;
        return base.service.attachWallet(input);
      },
    },
  });
  const response = await handlers.link(mutation({
    address: ADDRESS,
    challengeId: CHALLENGE_ID,
    kind: "embedded",
    message: "BLAST.FUN wallet authorization\nNonce: safe",
    signature: "valid-personal-message-signature",
  }, "verified-privy-token"));
  assert.equal(response.status, 400);
  assert.equal(attachmentCalls, 0);
  assert.equal(
    (await response.json() as { error: { code: string } }).error.code,
    "ACCOUNT_LINK_INVALID",
  );
});

test("expired member sessions cannot list or mutate another account's wallets", async () => {
  const handlers = createAccountLinksRouteHandlers(dependencies({
    authenticate: async () => {
      throw new MemberSessionError("SESSION_INVALID");
    },
  }));
  const response = await handlers.list(new Request(
    `${ORIGIN}/api/mission-control/owner/wallets`,
  ));
  assert.equal(response.status, 401);
  assert.equal(
    (await response.json() as { error: { code: string } }).error.code,
    "SESSION_INVALID",
  );
});


test("wallet primary keeps the exact byte limit and authenticates only after CSRF", async () => {
  let authenticated = 0;
  let writes = 0;
  const base = dependencies();
  const handlers = createAccountLinksRouteHandlers(dependencies({
    authenticate: async () => { authenticated += 1; return { profileId: PROFILE_ID, scope: "member" }; },
    service: { ...base.service, async setPrimary(profileId, walletId) { writes += 1; assert.equal(profileId, PROFILE_ID); assert.equal(walletId, "wallet"); return base.service.setPrimary(profileId, walletId); } },
  }));
  assert.equal((await handlers.primary(mutation({ walletId: "wallet" }, undefined, false))).status, 403);
  assert.equal(authenticated, 0);
  const canonical = JSON.stringify({ walletId: "wallet" });
  for (const bytes of [16383, 16384]) {
    const source = canonical + " ".repeat(bytes - Buffer.byteLength(canonical));
    const request = mutation({});
    const response = await handlers.primary(new Request(request.url, { method: "PATCH", headers: request.headers, body: source }));
    assert.equal(response.status, bytes === 16383 ? 200 : 400);
  }
  const media = mutation({ walletId: "wallet" });
  media.headers.set("content-type", "application/json; charset=utf-8");
  assert.equal((await handlers.primary(media)).status, 400);
  assert.equal(writes, 1);
});
