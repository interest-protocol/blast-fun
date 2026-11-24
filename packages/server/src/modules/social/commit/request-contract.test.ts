import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStructTag } from "@mysten/sui/utils";

import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { socialErrorResponse, type SocialCaller, type SocialRequestContext, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { claimTestIdentity } from "../../../../test/fixtures/modules/social/claims/claim-fixtures.ts";
import { holdCoins, stubCoin, stubCommitCore } from "../../../../../core/test/fixtures/modules/social/commit/commit-fixtures.ts";
import { createCommitChain } from "@blast/server/modules/social/commit/chain.ts";
import { createSocialCommitRoutes } from "@blast/server/modules/social/commit/route.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

const ORIGIN = "https://blast.test";
const PRESALE = `0x${"a".repeat(64)}`;
const SENDER = `0x${"b".repeat(64)}`;
const SALE_TOKEN = `0x${"c".repeat(64)}::sale::SALE`;
const USDC = `0x${"d".repeat(64)}::usdc::USDC`;
const TSUI = `0x${"e".repeat(64)}::test_sui::TEST_SUI`;

// The real route handler with a preauthenticated context. Authentication and
// account loading remain the shared kit's responsibility and have separate tests.
const PRIVY_CALLER: SocialCaller = { kind: "privy", did: "did:privy:test", subject: "did:privy:test" };
const authenticatedKit = (caller: SocialCaller): SocialRouteKit => ({
  route(spec, handle) {
    assert.equal(spec.auth, "account");
    assert.equal(spec.account, "required");
    assert.equal(spec.bucket, "social_commit");
    assert.equal(spec.cache, "private");
    return async (request, client) => {
      const context: SocialRequestContext = {
        request, requestId: "request-contract", client, account: null, trading: false, hiddenKinds: ["trade_buy", "trade_sell"],
        caller,
        json: (body, status = 200) => Response.json(body, { status }),
        consume: async () => {},
        consumeAccount: async () => {},
        transaction: async () => { throw new Error("commit builds must not open a database transaction"); },
      };
      try {
        return await handle(context);
      } catch (error) {
        if (error instanceof SocialRouteError) return socialErrorResponse(context.requestId, error, "private, no-store");
        throw error;
      }
    };
  },
});

function fixture(quote = USDC, held = 100n, caller = PRIVY_CALLER) {
  const identity = claimTestIdentity();
  const core = stubCommitCore(identity);
  core.presales.set(PRESALE, { saleToken: SALE_TOKEN, quote, initialSharedVersion: "3" });
  holdCoins(core, SENDER, quote, [stubCoin(1, held)]);
  const route = createSocialCommitRoutes({
    kit: authenticatedKit(caller),
    deployment: async () => identity,
    chain: () => createCommitChain({ identity, client: core.client }),
    blastWallet: async () => SENDER,
  });
  const build = (payWith: string, extra: Record<string, unknown> = {}) => route.build(new Request(`${ORIGIN}/api/social/me/commits`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ presale_id: PRESALE, pay_with: payWith, amount: "50", ...extra }),
  }), testClient());
  return { core, build };
}

test("commit requests reject retired payment selectors before any chain reads", async () => {
  const { core, build } = fixture();
  for (const payWith of ["USDC", "SUI"]) {
    const response = await build(payWith);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");
  }
  assert.deepEqual(core.calls, { getObjects: 0, getBalance: 0, listCoins: 0 });
});

test("QUOTE builds commitments from each sale's exact chain quote without changing asset support", async () => {
  for (const quote of [USDC, SUI_COIN_TYPE, TSUI]) {
    const { build } = fixture(quote);
    const response = await build("QUOTE");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.quote_type, normalizeStructTag(quote));
    assert.equal(body.amount, "50");
    assert.equal(body.fee, "sponsored");
    assert.ok(body.transaction_kind_bytes.length > 0);
  }
});

test("a wallet session's commit is sponsored like an embedded wallet's", async () => {
  const { build } = fixture(SUI_COIN_TYPE, 100n, { kind: "wallet", address: SENDER, subject: `sui:${SENDER}` });
  const response = await build("QUOTE");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fee, "sponsored");
});

test("canonical commit requests retain exact-quote balance and closed-body checks", async () => {
  const { build } = fixture(TSUI, 49n);
  const short = await build("QUOTE");
  assert.equal(short.status, 409);
  assert.equal((await short.json()).error.code, "insufficient_balance");
  const injected = await build("QUOTE", { quote_type: USDC });
  assert.equal(injected.status, 400);
  assert.equal((await injected.json()).error.code, "invalid_request");
});


test("published commit request schema accepts QUOTE and rejects retired selectors", () => {
  const validator = createSocialValidator();
  const body = { presale_id: PRESALE, pay_with: "QUOTE", amount: "50" };
  assert.deepEqual(validator.validate("commit-build-request", body).errors, []);
  for (const payWith of ["USDC", "SUI"]) {
    assert.notDeepEqual(validator.validate("commit-build-request", { ...body, pay_with: payWith }).errors, []);
  }
});
