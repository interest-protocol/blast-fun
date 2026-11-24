import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";
import type { CreatorTransaction } from "@blast/server/modules/social/creator-earnings/chain.ts";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { createClaimRunner } from "#web/components/social/claim/claim-runner.ts";
import { isCreatorCapsClaimTarget, isLaunchClaimTarget } from "#web/components/social/claim/claims.ts";
import { FAKE_SPONSOR, sponsoredSigner, transactionBytesFor, walletSigner } from "../../../../test/fixtures/social/claim/claim-doubles.ts";
import { sponsoredWalletSigner } from "#web/lib/sui-signing.ts";
import { runClaim, type ClaimSigner } from "#web/components/social/claim/claim-flow.ts";
import { TransactionDataBuilder } from "@mysten/sui/transactions";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { evaluateSponsorPolicy, referencedVestingSchedules } from "@blast/core/modules/sponsor/policy.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialClaim } from "@blast/core/modules/social/contracts/claims.ts";
import type { SocialTransactionsPage } from "@blast/core/modules/social/contracts/transactions.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { PRESALE_STORY_WALLETS, seedPresaleStory, type PresaleStory } from "../../../../../../packages/core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialTransactionsRoute } from "@blast/server/modules/social/transactions/route.ts";
import { claimedEventEntry, claimTestIdentity, executedClaim, stubClaimChain, type StubClaimChain } from "../../../../../../packages/server/test/fixtures/modules/social/claims/claim-fixtures.ts";
import { claimedEvents } from "@blast/server/modules/social/claims/chain.ts";
import { createSocialClaimRoutes } from "@blast/server/modules/social/claims/route.ts";

/**
 * R3-63 over the real route: `PUT /api/social/me/claims/{request_id}` on the
 * social route kit, as `blast_web` on a disposable primary with the fixture
 * `chain_read_v1` and the design's sample sales (`seedPresaleStory`): Kai has
 * Halcyon's $250 refund to claim (a cancelled sale), and — set here — his
 * Kestrel tokens unclaimed (a migrated sale). The chain is a stub (the sale's
 * object, the dry run, executed transactions by digest) over a **mainnet**
 * identity of fixture ids; the sponsor and the wallet are the flow's test
 * doubles. Nothing is signed with a key and nothing reaches a network.
 *
 * Fixture-only (OA-23): the live indexer and a real mainnet claim are R3-72's.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-claims-app";
const PEPPER = "social-claims-fixture-pepper-0123456789abcdef012";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.UTC(2026, 9, 4, 17);
const PRIVATE = "private, no-store";
const USDC = PORTFOLIO_COIN_TYPES.usdc;
const KAI_WALLET = normalizeSuiAddress(PRESALE_STORY_WALLETS.kai);
const NOVA_WALLET = normalizeSuiAddress(`0x${"50fa".padStart(64, "0")}`);
const WALLET_COOKIE_TOKEN = "c".repeat(43);
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OTHER_DIGEST = "9GmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nWx";
const identity = claimTestIdentity();

function token(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI = `Bearer ${token("did:privy:presale-story-kai")}`;
const LUCA = `Bearer ${token("did:privy:presale-story-luca")}`;
const NOVA = `Bearer ${token("did:privy:presale-story-nova")}`;
const STRANGER = `Bearer ${token("did:privy:nobody-here")}`;
const SESSION = { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${WALLET_COOKIE_TOKEN}`, "sec-fetch-site": "same-origin" };

/** Embedded wallets by DID: Kai's is his story wallet; Luca's his; Nova's account has none yet. */
const EMBEDDED: Readonly<Record<string, string | null>> = {
  "did:privy:presale-story-kai": KAI_WALLET,
  "did:privy:presale-story-luca": normalizeSuiAddress(PRESALE_STORY_WALLETS.luca),
  "did:privy:presale-story-nova": null,
};

type Fixture = Readonly<{
  admin: Pool;
  story: PresaleStory;
  chain: StubClaimChain;
  limiter: PostgresRateLimitEnforcer;
  /** Claiming on/off, or a failed node lookup; count every attempt to resolve it. */
  deployment: { on: boolean; down: boolean; calls: number };
  claim(id: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  /** The log's first page, as the wallet reads it. */
  log(headers?: Record<string, string>): Promise<SocialTransactionsPage>;
  /** Every route the claim flow calls in the browser: the claims route, and the sponsor's two (doubles). */
  fetch: typeof globalThis.fetch;
  /** Executes signed bytes on the stub fullnode: a `Claimed` event for the sender from the sale; its digest. */
  land(bytes: Uint8Array): string;
  rows(): Promise<Record<string, unknown>[]>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 8 });
  // Nova's account exists (with no Blast wallet yet).
  await admin.query(
    "INSERT INTO social_accounts (account_id, privy_did, callsign, privacy, onboarded_at) VALUES ($1, 'did:privy:presale-story-nova', 'nova_x', 'public', now())",
    ["00000000-0000-4000-8000-00000000c0a7"],
  );
  // Kestrel launched; Kai's tokens are still unclaimed (the story claims every trading position).
  await admin.query(
    `UPDATE blast_infra_fixture.presale_positions SET claim_digest = NULL, claimed_tokens = NULL, claimed_quote_refund = NULL, claimed_ms = NULL
     WHERE presale_id = $1 AND wallet = $2`,
    [story.presaleIds.KSTL, KAI_WALLET],
  );
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-claims-web");
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
    const chain = stubClaimChain();
    for (const symbol of ["HLCN", "KSTL", "CBLT"]) {
      chain.presales.set(story.presaleIds[symbol]!, {
        objectId: story.presaleIds[symbol]!,
        initialSharedVersion: "4242",
        saleToken: normalizeStructTag(story.saleTokens[symbol]!),
        quote: USDC,
      });
    }
    const deployment = { on: true, down: false, calls: 0 };
    const primary = autocommitReader(web, "social");
    const routes = createSocialClaimRoutes({
      // Fixture digests are labels; provenance itself is covered with genuine bytes.
      verifyProvenance: async () => {},
      kit,
      database: () => primary,
      deployment: async () => {
        deployment.calls += 1;
        if (deployment.down) throw new Error("UNAVAILABLE");
        return deployment.on ? identity : null;
      },
      chain: () => chain,
      blastWallet: async (caller) => (caller.kind === "privy" ? (EMBEDDED[caller.did] ?? null) : caller.address),
    });
    const transactions = createSocialTransactionsRoute({ kit, database: () => primary });
    const base = { "x-forwarded-for": "203.0.113.63" };
    const claim = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      routes.claim(new Request(`${ORIGIN}/api/social/me/claims/${id}`, {
        method: "PUT",
        headers: { ...base, origin: ORIGIN, "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }), testClient());

    // The presale sponsor, as the flow sees it: its own policy decides (intent `claim`), it pays the gas,
    // and executing records the transaction where the stub fullnode will find it.
    const reservations = new Map<string, Uint8Array>();
    const sponsor = async (body: Record<string, unknown>): Promise<Response> => {
      const kind = fromBase64(String(body.transaction_kind_bytes));
      const presale = chain.presales.get(String(body.presale_id))!;
      const parsed = bcs.TransactionKind.parse(kind);
      const vestingSchedules = referencedVestingSchedules(parsed).flatMap((id) => chain.vestings.get(id) ?? []);
      const decision = evaluateSponsorPolicy({
        kind: parsed,
        intent: "claim",
        presaleId: String(body.presale_id),
        sender: String(body.sender),
        facts: { presalePackageId: identity.presale.packageId, saleToken: presale.saleToken, quote: presale.quote, rewardRounds: [], swapTargets: [], vestingSchedules },
      });
      if (!decision.allowed) return Response.json({ error: { code: "target_not_allowed", message: decision.reason } }, { status: 422 });
      const reservation = `res-${reservations.size + 1}`;
      const bytes = transactionBytesFor(kind, String(body.sender), FAKE_SPONSOR);
      reservations.set(reservation, bytes);
      return Response.json({ reservation_id: reservation, transaction_bytes: toBase64(bytes), expires_at_ms: NOW + 60_000 });
    };
    const land = (bytes: Uint8Array) => {
      const data = bcs.TransactionData.parse(bytes).V1!;
      const sender = normalizeSuiAddress(data.sender);
      const call = data.kind.ProgrammableTransaction!.commands[0]!.MoveCall!;
      const shared = data.kind.ProgrammableTransaction!.inputs.find((input) => input.Object?.SharedObject)?.Object?.SharedObject;
      const presaleId = normalizeSuiAddress(shared!.objectId);
      const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
      if (normalizeSuiAddress(call.package) === VESTING_PACKAGE) {
        // A vesting claim (P-13) pays the schedule's beneficiary, whoever sent it.
        const vestingClaims = [{ vestingId: presaleId, beneficiary: chain.vestings.get(presaleId)!.beneficiary }];
        chain.executions.set(digest, executedClaim({ sender, vestingClaims, timestampMs: NOW + 1_000 }));
        return digest;
      }
      const event = claimedEventEntry(identity, { saleToken: call.typeArguments[0]!, quote: call.typeArguments[1]! }, { presaleId, participant: sender });
      chain.executions.set(digest, executedClaim({ sender, claims: claimedEvents([event], identity), timestampMs: NOW + 1_000 }));
      return digest;
    };
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      const headers = new Headers(init?.headers);
      headers.set("x-forwarded-for", "203.0.113.63");
      headers.set("origin", ORIGIN);
      // A wallet session's browser sends its HttpOnly cookie on a same-origin call (OA-16).
      if (!headers.has("authorization") && init?.credentials === "same-origin") {
        headers.set("cookie", SESSION.cookie);
        headers.set("sec-fetch-site", "same-origin");
      }
      if (url.pathname.startsWith("/api/social/me/claims/")) {
        return routes.claim(new Request(url, { method: init?.method, headers, body: init?.body ?? null }), testClient());
      }
      if (url.pathname === "/api/social/me/transactions") return transactions.GET(new Request(url, { headers }), testClient());
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.pathname === "/api/presale/sponsor") return sponsor(body);
      const reservation = /^\/api\/presale\/sponsor\/([^/]+)\/execute$/.exec(url.pathname)?.[1];
      const bytes = reservation ? reservations.get(reservation) : undefined;
      if (!bytes) return Response.json({ error: { code: "not_found", message: "x" } }, { status: 404 });
      return Response.json({ digest: land(bytes), effects: { status: "success" } });
    }) as typeof globalThis.fetch;
    await run({
      admin,
      story,
      chain,
      limiter,
      deployment,
      claim,
      fetch,
      land,
      log: async (headers = { authorization: KAI }) => {
        const response = await transactions.GET(new Request(`${ORIGIN}/api/social/me/transactions`, { headers: { ...base, ...headers } }), testClient());
        assert.equal(response.status, 200);
        return (await response.json()) as SocialTransactionsPage;
      },
      rows: async () =>
        (await admin.query(
          `SELECT tx_id::text, kind, state, digest, failure_code, presale_id, coin_type, amount::text, quote_type, quote_amount::text,
             usd_value::text, idempotency_key, settled_at_ms IS NOT NULL AS settled
           FROM social_transactions ORDER BY created_at_ms, tx_id`,
        )).rows,
    });
  } finally {
    await Promise.all([admin.end(), web.end()]);
    await database.drop();
  }
}

async function answer(response: Response, status: number): Promise<SocialClaim> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate("claim-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as SocialClaim;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
}

test("R3-63-AC-1: a refund claim is logged before anything is signed, with the kind to sign; its digest is recorded, then settled from the fullnode", { skip }, async () => {
  await withFixture(async ({ claim, chain, story, rows, log }) => {
    const id = randomUUID();
    const halcyon = story.presaleIds.HLCN!;
    const body = { presale_id: halcyon, kind: "claim_refund" };
    assert.deepEqual(validator.validate("claim-request", body).errors, []);
    const recorded = await answer(await claim(id, body, { authorization: KAI }), 201);
    assert.deepEqual(
      [recorded.request_id, recorded.state, recorded.digest, recorded.failure_code, recorded.move_abort, recorded.fee],
      [id, "submitted", null, null, null, "sponsored"],
    );
    // The kind to sign: blast_presale::claim for Kai's own wallet, dry-run as that wallet first.
    const kind = bcs.TransactionKind.parse(fromBase64(recorded.transaction_kind_bytes!));
    const call = kind.ProgrammableTransaction!.commands[0]!.MoveCall!;
    assert.deepEqual([call.module, call.function], ["blast_presale", "claim"]);
    assert.deepEqual(chain.simulated.map((run) => run.sender), [KAI_WALLET]);
    // Logged now, before any signature: one submitted row, its facts the refund's (250 USDC at face value).
    assert.deepEqual(await rows(), [{
      tx_id: id, kind: "claim_refund", state: "submitted", digest: null, failure_code: null, presale_id: halcyon,
      coin_type: null, amount: null, quote_type: USDC, quote_amount: "250000000", usd_value: "250.00",
      idempotency_key: `claim_refund:${id}`, settled: false,
    }]);
    assert.equal((await log()).transactions[0]?.state, "submitted", "listed at once (This session: Pending)");

    // A repeat of the record is the same attempt: nothing is built or dry-run again.
    const again = await answer(await claim(id, body, { authorization: KAI }), 200);
    assert.equal(again.transaction_kind_bytes, null);
    assert.equal(chain.calls.simulate, 1);

    // The signed claim's digest: recorded, not visible yet (202), then confirmed once the fullnode shows Kai's claim.
    const waiting = await answer(await claim(id, { ...body, digest: DIGEST }, { authorization: KAI }), 202);
    assert.deepEqual([waiting.state, waiting.digest], ["submitted", DIGEST]);
    const presale = chain.presales.get(halcyon)!;
    chain.executions.set(DIGEST, executedClaim({
      sender: KAI_WALLET,
      claims: claimedEvents([claimedEventEntry(identity, presale, { presaleId: halcyon, participant: KAI_WALLET })], identity),
      timestampMs: NOW + 2_000,
    }));
    const confirmed = await answer(await claim(id, { ...body, digest: DIGEST }, { authorization: KAI }), 200);
    // Settled at the chain's time, never before the row was created (this fixture's chain clock is a day behind).
    assert.deepEqual([confirmed.state, confirmed.digest, confirmed.settled_at_ms], ["confirmed", DIGEST, Math.max(NOW + 2_000, confirmed.created_at_ms)]);
    const lookups = chain.calls.executed;
    await answer(await claim(id, { ...body, digest: DIGEST }, { authorization: KAI }), 200);
    assert.equal(chain.calls.executed, lookups, "a settled claim reads the fullnode no more");
    const listed = (await log()).transactions[0]!;
    assert.deepEqual([listed.kind, listed.state, listed.digest, listed.explorer_url], ["claim_refund", "confirmed", DIGEST, `https://suiscan.xyz/mainnet/tx/${DIGEST}`]);
    // A recorded digest is never replaced, and no other attempt may take it.
    await refused(await claim(id, { ...body, digest: OTHER_DIGEST }, { authorization: KAI }), 409, "claim_conflict");
    const second = randomUUID();
    await answer(await claim(second, body, { authorization: KAI }), 201);
    await refused(await claim(second, { ...body, digest: DIGEST }, { authorization: KAI }), 409, "claim_conflict");
  });
});

test("R3-63-AC-2: a launched sale's tokens: the row names the coin, the wallet session is sponsored, a Claimed event of that sale settles it", { skip }, async () => {
  await withFixture(async ({ claim, chain, story, rows }) => {
    const kestrel = story.presaleIds.KSTL!;
    const id = randomUUID();
    const body = { presale_id: kestrel, kind: "claim_tokens" };
    const recorded = await answer(await claim(id, body, SESSION), 201);
    assert.equal(recorded.fee, "sponsored", "a wallet session is sponsored like an embedded wallet (owner ruling 2026-11-20, reversing OA-17)");
    const [row] = await rows();
    assert.deepEqual(
      [row!.kind, row!.coin_type, row!.amount, row!.quote_type, row!.quote_amount, row!.usd_value],
      ["claim_tokens", normalizeStructTag(story.saleTokens.KSTL!), null, null, null, null],
      "tokens and the remainder are the chain's to count at claim time",
    );
    const presale = chain.presales.get(kestrel)!;
    chain.executions.set(DIGEST, executedClaim({
      sender: KAI_WALLET,
      claims: claimedEvents([claimedEventEntry(identity, presale, { presaleId: kestrel, participant: KAI_WALLET, tokens: "600000000000000", quoteRefund: "0" })], identity),
    }));
    const confirmed = await answer(await claim(id, { ...body, digest: DIGEST }, SESSION), 200);
    assert.equal(confirmed.state, "confirmed");
  });
});

test("R3-63-AC-3: failures are rows with published codes — a dry run's abort by name, an aborted or foreign transaction, a declined signature — never a raw chain string", { skip }, async () => {
  await withFixture(async ({ claim, chain, story, rows }) => {
    const halcyon = story.presaleIds.HLCN!;
    const body = { presale_id: halcyon, kind: "claim_refund" };

    // The dry run says the position was already claimed: failed before anything is signed, naming the abort.
    chain.simulation = { status: "failure", failure: { moveAbort: "ENoCommitment", reason: "ENoCommitment" } };
    const dry = randomUUID();
    const refusedByDryRun = await answer(await claim(dry, body, { authorization: KAI }), 201);
    assert.deepEqual(
      [refusedByDryRun.state, refusedByDryRun.failure_code, refusedByDryRun.move_abort, refusedByDryRun.transaction_kind_bytes],
      ["failed", "dry_run_failed", "ENoCommitment", null],
    );
    chain.simulation = { status: "success" };

    // Executed and aborted: execution_failed with the abort; sent by another wallet, or paying nobody here: mismatch.
    const presale = chain.presales.get(halcyon)!;
    const cases = [
      { digest: DIGEST, executed: executedClaim({ sender: KAI_WALLET, success: false, moveAbort: "EInvalidLifecycle" }), code: "execution_failed", abort: "EInvalidLifecycle" },
      { digest: OTHER_DIGEST, executed: executedClaim({ sender: NOVA_WALLET }), code: "mismatch", abort: null },
      {
        digest: "3dGmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nW",
        executed: executedClaim({ sender: KAI_WALLET, claims: claimedEvents([claimedEventEntry(identity, presale, { presaleId: halcyon, participant: NOVA_WALLET })], identity) }),
        code: "mismatch",
        abort: null,
      },
    ];
    for (const { digest, executed, code, abort } of cases) {
      const id = randomUUID();
      await answer(await claim(id, body, { authorization: KAI }), 201);
      chain.executions.set(digest, executed);
      const settled = await answer(await claim(id, { ...body, digest }, { authorization: KAI }), 200);
      assert.deepEqual([settled.state, settled.failure_code, settled.move_abort], ["failed", code, abort], code);
    }

    // The wallet declined: failed / rejected, once; another failure or a digest afterwards is a conflict.
    const declined = randomUUID();
    await answer(await claim(declined, body, { authorization: KAI }), 201);
    const rejected = await answer(await claim(declined, { ...body, failure: "rejected" }, { authorization: KAI }), 200);
    assert.deepEqual([rejected.state, rejected.failure_code, rejected.digest], ["failed", "rejected", null]);
    await answer(await claim(declined, { ...body, failure: "rejected" }, { authorization: KAI }), 200);
    await refused(await claim(declined, { ...body, failure: "dry_run_failed" }, { authorization: KAI }), 409, "claim_conflict");
    await refused(await claim(declined, { ...body, digest: "5dGmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nW" }, { authorization: KAI }), 409, "claim_conflict");
    // A failure for an attempt that has a digest is the chain's to settle, not the client's.
    const sent = randomUUID();
    await answer(await claim(sent, body, { authorization: KAI }), 201);
    await answer(await claim(sent, { ...body, digest: "6dGmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nW" }, { authorization: KAI }), 202);
    await refused(await claim(sent, { ...body, failure: "rejected" }, { authorization: KAI }), 409, "claim_conflict");

    const logged = await rows();
    assert.deepEqual(
      logged.map((row) => [row.state, row.failure_code]),
      [["failed", "dry_run_failed"], ["failed", "execution_failed"], ["failed", "mismatch"], ["failed", "mismatch"], ["failed", "rejected"], ["submitted", null]],
    );
    assert.ok(!JSON.stringify(logged).includes("MoveAbort"), "no raw chain error string is stored");
  });
});

test("R3-63-AC-4: refusals record nothing — nothing to claim, claiming off, no Blast wallet, no sign-in, malformed, another account's id, a node outage, a full bucket", { skip }, async () => {
  await withFixture(async ({ claim, chain, story, rows, deployment, limiter }) => {
    const ids = story.presaleIds;
    const refund = { presale_id: ids.HLCN!, kind: "claim_refund" };
    // Eligibility is checked first: even a deployment-node outage must not change these refusals.
    deployment.down = true;
    for (const body of [
      { presale_id: ids.HLCN!, kind: "claim_tokens" }, // a cancelled sale refunds; it pays no tokens
      { presale_id: ids.KSTL!, kind: "claim_refund" }, // a launched sale pays tokens
      { presale_id: ids.CBLT!, kind: "claim_tokens" }, // funded, not migrated: claims are not open
      { presale_id: ids.LUMN!, kind: "claim_tokens" }, // already claimed on chain
      { presale_id: `0x${"ab".repeat(32)}`, kind: "claim_refund" }, // no such sale
    ]) {
      await refused(await claim(randomUUID(), body, { authorization: KAI }), 409, "nothing_to_claim");
    }
    // Luca never backed Halcyon.
    await refused(await claim(randomUUID(), refund, { authorization: LUCA }), 409, "nothing_to_claim");
    assert.equal(deployment.calls, 0, "ineligible claims never attempt a deployment lookup");
    deployment.down = false;
    // chain_read_v1 names a sale the manifest's package does not hold.
    chain.presales.delete(ids.HLCN!);
    await refused(await claim(randomUUID(), refund, { authorization: KAI }), 409, "nothing_to_claim");
    chain.presales.set(ids.HLCN!, { objectId: ids.HLCN!, initialSharedVersion: "4242", saleToken: normalizeStructTag(story.saleTokens.HLCN!), quote: USDC });
    // No mainnet deployment manifest: claiming is off, as committing is.
    deployment.on = false;
    await refused(await claim(randomUUID(), refund, { authorization: KAI }), 409, "claim_unavailable");
    deployment.on = true;
    // The node is down while recording: 503, and nothing was attempted.
    chain.down = true;
    const outage = await claim(randomUUID(), refund, { authorization: KAI });
    await refused(outage, 503, "service_unavailable");
    assert.ok(outage.headers.get("retry-after"));
    chain.down = false;
    await refused(await claim(randomUUID(), refund, { authorization: NOVA }), 409, "blast_wallet_missing");
    await refused(await claim(randomUUID(), refund), 401, "unauthorized");
    await refused(await claim(randomUUID(), refund, { authorization: STRANGER }), 409, "account_required");
    await refused(await claim("not-a-uuid", refund, { authorization: KAI }), 400, "invalid_parameter");
    for (const body of [
      { ...refund, kind: "claim_vesting" },
      { ...refund, presale_id: "0xAB" },
      { ...refund, digest: "not-a-digest" },
      { ...refund, failure: "expired" },
      { ...refund, digest: DIGEST, failure: "rejected" },
      { ...refund, extra: true },
      "not json",
    ]) {
      await refused(await claim(randomUUID(), body, { authorization: KAI }), 400, "invalid_request");
    }
    // A digest or a failure for an attempt never recorded.
    await refused(await claim(randomUUID(), { ...refund, digest: DIGEST }, { authorization: KAI }), 404, "not_found");
    await refused(await claim(randomUUID(), { ...refund, failure: "rejected" }, { authorization: KAI }), 404, "not_found");
    assert.deepEqual(await rows(), [], "no refusal logged anything");

    // One recorded attempt: another account cannot read it, and it cannot change sale or kind.
    const id = randomUUID();
    await answer(await claim(id, refund, { authorization: KAI }), 201);
    await refused(await claim(id, refund, { authorization: LUCA }), 404, "not_found");
    await refused(await claim(id, { presale_id: ids.KSTL!, kind: "claim_tokens" }, { authorization: KAI }), 409, "claim_conflict");

    // A full `social_claim` bucket: 429 with Retry-After.
    for (let n = 0; n < 60; n += 1) await limiter.consume("social_claim", { accountId: "did:privy:presale-story-kai" });
    const limited = await claim(randomUUID(), refund, { authorization: KAI });
    await refused(limited, 429, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });
});

test("R3-63 end to end: the browser's flow through the real route — sponsored claims from an embedded wallet and a wallet session confirm, a declined one is a failed row of the log", { skip }, async () => {
  await withFixture(async ({ fetch, story, log, admin }) => {
    const halcyon = story.presaleIds.HLCN!;
    const kestrel = story.presaleIds.KSTL!;
    const target = (kind: "claim_refund" | "claim_tokens", presaleId: string) => ({
      key: `${kind}:${presaleId}`,
      kind,
      presaleId,
      done: { title: "done", sub: "done" },
    });
    const flow = (signer: ClaimSigner, accessToken: string | null) => ({
      api: { getAccessToken: async () => accessToken, fetch },
      signer: async () => signer,
      sleep: async () => undefined,
    });
    const kaiToken = KAI.slice("Bearer ".length);

    // A Privy embedded wallet: the sponsor's real policy takes the route's kind, Blast pays, Sui shows it, the log confirms it.
    const runner = createClaimRunner((claimTarget, signal) => {
      assert.ok(!isLaunchClaimTarget(claimTarget) && !isCreatorCapsClaimTarget(claimTarget), "this runner claims a sale");
      return runClaim(flow(sponsoredSigner(KAI_WALLET), kaiToken), claimTarget, signal);
    });
    const answered = new Promise<void>((resolve) => runner.onSettled(() => resolve()));
    runner.run(target("claim_refund", halcyon));
    assert.deepEqual(runner.view(`claim_refund:${halcyon}`), { state: "claiming" }, "Claiming while it runs");
    await answered;
    const view = runner.view(`claim_refund:${halcyon}`);
    assert.equal(view.state, "done", JSON.stringify(view));

    // A wallet session (Slush): sponsored too (owner ruling 2026-11-20, reversing OA-17); it signs exactly the sponsor's bytes.
    const wallet = await runClaim(flow(sponsoredWalletSigner(walletSigner(KAI_WALLET)), null), target("claim_tokens", kestrel), new AbortController().signal);
    assert.equal(wallet.status, "confirmed", JSON.stringify(wallet));

    // Declined in the wallet: a failed `rejected` row, listed, never hidden.
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claim_digest = NULL WHERE presale_id = $1 AND wallet = $2", [halcyon, KAI_WALLET]);
    const declined = await runClaim(
      flow(sponsoredSigner(KAI_WALLET, { error: new Error("User rejected the request") }), kaiToken),
      target("claim_refund", halcyon),
      new AbortController().signal,
    );
    assert.deepEqual(declined, { status: "failed", code: "rejected" });

    const page = await log();
    assert.deepEqual(
      page.transactions.map((row) => [row.kind, row.state, row.failure_code, row.digest === null ? null : "digest"]).reverse(),
      [["claim_refund", "confirmed", null, "digest"], ["claim_tokens", "confirmed", null, "digest"], ["claim_refund", "failed", "rejected", null]],
    );
    // Every confirmed row links to its own digest on the account's explorer.
    for (const row of page.transactions.filter((tx) => tx.state === "confirmed")) assert.equal(row.explorer_url, `https://suiscan.xyz/mainnet/tx/${row.digest}`);
  });
});

test("P-13: a vested share is claimed end to end — the schedule is read from chain_read_v1 and the chain, the sponsor's pinned policy takes it, its event settles it", { skip }, async () => {
  await withFixture(async ({ admin, chain, claim, fetch, rows, story }) => {
    const kestrel = story.presaleIds.KSTL!;
    const schedule = normalizeSuiAddress(`0x${"7e5c".padStart(64, "0")}`);
    const other = normalizeSuiAddress(`0x${"7e5d".padStart(64, "0")}`);
    const coinType = normalizeStructTag(story.saleTokens.KSTL!);
    const day = 86_400_000;
    const now = Date.now();
    // Kai's schedule: half vested, nothing claimed; another of his still in its cliff; one paying Luca.
    await admin.query(
      `INSERT INTO blast_infra_fixture.vesting_schedules (schedule_id, presale_id, beneficiary, total, claimed, start_ms, cliff_ms, end_ms) VALUES
         ($1, $3, $4, 1000000000, 0, $6, 0, $8), ($2, $3, $4, 1000000000, 0, $6, $9, $8), ($7, $3, $5, 1000000000, 0, $6, 0, $8)`,
      [schedule, other, kestrel, KAI_WALLET, normalizeSuiAddress(PRESALE_STORY_WALLETS.luca), now - 30 * day, normalizeSuiAddress(`0x${"7e5e".padStart(64, "0")}`), now + 30 * day, 60 * day],
    );
    // Another of Kai's, half way through one 60-day step: a straight line says half, the contract pays nothing yet.
    const stepped = normalizeSuiAddress(`0x${"7e5f".padStart(64, "0")}`);
    await admin.query(
      `INSERT INTO blast_infra_fixture.vesting_schedules (schedule_id, presale_id, beneficiary, total, claimed, start_ms, cliff_ms, end_ms, period_ms, periods)
       VALUES ($1, $2, $3, 1000000000, 0, $4, 0, $5, $6, 1)`,
      [stepped, kestrel, KAI_WALLET, now - 30 * day, now + 30 * day, 60 * day],
    );
    for (const id of [schedule, stepped]) chain.vestings.set(id, { objectId: id, initialSharedVersion: "77", coinType, beneficiary: KAI_WALLET });
    const body = { presale_id: kestrel, kind: "claim_vesting", schedule_id: schedule };
    // The published request schema: a schedule exactly for a vesting claim.
    assert.deepEqual(validator.validate("claim-request", body).errors, []);
    assert.notDeepEqual(validator.validate("claim-request", { presale_id: kestrel, kind: "claim_vesting" }).errors, []);
    assert.notDeepEqual(validator.validate("claim-request", { presale_id: kestrel, kind: "claim_refund", schedule_id: schedule }).errors, []);

    // Refused, recording nothing: no schedule, a schedule with another kind, one in its cliff, one between steps, one paying Luca, another sale.
    await refused(await claim(randomUUID(), { presale_id: kestrel, kind: "claim_vesting" }, { authorization: KAI }), 400, "invalid_request");
    await refused(await claim(randomUUID(), { presale_id: kestrel, kind: "claim_tokens", schedule_id: schedule }, { authorization: KAI }), 400, "invalid_request");
    await refused(await claim(randomUUID(), { ...body, schedule_id: other }, { authorization: KAI }), 409, "nothing_to_claim");
    await refused(await claim(randomUUID(), { ...body, schedule_id: stepped }, { authorization: KAI }), 409, "nothing_to_claim");
    await refused(await claim(randomUUID(), { ...body, schedule_id: normalizeSuiAddress(`0x${"7e5e".padStart(64, "0")}`) }, { authorization: KAI }), 409, "nothing_to_claim");
    await refused(await claim(randomUUID(), { ...body, presale_id: story.presaleIds.HLCN! }, { authorization: KAI }), 409, "nothing_to_claim");
    assert.deepEqual(await rows(), []);

    // The browser's flow: the route builds the pinned claim, the sponsor's real policy takes it from Kai, the event settles it.
    const flow = {
      api: { getAccessToken: async () => KAI.slice("Bearer ".length), fetch },
      signer: async () => sponsoredSigner(KAI_WALLET),
      sleep: async () => undefined,
    };
    const target = { key: `vesting:${schedule}`, kind: "claim_vesting", presaleId: kestrel, scheduleId: schedule, done: { title: "x", sub: "y" } } as const;
    const outcome = await runClaim(flow, target, new AbortController().signal);
    assert.equal(outcome.status, "confirmed", JSON.stringify(outcome));
    const [row] = await rows();
    assert.deepEqual([row!.kind, row!.state, row!.presale_id, row!.coin_type], ["claim_vesting", "confirmed", kestrel, coinType]);
    assert.equal(chain.simulated.length, 1);
    const call = bcs.TransactionKind.parse(chain.simulated[0]!.kind).ProgrammableTransaction!.commands[0]!.MoveCall!;
    assert.deepEqual([normalizeSuiAddress(call.package), call.module, call.function], [VESTING_PACKAGE, "blast_fun_linear_vesting", "claim"]);

    // A schedule the chain does not hold as Kai's is nothing to claim, even when the view says so.
    chain.vestings.set(schedule, { objectId: schedule, initialSharedVersion: "77", coinType, beneficiary: normalizeSuiAddress(PRESALE_STORY_WALLETS.luca) });
    await refused(await claim(randomUUID(), body, { authorization: KAI }), 409, "nothing_to_claim");
  });
});

test("P-13: a vesting attempt stays bound to its recorded schedule across replay and settlement; legacy unbound attempts refuse replay", { skip }, async () => {
  await withFixture(async ({ admin, chain, claim, rows, story }) => {
    const schedules = [normalizeSuiAddress("0x7e61"), normalizeSuiAddress("0x7e62")];
    const presaleId = story.presaleIds.KSTL!;
    const coinType = normalizeStructTag(story.saleTokens.KSTL!);
    const now = Date.now();
    await admin.query(
      `INSERT INTO blast_infra_fixture.vesting_schedules (schedule_id, presale_id, beneficiary, total, claimed, start_ms, cliff_ms, end_ms) VALUES
         ($1, $3, $4, 1000000000, 0, $5, 0, $6), ($2, $3, $4, 1000000000, 0, $5, 0, $6)`,
      [...schedules, presaleId, KAI_WALLET, now - 86_400_000, now + 86_400_000],
    );
    for (const schedule of schedules) chain.vestings.set(schedule, { objectId: schedule, initialSharedVersion: "77", coinType, beneficiary: KAI_WALLET });
    const id = randomUUID();
    const body = { presale_id: presaleId, kind: "claim_vesting", schedule_id: schedules[0]! };
    const changed = { ...body, schedule_id: schedules[1]! };
    const auth = { authorization: KAI };
    await answer(await claim(id, body, auth), 201);

    // A request id cannot select another payable schedule, including on either completion path.
    await refused(await claim(id, changed, auth), 409, "claim_conflict");
    await refused(await claim(id, { ...changed, digest: DIGEST }, auth), 409, "claim_conflict");
    await refused(await claim(id, { ...changed, failure: "rejected" }, auth), 409, "claim_conflict");
    const [recorded] = await rows();
    assert.deepEqual([recorded!.state, recorded!.digest, recorded!.idempotency_key], ["submitted", null, `claim_vesting:${id}:${schedules[0]}`]);
    await answer(await claim(id, body, auth), 200);
    assert.equal(chain.calls.simulate, 1, "the same schedule replay builds nothing again");
    await refused(await claim(id, body, { authorization: LUCA }), 404, "not_found");

    // An unavailable fullnode leaves the bound digest recoverable, and its matching event settles it.
    await answer(await claim(id, { ...body, digest: DIGEST }, auth), 202);
    chain.executions.set(DIGEST, executedClaim({ sender: KAI_WALLET, vestingClaims: [{ vestingId: schedules[0]!, beneficiary: KAI_WALLET }] }));
    assert.equal((await answer(await claim(id, { ...body, digest: DIGEST }, auth), 200)).state, "confirmed");
    await refused(await claim(id, { ...body, digest: OTHER_DIGEST }, auth), 409, "claim_conflict");
    await refused(await claim(id, changed, auth), 409, "claim_conflict");

    // Old rows have no schedule evidence: neither a settled nor an open row can infer it from a new request.
    const legacyConfirmedId = randomUUID();
    const legacyId = randomUUID();
    await admin.query(
      `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, coin_type, idempotency_key, created_at_ms, settled_at_ms)
       SELECT l.tx_id, t.account_id, t.kind, l.state, l.digest, t.presale_id, t.coin_type, 'claim_vesting:' || l.tx_id::text, t.created_at_ms,
         CASE WHEN l.state = 'submitted' THEN NULL ELSE t.settled_at_ms END
       FROM social_transactions t
       CROSS JOIN (VALUES ($2::uuid, 'confirmed', $4::text), ($3::uuid, 'submitted', NULL)) l(tx_id, state, digest)
       WHERE t.tx_id = $1`,
      [id, legacyConfirmedId, legacyId, OTHER_DIGEST],
    );
    await refused(await claim(legacyConfirmedId, body, auth), 409, "claim_conflict");
    await refused(await claim(legacyId, { ...body, digest: OTHER_DIGEST }, auth), 409, "claim_conflict");
    const legacy = (await rows()).find((row) => row.tx_id === legacyId)!;
    assert.deepEqual([legacy.state, legacy.digest], ["submitted", null]);
  });
});

test("creator actions log their immutable vault without a participant position and settle only matching events", { skip }, async () => {
  await withFixture(async ({ admin, story, chain, claim, rows, log }) => {
    const presaleId = story.presaleIds.KSTL!;
    const vaultId = `0x${"9a".repeat(32)}`;
    await admin.query("DELETE FROM blast_infra_fixture.presale_positions WHERE presale_id=$1", [presaleId]);
    Object.assign(chain, {
      creator: async (vault: string, sender: string) => {
        if (vault !== vaultId || sender !== KAI_WALLET) {
          return null;
        }
        const transaction = new Transaction();
        return {
          presaleId,
          transaction,
          kindBytes: await transaction.build({ onlyTransactionKind: true }),
        } as CreatorTransaction;
      },
    });
    for (const [index, kind] of (["collect_fees", "claim_residuals"] as const).entries()) {
      const requestId = randomUUID();
      const body = { presale_id: presaleId, vault_id: vaultId, kind };
      assert.deepEqual(validator.validate("claim-request", body).errors, []);
      assert.deepEqual(validator.validate("claim-request", { ...body, failure: "rejected" }).errors, []);
      for (const invalid of [
        { presale_id: presaleId, kind },
        { ...body, vault_id: "not-a-vault" },
        { ...body, vault_id: null },
        { ...body, schedule_id: vaultId },
        { ...body, digest: DIGEST, failure: "rejected" },
      ]) {
        assert.notDeepEqual(validator.validate("claim-request", invalid).errors, []);
        await refused(await claim(randomUUID(), invalid, { authorization: KAI }), 400, "invalid_request");
      }
      const record = await answer(await claim(requestId, body, { authorization: KAI }), 201);
      assert.equal(record.state, "submitted");
      assert.deepEqual(validator.validate("transactions-page", await log()).errors, []);
      await refused(
        await claim(requestId, { ...body, vault_id: `0x${"9b".repeat(32)}` }, { authorization: KAI }),
        409,
        "claim_conflict",
      );
      const digest = index === 0 ? DIGEST : OTHER_DIGEST;
      chain.executions.set(digest, {
        ...executedClaim({ sender: KAI_WALLET, timestampMs: Date.now() }),
        creatorEvents: [
          { kind, vaultId },
        ],
      });
      const settlement = { ...body, digest };
      assert.deepEqual(validator.validate("claim-request", settlement).errors, []);
      const settled = await answer(await claim(requestId, settlement, { authorization: KAI }), 200);
      assert.equal(settled.state, "confirmed");
      const page = await log();
      assert.deepEqual(validator.validate("transactions-page", page).errors, []);
      assert.ok(
        page.transactions.some(
          (row) => row.tx_id === requestId && row.kind === kind && row.state === "confirmed",
        ),
      );
      await refused(await claim(randomUUID(), body, { authorization: LUCA }), 409, "nothing_to_claim");
    }
    for (const kind of ["claim_refund", "claim_tokens", "claim_vesting"]) {
      const body = {
        presale_id: presaleId,
        kind,
        vault_id: vaultId,
        ...(kind === "claim_vesting" ? { schedule_id: vaultId } : {}),
      };
      assert.notDeepEqual(validator.validate("claim-request", body).errors, []);
      await refused(await claim(randomUUID(), body, { authorization: KAI }), 400, "invalid_request");
    }
    const logged = await rows();
    assert.equal(logged.length, 2);
    assert.ok(logged.every((row) => String(row.idempotency_key).endsWith(`:${vaultId}`)));
  });
});
