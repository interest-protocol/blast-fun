import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { FAKE_SPONSOR, sponsoredSigner, transactionBytesFor, walletSigner } from "../../../../test/fixtures/social/claim/claim-doubles.ts";
import { sponsoredWalletSigner } from "#web/lib/sui-signing.ts";
import { runCommit } from "#web/components/social/commit/commit-flow.ts";
import type { SponsoredSigner } from "#web/components/social/sponsored-transaction.ts";
import { runCommitFor } from "#web/components/social/commit/commit-run.ts";
import type { CommitSale } from "@blast/core/modules/social/commit/quote.ts";
import { judgeHeldBlast, sendHeldBlast } from "#web/components/social/commit/use-held-blast.ts";
import { createCommitQuotes } from "#web/components/social/commit/commit-quote.ts";
import type { CommitKit } from "#web/components/social/commit/commit-kit.ts";
import { tideFacts } from "../../../../test/fixtures/social/commit/commit-fixtures.ts";
import { FIXTURE_SUI, fixtureTradeQuote, fixtureWallet } from "../../../../test/fixtures/social/trade/trade-fixtures.ts";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { evaluateSponsorPolicy } from "@blast/core/modules/sponsor/policy.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { claimTestIdentity } from "../../../../../../packages/server/test/fixtures/modules/social/claims/claim-fixtures.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { commitOffLine, SOCIAL_COMMITS_PATH, type SocialCommitBuild } from "@blast/core/modules/social/contracts/commit.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialIntentRoutes } from "@blast/server/modules/social/intents/route.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { PRESALE_STORY_WALLETS, seedPresaleStory, type PresaleStory } from "../../../../../../packages/core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createCommitChain } from "@blast/server/modules/social/commit/chain.ts";
import { holdCoins, stubCoin, stubCommitCore, type StubCommitCore } from "../../../../../../packages/core/test/fixtures/modules/social/commit/commit-fixtures.ts";
import { createSocialCommitRoutes } from "@blast/server/modules/social/commit/route.ts";
import { balanceKey, offlineTradeChain, replayRouter, TEST_BLAST_FEE } from "../../../../../../packages/server/test/fixtures/modules/social/trades/fixtures.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";
import { sealTradeQuote, tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * The server-built commit over the real route: `POST /api/social/me/commits`
 * on the social route kit, as `blast_web` on a disposable primary with the
 * fixture `chain_read_v1` and the design's sample sales (`seedPresaleStory`).
 * The chain is the real `createCommitChain` over a stub Core API client (the
 * sale's object, the wallet's balance and coins) and a **mainnet** identity of
 * fixture ids, so the route builds the SDK's own commit. Then the browser's
 * flow end to end through that route: the presale sponsor's real policy
 * deciding (intent `commit`), the real intents route registering the digest
 * and logging the commit (T-024, R3-27), the signers the claim's doubles.
 *
 * No mainnet manifest exists here, so nothing is signed with a key and nothing
 * reaches a network; a real mainnet commit in a browser is R3-72's.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-commits-app";
const PEPPER = "social-commits-fixture-pepper-0123456789abcdef01";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.UTC(2026, 9, 4, 17);
const PRIVATE = "private, no-store";
const USDC = PORTFOLIO_COIN_TYPES.usdc;
const KAI_WALLET = normalizeSuiAddress(PRESALE_STORY_WALLETS.kai);
const WALLET_COOKIE_TOKEN = "d".repeat(43);
const identity = claimTestIdentity();
const PACKAGE = normalizeSuiAddress(identity.presale.packageId);
const LEAF = { index: "7", wallet_cap: "5000000000", proof: ["01".repeat(32), "02".repeat(32)] };

function token(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI_TOKEN = token("did:privy:presale-story-kai");
const KAI = `Bearer ${KAI_TOKEN}`;
const NOVA = `Bearer ${token("did:privy:presale-story-nova")}`;
const STRANGER = `Bearer ${token("did:privy:nobody-here")}`;
const SESSION = { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${WALLET_COOKIE_TOKEN}`, "sec-fetch-site": "same-origin" };

/** Embedded wallets by DID: Kai's is his story wallet; Nova's account has none yet. */
const EMBEDDED: Readonly<Record<string, string | null>> = {
  "did:privy:presale-story-kai": KAI_WALLET,
  "did:privy:presale-story-nova": null,
};

type Fixture = Readonly<{
  admin: Pool;
  story: PresaleStory;
  core: StubCommitCore;
  limiter: PostgresRateLimitEnforcer;
  /** Committing on (a mainnet deployment) or off (none). */
  deployment: { on: boolean; asked: number };
  build(body: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Every route the commit flow calls in the browser: the commit route, the intents route, and the sponsor's two (doubles). */
  fetch: typeof globalThis.fetch;
  /** Every call the browser made, in order. */
  calls: string[];
  /** What the sponsor double was asked to sponsor, and executed. */
  sponsored: Uint8Array[];
  executed: string[];
  swapQuote(quoteType?: string): Promise<{ id: string; minimum: bigint }>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 8 });
  // Nova's account exists (with no Blast wallet yet).
  await admin.query(
    "INSERT INTO social_accounts (account_id, privy_did, callsign, privacy, onboarded_at) VALUES ($1, 'did:privy:presale-story-nova', 'nova_c', 'public', now())",
    ["00000000-0000-4000-8000-00000000c0a8"],
  );
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-commits-web");
  try {
    const accounts = new PostgresSocialAccounts(() => web);
    const limiter = new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER });
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter,
      accounts,
      walletSessions: { live: async (cookie) => (cookie === WALLET_COOKIE_TOKEN ? { address: KAI_WALLET } : null) },
      primary: () => web,
    });
    const core = stubCommitCore(identity);
    for (const symbol of ["MRDN", "TIDE", "HLCN"]) {
      core.presales.set(story.presaleIds[symbol]!, { saleToken: story.saleTokens[symbol]!, quote: USDC, initialSharedVersion: "4242" });
    }
    // Kai holds $1,000 of USDC in two coins.
    holdCoins(core, KAI_WALLET, USDC, [stubCoin(1, 600_000_000n), stubCoin(2, 400_000_000n)]);
    // R3-41: on the chain Ondine raises SUI, and Kai holds 40 SUI in two coins of his own.
    core.presales.set(story.presaleIds.ONDN!, { saleToken: story.saleTokens.ONDN!, quote: SUI_COIN_TYPE, initialSharedVersion: "5150" });
    holdCoins(core, KAI_WALLET, SUI_COIN_TYPE, [stubCoin(3, 30_000_000_000n), stubCoin(4, 10_000_000_000n)]);
    const chain = createCommitChain({ client: core.client, identity });
    const router = replayRouter(undefined, TEST_BLAST_FEE).router;
    const swapChain = offlineTradeChain({ balances: { [balanceKey(KAI_WALLET, SUI_COIN_TYPE)]: 40_000_000_000n } });
    const reservations = new Map<string, Uint8Array>();
    const sponsored: Uint8Array[] = [];
    const executed: string[] = [];
    const calls: string[] = [];
    const reserve = (kind: Uint8Array, sender: string) => {
      sponsored.push(kind);
      const reservation = `res-${reservations.size + 1}`;
      const bytes = transactionBytesFor(kind, sender, FAKE_SPONSOR);
      reservations.set(reservation, bytes);
      return { reservation_id: reservation, transaction_bytes: toBase64(bytes), expires_at_ms: NOW + 60_000 };
    };
    const deployment = { on: true, asked: 0 };
    const routes = createSocialCommitRoutes({
      kit,
      deployment: async () => {
        deployment.asked += 1;
        return deployment.on ? identity : null;
      },
      chain: () => chain,
      blastWallet: async (caller) => (caller.kind === "privy" ? (EMBEDDED[caller.did] ?? null) : caller.address),
      swap: { database: () => autocommitReader(web, "social"), router: () => router, chain: () => swapChain, quoteKey: () => tradeQuoteKey(PEPPER), now: () => NOW },
      // A swap-and-commit is sponsored in-process: this double only reserves (the service's own checks are swap.test's).
      sponsor: () => ({ sponsorServerCommit: async (request) => ({ ...reserve(request.kindBytes, request.sender), sponsor_signature: "", gas_budget: "50000000" }) }),
    });
    const reader = createSocialConfigReader(autocommitReader(web, "social"), { now: () => 0 });
    const intents = createSocialIntentRoutes({ provenance: async () => {}, kit, config: reader.getSocialConfig, findBlockedTerm: reader.findBlockedTerm });
    const base = { "x-forwarded-for": "203.0.113.64" };
    const build = (body: unknown, headers: Record<string, string> = {}) =>
      routes.build(new Request(`${ORIGIN}${SOCIAL_COMMITS_PATH}`, {
        method: "POST",
        headers: { ...base, origin: ORIGIN, "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }), testClient());

    // The presale sponsor, as the flow sees it: its own policy decides (intent `commit`) and it pays the gas.
    const sponsor = async (body: Record<string, unknown>): Promise<Response> => {
      const kind = fromBase64(String(body.transaction_kind_bytes));
      const sale = core.presales.get(String(body.presale_id))!;
      const decision = evaluateSponsorPolicy({
        kind: bcs.TransactionKind.parse(kind),
        intent: "commit",
        presaleId: String(body.presale_id),
        sender: String(body.sender),
        facts: { presalePackageId: PACKAGE, saleToken: sale.saleToken, quote: sale.quote, rewardRounds: [], swapTargets: [] },
      });
      if (!decision.allowed) return Response.json({ error: { code: "target_not_allowed", message: decision.reason } }, { status: 422 });
      return Response.json(reserve(kind, String(body.sender)));
    };
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      calls.push(url.pathname);
      const headers = new Headers(init?.headers);
      headers.set("x-forwarded-for", "203.0.113.64");
      headers.set("origin", ORIGIN);
      // A wallet session's browser sends its HttpOnly cookie on a same-origin call (OA-16).
      if (!headers.has("authorization") && init?.credentials === "same-origin") {
        headers.set("cookie", SESSION.cookie);
        headers.set("sec-fetch-site", "same-origin");
      }
      const request = new Request(url, { method: init?.method, headers, body: init?.body ?? null });
      if (url.pathname === SOCIAL_COMMITS_PATH) return routes.build(request, testClient());
      if (url.pathname === "/api/social/intents") return intents.register.POST(request, testClient());
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.pathname === "/api/presale/sponsor") return sponsor(body);
      const reservation = /^\/api\/presale\/sponsor\/([^/]+)\/execute$/.exec(url.pathname)?.[1];
      const bytes = reservation ? reservations.get(reservation) : undefined;
      if (!bytes) return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
      const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
      executed.push(digest);
      return Response.json({ digest, effects: { status: "success", gas_used: "1000" } });
    }) as typeof globalThis.fetch;
    const swapQuote = async (quoteType = USDC) => {
      const found = await router.findRoute({ from: SUI_COIN_TYPE, target: USDC, amount: 1_000_000_000n, byAmountIn: true });
      assert.equal(found.status, "route");
      if (found.status !== "route") throw new Error("missing recorded route");
      const account = await accounts.resolve("did:privy:presale-story-kai");
      // Replay the SDK command shape for another quote type; this does not assert live liquidity.
      const route = { ...found.route, paths: found.route.paths.map((path) => ({ ...path, target: quoteType })) };
      const minimum = minOut(route.amountOut, 50);
      return { minimum, id: sealTradeQuote(tradeQuoteKey(PEPPER), { accountId: account!.account_id, sender: KAI_WALLET, side: "sell", inCoin: SUI_COIN_TYPE, outCoin: quoteType, amountIn: route.amountIn, amountOut: route.amountOut, minOut: minimum, slippageBps: 50, priceImpactBps: null, blastFeeBps: 50, issuedAtMs: NOW, expiresAtMs: NOW + 20_000, route }) };
    };
    await run({ admin, story, core, limiter, deployment, build, fetch, calls, sponsored, executed, swapQuote });
  } finally {
    await Promise.all([admin.end(), web.end()]);
    await database.drop();
  }
}

async function built(response: Response): Promise<SocialCommitBuild> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("commit-build-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as SocialCommitBuild;
}

async function refused(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body.error;
}

/** The kind's one presale call, its type arguments, its shared sale, and the coins it spends. */
function readKind(base64: string) {
  const kind = bcs.TransactionKind.parse(fromBase64(base64));
  const program = kind.ProgrammableTransaction!;
  const calls = program.commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []));
  const presaleCalls = calls.filter((call) => normalizeSuiAddress(call.package) === PACKAGE);
  const shared = program.inputs.find((input) => input.Object?.SharedObject && normalizeSuiAddress(input.Object.SharedObject.objectId) !== normalizeSuiAddress("0x6"))?.Object?.SharedObject;
  const owned = program.inputs.flatMap((input) => (input.Object?.ImmOrOwnedObject ? [normalizeSuiAddress(input.Object.ImmOrOwnedObject.objectId)] : []));
  return { kind, presaleCalls, shared, owned };
}

test("the commit route: Kai's commit is the SDK's commit_open for his own Blast wallet, built on the server, and the sponsor's commit policy takes it", { skip }, async () => {
  await withFixture(async ({ build, story, core, admin }) => {
    const meridian = story.presaleIds.MRDN!;
    const body = { presale_id: meridian, pay_with: "QUOTE", amount: "50000000" };
    assert.deepEqual(validator.validate("commit-build-request", body).errors, []);
    const order = await built(await build(body, { authorization: KAI }));
    assert.deepEqual(
      [order.presale_id, order.sender, order.fee, order.route, order.quote_type, order.amount],
      [meridian, KAI_WALLET, "sponsored", "open", USDC, "50000000"],
    );
    const { kind, presaleCalls, shared, owned } = readKind(order.transaction_kind_bytes);
    assert.deepEqual(
      presaleCalls.map((call) => [call.module, call.function, call.typeArguments.map((type) => normalizeStructTag(type))]),
      [["blast_presale", "commit_open", [normalizeStructTag(story.saleTokens.MRDN!), USDC]]],
    );
    // The sale as the chain holds it (its shared version), and Kai's own USDC coins.
    assert.deepEqual([normalizeSuiAddress(shared!.objectId), String(shared!.initialSharedVersion), shared!.mutable], [meridian, "4242", true]);
    assert.deepEqual(owned.sort(), [stubCoin(1, 0n).objectId, stubCoin(2, 0n).objectId].sort());
    // The presale sponsor's own policy (intent `commit`) takes it from Kai, and refuses it from anyone else.
    const facts = { presalePackageId: PACKAGE, saleToken: story.saleTokens.MRDN!, quote: USDC, rewardRounds: [], swapTargets: [] };
    assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: meridian, sender: KAI_WALLET, facts }), { allowed: true });
    const nova = evaluateSponsorPolicy({ kind, intent: "commit", presaleId: meridian, sender: normalizeSuiAddress("0x50fa"), facts });
    assert.equal(nova.allowed, false);
    assert.equal(core.calls.getObjects, 1);

    // A wallet session (Slush): the same commit from the session's own address, sponsored like an embedded wallet
    // (owner ruling 2026-11-20, reversing OA-17).
    const own = await built(await build(body, SESSION));
    assert.deepEqual([own.sender, own.fee, own.route], [KAI_WALLET, "sponsored", "open"]);
    assert.deepEqual(readKind(own.transaction_kind_bytes).presaleCalls.map((call) => call.function), ["commit_open"]);

    core.presales.set(meridian, { ...core.presales.get(meridian)!, eligibility: { kind: "allowlisted", leafCount: 1n, root: "01".repeat(32) } });
    // An allowlisted sale: commit_allowlisted with the wallet's leaf.
    const allowlisted = await built(await build({ ...body, allowlist: LEAF }, { authorization: KAI }));
    assert.equal(allowlisted.route, "allowlisted");
    const leafCall = readKind(allowlisted.transaction_kind_bytes);
    assert.deepEqual(leafCall.presaleCalls.map((call) => call.function), ["commit_allowlisted"]);
    assert.deepEqual(evaluateSponsorPolicy({ kind: leafCall.kind, intent: "commit", presaleId: meridian, sender: KAI_WALLET, facts }), { allowed: true });

    // A build writes nothing: the registration is the commit's log row (T-024, R3-27), and it needs the digest.
    const written = await admin.query("SELECT (SELECT count(*) FROM social_transactions)::int AS logged, (SELECT count(*) FROM social_intents)::int AS intents");
    assert.deepEqual(written.rows[0], { logged: 0, intents: 0 });
  });
});

test("the commit route: a visitor, a caller with no account, no Blast wallet and a cross-site cookie are refused before the chain is read", { skip }, async () => {
  await withFixture(async ({ build, story, core, deployment }) => {
    const body = { presale_id: story.presaleIds.MRDN!, pay_with: "QUOTE", amount: "50000000" };
    await refused(await build(body), 401, "unauthorized");
    await refused(await build(body, { authorization: STRANGER }), 409, "account_required");
    await refused(await build(body, { authorization: NOVA }), 409, "blast_wallet_missing");
    await refused(await build(body, { cookie: SESSION.cookie, "sec-fetch-site": "cross-site" }), 403, "origin_invalid");
    assert.deepEqual([deployment.asked, core.calls.getObjects, core.calls.getBalance], [0, 0, 0]);
  });
});

test("the commit route: a malformed body is invalid_request, and the published schema refuses the same bodies", { skip }, async () => {
  await withFixture(async ({ build, story, deployment }) => {
    const good = { presale_id: story.presaleIds.MRDN!, pay_with: "QUOTE", amount: "50000000" };
    const bad: Record<string, unknown>[] = [
      { presale_id: good.presale_id, pay_with: "QUOTE" },
      { ...good, amount: "0" },
      { ...good, amount: "-1" },
      { ...good, amount: "1.5" },
      { ...good, amount: 50000000 },
      { ...good, pay_with: "EUR" },
      { ...good, swap_quote_id: "" },
      { ...good, swap_quote_id: 42 },
      { ...good, swap_quote_id: "q".repeat(3001) },
      { ...good, presale_id: good.presale_id.toUpperCase().replace("0X", "0x") },
      { ...good, recipient: KAI_WALLET },
      { ...good, why: "in" },
      { ...good, allowlist: { ...LEAF, wallet: KAI_WALLET } },
      { ...good, allowlist: { index: "7", proof: [] } },
      { ...good, allowlist: { ...LEAF, proof: [`0x${"01".repeat(32)}`] } },
      { ...good, allowlist: { ...LEAF, proof: Array.from({ length: 17 }, () => "01".repeat(32)) } },
      { ...good, allowlist: null },
    ];
    for (const body of bad) {
      await refused(await build(body, { authorization: KAI }), 400, "invalid_request");
      assert.equal(validator.validate("commit-build-request", body).valid, false, JSON.stringify(body));
    }
    // One past the largest u64: twenty digits the schema's pattern admits, the route refuses.
    await refused(await build({ ...good, amount: "18446744073709551616" }, { authorization: KAI }), 400, "invalid_request");
    await refused(await build("not json", { authorization: KAI }), 400, "invalid_request");
    await refused(await build(good, { authorization: KAI, "content-type": "text/plain" }), 400, "invalid_request");
    // The largest u64 is a well-formed amount (the balance decides).
    assert.equal(validator.validate("commit-build-request", { ...good, amount: "18446744073709551615" }).valid, true);
    assert.equal(deployment.asked, 0, "a malformed body never reaches the deployment");
  });
});

test("the commit route: with no mainnet deployment it is the named commit_unavailable; a node outage is 503; another deployment's sale and a short balance are named while retired selectors are rejected", { skip }, async () => {
  await withFixture(async ({ build, story, core, deployment }) => {
    const body = { presale_id: story.presaleIds.MRDN!, pay_with: "QUOTE", amount: "50000000" };
    // No PRESALE_DEPLOYMENT_MANIFEST naming a mainnet package: blasting is off, said by name, and nothing is read from the chain.
    deployment.on = false;
    const off = await refused(await build(body, { authorization: KAI }), 409, "commit_unavailable");
    assert.deepEqual(off.reasons, ["presale_not_deployed"]);
    assert.deepEqual([core.calls.getObjects, core.calls.getBalance, core.calls.listCoins], [0, 0, 0]);
    deployment.on = true;

    // The deployment's node does not answer: 503 with Retry-After, nothing built.
    core.state.down = true;
    const down = await build(body, { authorization: KAI });
    await refused(down.clone(), 503, "service_unavailable");
    assert.ok(Number(down.headers.get("retry-after")) > 0);
    core.state.down = false;

    // A sale the manifest's package does not hold (the indexer names it, the chain does not).
    await refused(await build({ ...body, presale_id: story.presaleIds.KSTL! }, { authorization: KAI }), 404, "not_found");
    // Asset selection belongs to the sale; old request selectors are not another payment route.
    await refused(await build({ ...body, pay_with: "SUI" }, { authorization: KAI }), 400, "invalid_request");
    // More than the Blast wallet holds ($1,000): named, never a 503 from the SDK's coin resolution.
    await refused(await build({ ...body, amount: "1000000001" }, { authorization: KAI }), 409, "insufficient_balance");
    await built(await build({ ...body, amount: "1000000000" }, { authorization: KAI }));
  });
});

test("the commit route: a full social_commit bucket is 429 with Retry-After", { skip }, async () => {
  await withFixture(async ({ build, story, limiter }) => {
    for (let n = 0; n < 60; n += 1) await limiter.consume("social_commit", { accountId: "did:privy:presale-story-kai" });
    const limited = await build({ presale_id: story.presaleIds.MRDN!, pay_with: "QUOTE", amount: "50000000" }, { authorization: KAI });
    await refused(limited.clone(), 429, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });
});

const MERIDIAN_SALE = (presaleId: string): CommitSale => ({
  presaleId,
  name: "Meridian",
  symbol: "MRDN",
  lifecycle: "open",
  endMs: Number.MAX_SAFE_INTEGER,
  quoteCoin: "USDC",
  minCommitment: 10,
  walletCap: null,
  allowlisted: false,
  raised: 184_221,
  target: 250_000,
  presalePrice: null,
});

test("end to end through the real route: the browser asks the server for the commit, then signs and submits it, sponsored for an embedded wallet and a wallet session alike, and every commit is registered and logged", { skip }, async () => {
  await withFixture(async ({ story, fetch, calls, sponsored, executed, admin, deployment }) => {
    const meridian = story.presaleIds.MRDN!;
    const blast = (signer: SponsoredSigner, getAccessToken: () => Promise<string | null>) =>
      runCommitFor({
        api: { getAccessToken, fetch },
        signer,
        blockers: [],
        sale: MERIDIAN_SALE(meridian),
        input: { payWith: "USDC", pay: 50, usd: 50, quote: 50, why: "Great team, real product." },
        sourceEntryId: null,
        allowlist: null,
      });

    // A Privy embedded wallet: sponsored. The server's kind is what the sponsor was asked for.
    const signed: Uint8Array[] = [];
    const sent = await blast(sponsoredSigner(KAI_WALLET, { signed }), async () => KAI_TOKEN);
    assert.equal(sent.status, "sent", JSON.stringify(sent));
    assert.deepEqual(calls, [SOCIAL_COMMITS_PATH, "/api/presale/sponsor", "/api/social/intents", "/api/presale/sponsor/res-1/execute"]);
    assert.equal(sponsored.length, 1);
    assert.deepEqual(readKind(toBase64(sponsored[0]!)).presaleCalls.map((call) => call.function), ["commit_open"]);
    const sponsoredDigest = sent.status === "sent" ? sent.digest : "";
    assert.equal(TransactionDataBuilder.getDigestFromBytes(signed[0]!), sponsoredDigest, "the sponsor's bytes, and only those, were signed");

    // A Slush wallet session: sponsored too (owner ruling 2026-11-20, reversing OA-17). The wallet signs exactly the
    // sponsor's bytes and answers them unchanged; Blast's sponsor executes them.
    calls.length = 0;
    const sessionSigned: Uint8Array[] = [];
    const session = walletSigner(KAI_WALLET, { signed: sessionSigned });
    const own = await runCommit(
      {
        api: { getAccessToken: async () => null, fetch },
        signer: sponsoredWalletSigner(session),
      },
      { presaleId: meridian, order: { payWith: "QUOTE", amount: "25000000" }, usdValue: "25.00" },
    );
    assert.equal(own.status, "sent", JSON.stringify(own));
    assert.deepEqual(calls, [SOCIAL_COMMITS_PATH, "/api/presale/sponsor", "/api/social/intents", "/api/presale/sponsor/res-2/execute"]);
    assert.equal(sponsored.length, 2);
    const ownDigest = own.status === "sent" ? own.digest : "";
    assert.equal(TransactionDataBuilder.getDigestFromBytes(sessionSigned[0]!), ownDigest, "the session signed the sponsor's bytes, and only those");

    // Both commits are registered, and each is a submitted row of the account's log with exactly what the server built.
    const logged = await admin.query(
      `SELECT kind, state, digest, presale_id, quote_type, quote_amount::text, usd_value::text, idempotency_key
       FROM social_transactions ORDER BY quote_amount DESC`,
    );
    assert.deepEqual(logged.rows, [
      { kind: "commit", state: "submitted", digest: sponsoredDigest, presale_id: meridian, quote_type: USDC, quote_amount: "50000000", usd_value: "50.00", idempotency_key: `commit:${sponsoredDigest}` },
      { kind: "commit", state: "submitted", digest: ownDigest, presale_id: meridian, quote_type: USDC, quote_amount: "25000000", usd_value: "25.00", idempotency_key: `commit:${ownDigest}` },
    ]);
    const registered = await admin.query("SELECT tx_digest, why_text FROM social_intents ORDER BY why_text NULLS LAST");
    assert.deepEqual(registered.rows, [
      { tx_digest: sponsoredDigest, why_text: "Great team, real product." },
      { tx_digest: ownDigest, why_text: null },
    ]);
    assert.deepEqual(executed, [sponsoredDigest, ownDigest]);

    // A server with no mainnet deployment: the browser says so by name, and nothing is sponsored, signed or executed.
    deployment.on = false;
    calls.length = 0;
    const quiet: Uint8Array[] = [];
    const off = await blast(sponsoredSigner(KAI_WALLET, { signed: quiet }), async () => KAI_TOKEN);
    assert.equal(off.status, "failed");
    assert.equal(off.digest, null);
    assert.ok(off.message?.startsWith(commitOffLine(["presale_not_deployed"])!));
    assert.match(off.message!, /Code: commit_unavailable/);
    assert.deepEqual(calls, [SOCIAL_COMMITS_PATH]);
    assert.deepEqual([quiet.length, executed.length], [0, 2]);
  });
});

const usesGasCoin = (base64: string) =>
  readKind(base64).kind.ProgrammableTransaction!.commands.some((command) => JSON.stringify(command).includes("GasCoin"));

test("held Blast: a wallet with no USDC pays with the SUI chosen in Settings, swapping it and buying a USDC presale with one signature and one logged commitment", { skip }, async () => {
  await withFixture(async ({ story, core, swapQuote, fetch, calls, sponsored, executed, admin }) => {
    holdCoins(core, KAI_WALLET, USDC, []);
    const quote = await swapQuote();
    const signed: Uint8Array[] = [];
    // The recorded route spends 1 SUI; use a $1 minimum in this sale fixture.
    const sale = { ...MERIDIAN_SALE(story.presaleIds.MRDN!), minCommitment: 1 };
    await admin.query("UPDATE blast_infra_fixture.presales SET min_commitment = 1000000 WHERE presale_id = $1", [sale.presaleId]);
    const wallet = fixtureWallet();
    const facts = {
      // SUI at the recorded route's own price (about $1.19), so the hold's value check passes.
      ...tideFacts({ sale, viewer: { usdc: 0, sui: 40, suiUsd: 1.2 } }),
      wallet: { ...wallet, coins: wallet.coins!.map((coin) => coin.coin_type === FIXTURE_SUI ? { ...coin, atoms: "40000000000", usd_price: "1.2" } : coin) },
    };
    const kit: Pick<CommitKit, "quotes" | "quotePayment" | "send" | "holdCoin"> = {
      quotes: createCommitQuotes({ client: createTestQueryClient(), read: async () => facts }),
      holdCoin: { peek: () => FIXTURE_SUI, read: async () => FIXTURE_SUI },
      quotePayment: async (request) => {
        assert.equal(request.amount_in, "1000000000");
        const body = { ...fixtureTradeQuote(request, { signedIn: true, nowMs: NOW, wallet: fixtureWallet() }), quote_id: quote.id, amount_out: (quote.minimum * 10000n / 9950n + 1n).toString(), min_out: quote.minimum.toString() };
        return { status: "ok", httpStatus: 200, body };
      },
      send: async (_facts, input) => {
        const sent = await runCommitFor({
          api: { getAccessToken: async () => KAI_TOKEN, fetch },
          signer: sponsoredSigner(KAI_WALLET, { signed }), blockers: [], sale, input,
          sourceEntryId: null, allowlist: null,
        });
        assert.equal(sent.status, "sent", JSON.stringify(sent));
        return { status: "sent", digest: sent.digest! };
      },
    };
    try {
      const judged = await judgeHeldBlast(kit, sale.presaleId, 1.2, NOW);
      assert.ok(!("refusal" in judged), JSON.stringify(judged));
      await sendHeldBlast(kit, judged, null);
    } finally { kit.quotes.dispose(); }
    assert.equal(signed.length, 1);
    assert.equal(executed.length, 1);
    assert.deepEqual(calls, [SOCIAL_COMMITS_PATH, "/api/social/intents", "/api/presale/sponsor/res-1/execute"], "the commit route reserved the gas; the public sponsor route was never asked");
    const kind = bcs.TransactionKind.parse(sponsored[0]!);
    const functions = kind.ProgrammableTransaction!.commands.flatMap((command) => command.MoveCall?.function ?? []);
    assert.ok(functions.indexOf("confirm_swap_v3") < functions.indexOf("commit_open"));
    const logged = await admin.query("SELECT kind, quote_type, quote_amount::text FROM social_transactions");
    assert.deepEqual(logged.rows, [{ kind: "commit", quote_type: USDC, quote_amount: quote.minimum.toString() }]);
  });
});

test("R3-41: a SUI-quoted sale — a sponsored commit splits Kai's own SUI, never the gas coin, and the sponsor's policy takes it; a wallet session is sponsored the same way; too little SUI is insufficient_balance", { skip }, async () => {
  await withFixture(async ({ build, story }) => {
    const ondine = story.presaleIds.ONDN!;
    const body = { presale_id: ondine, pay_with: "QUOTE", amount: "25000000000" };
    const order = await built(await build(body, { authorization: KAI }));
    assert.deepEqual(
      [order.sender, order.fee, order.route, order.quote_type, order.amount],
      [KAI_WALLET, "sponsored", "open", SUI_COIN_TYPE, "25000000000"],
    );
    const { kind, presaleCalls, owned } = readKind(order.transaction_kind_bytes);
    assert.equal(usesGasCoin(order.transaction_kind_bytes), false, "a sponsored kind never spends the sponsor's gas coin");
    assert.deepEqual(owned.sort(), [stubCoin(3, 0n).objectId, stubCoin(4, 0n).objectId].sort(), "Kai's own SUI coins, merged and split");
    assert.deepEqual(
      presaleCalls.map((call) => [call.function, call.typeArguments.map((type) => normalizeStructTag(type))]),
      [["commit_open", [normalizeStructTag(story.saleTokens.ONDN!), SUI_COIN_TYPE]]],
    );
    const facts = { presalePackageId: PACKAGE, saleToken: story.saleTokens.ONDN!, quote: SUI_COIN_TYPE, rewardRounds: [], swapTargets: [] };
    assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: ondine, sender: KAI_WALLET, facts }), { allowed: true });

    // A wallet session is sponsored too (owner ruling 2026-11-20, reversing OA-17): its SUI comes from its own coins,
    // never the gas coin.
    const own = await built(await build(body, SESSION));
    assert.deepEqual([own.fee, own.quote_type], ["sponsored", SUI_COIN_TYPE]);
    assert.equal(usesGasCoin(own.transaction_kind_bytes), false);

    // More SUI than the Blast wallet holds (40): named, never invented, never a 503 from the coin resolution.
    await refused(await build({ ...body, amount: "40000000001" }, { authorization: KAI }), 409, "insufficient_balance");
    await built(await build({ ...body, amount: "40000000000" }, { authorization: KAI }));
    // The canonical request works for SUI without accepting old asset selectors.
    await refused(await build({ ...body, pay_with: "USDC" }, { authorization: KAI }), 400, "invalid_request");
  });
});

test("R3-41 end to end: a sponsored SUI commit through the real route and the presale sponsor's real policy is sent, registered and logged in SUI", { skip }, async () => {
  await withFixture(async ({ story, fetch, calls, sponsored, executed, admin }) => {
    const ondine = story.presaleIds.ONDN!;
    const signed: Uint8Array[] = [];
    const sent = await runCommitFor({
      api: { getAccessToken: async () => KAI_TOKEN, fetch },
      signer: sponsoredSigner(KAI_WALLET, { signed }),
      blockers: [],
      sale: { ...MERIDIAN_SALE(ondine), name: "Ondine", symbol: "ONDN", quoteCoin: "SUI", minCommitment: 25, raised: 0, target: 52_631.58 },
      input: { payWith: "SUI", pay: 25, usd: 85.5, quote: 25, why: "" },
      sourceEntryId: null,
      allowlist: null,
    });
    assert.equal(sent.status, "sent", JSON.stringify(sent));
    assert.deepEqual(calls, [SOCIAL_COMMITS_PATH, "/api/presale/sponsor", "/api/social/intents", "/api/presale/sponsor/res-1/execute"]);
    assert.equal(usesGasCoin(toBase64(sponsored[0]!)), false);
    const digest = sent.status === "sent" ? sent.digest : "";
    assert.deepEqual(executed, [digest]);
    const logged = await admin.query("SELECT kind, state, quote_type, quote_amount::text, usd_value::text FROM social_transactions");
    assert.deepEqual(logged.rows, [{ kind: "commit", state: "submitted", quote_type: SUI_COIN_TYPE, quote_amount: "25000000000", usd_value: "85.50" }]);
  });
});

test("QUOTE pays a TSUI presale using the chain's type and exact atoms, direct and swapped, sponsored", { skip }, async () => {
  await withFixture(async ({ build, story, core, swapQuote, fetch, executed, admin }) => {
    const id = story.presaleIds.MRDN!;
    const quote = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";
    core.presales.set(id, { ...core.presales.get(id)!, quote });
    holdCoins(core, KAI_WALLET, quote, [stubCoin(11, 50_000_000_001n)]);
    const body = { presale_id: id, pay_with: "QUOTE", amount: "25000000001" };
    assert.deepEqual(validator.validate("commit-build-request", body).errors, []);
    for (const headers of [{ authorization: KAI }, SESSION]) {
      const order = await built(await build(body, headers));
      assert.equal(order.quote_type, quote);
      assert.equal(order.amount, body.amount);
      const { kind, presaleCalls } = readKind(order.transaction_kind_bytes);
      assert.deepEqual(presaleCalls[0]!.typeArguments.map(normalizeStructTag), [normalizeStructTag(story.saleTokens.MRDN!), quote]);
      assert.deepEqual(evaluateSponsorPolicy({ kind, intent: "commit", presaleId: id, sender: KAI_WALLET, facts: { presalePackageId: PACKAGE, saleToken: story.saleTokens.MRDN!, quote, rewardRounds: [], swapTargets: [] } }), { allowed: true });
    }
    await refused(await build({ ...body, pay_with: "USDC" }, { authorization: KAI }), 400, "invalid_request");
    await refused(await build({ ...body, amount: "50000000002" }, { authorization: KAI }), 409, "insufficient_balance");
    const routed = await swapQuote(quote);
    const signed: Uint8Array[] = [];
    for (const swap of [false, true]) {
      const atoms = swap ? routed.minimum.toString() : body.amount;
      const sent = await runCommitFor({
        api: { getAccessToken: async () => KAI_TOKEN, fetch },
        signer: sponsoredSigner(KAI_WALLET, { signed }), blockers: [],
        sale: { ...MERIDIAN_SALE(id), quoteCoin: "TSUI", quoteType: quote, quoteDecimals: 9 },
        input: { payWith: "TSUI", pay: swap ? 1 : 25.000000001, usd: 0, quote: Number(atoms) / 1e9, quoteAtoms: atoms,
          ...(swap ? { swapQuoteId: routed.id, paymentSymbol: "SUI" } : {}), why: "" },
        sourceEntryId: null, allowlist: null,
      });
      assert.equal(sent.status, "sent", JSON.stringify(sent));
    }
    assert.equal(signed.length, 2);
    assert.equal(executed.length, 2);
    const logged = await admin.query("SELECT quote_type, quote_amount::text FROM social_transactions ORDER BY quote_amount DESC");
    assert.deepEqual(logged.rows, [{ quote_type: quote, quote_amount: body.amount }, { quote_type: quote, quote_amount: routed.minimum.toString() }]);
  });
});
