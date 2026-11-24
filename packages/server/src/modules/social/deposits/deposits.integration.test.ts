import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { normalizeSuiAddress, toBase58 } from "@mysten/sui/utils";
import type { Pool } from "pg";


import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { CIRCLE_FORWARD_HOOK_DATA } from "@blast/server/modules/presale/bridge/activation.ts";
import { createCachedCircle, createCircleIris, type CircleIris } from "@blast/core/modules/presale/bridge/circle.ts";
import type { BridgeActivation } from "@blast/core/modules/presale/bridge/contracts.ts";
import { CIRCLE_FEES_STANDARD_ONLY, fixtureCircle } from "../../../../../core/test/fixtures/modules/presale/bridge/fixtures.ts";
import { cctpMessageFixture, fixtureAttestation } from "../../../../../core/test/fixtures/modules/presale/bridge/relayer-fixtures.ts";
import { PostgresBridgeTransfers } from "@blast/core/modules/presale/bridge/repository.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialDeposit, SocialDepositBridge } from "@blast/core/modules/social/contracts/deposits.ts";
import type { SocialTransactionsPage } from "@blast/core/modules/social/contracts/transactions.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { PRESALE_STORY_WALLETS, seedPresaleStory } from "../../../../../core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialTransactionsRoute } from "@blast/server/modules/social/transactions/route.ts";
import { createSocialDepositRoutes, DEPOSIT_NO_PRESALE_ID } from "@blast/server/modules/social/deposits/route.ts";

/**
 * OA-25 over the real route: `PUT /api/social/me/deposits/{request_id}` and
 * `GET /api/social/me/deposits` on the social route kit, as `blast_web` on a
 * disposable primary with the design's sample accounts (`seedPresaleStory`).
 * The bridge's transfer registry is the real Postgres store (the web
 * registers and reads as `blast_web`; the relayer's moves are made here as
 * `blast_watcher`, with fixture attested CCTP V2 messages). The activation
 * record is a stub; Circle is the real cached client over the fixture Iris
 * API. Nothing reaches a network and nothing is signed with a key.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-deposits-app";
const PEPPER = "social-deposits-fixture-pepper-0123456789abcdef01";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.UTC(2026, 9, 6, 17);
const PRIVATE = "private, no-store";
const USDC = PORTFOLIO_COIN_TYPES.usdc;
const KAI_WALLET = normalizeSuiAddress(PRESALE_STORY_WALLETS.kai);
const WALLET_COOKIE_TOKEN = "d".repeat(43);
const RELAYER = `0x${"7a".repeat(32)}`;
const ZERO = `0x${"0".repeat(64)}`;
const PARKED = new Date("9999-12-31T00:00:00Z");
const hash = (label: string) => `0x${createHash("sha256").update(label).digest("hex")}`;
const digest = (label: string) => toBase58(createHash("sha256").update(label).digest());
/** A 64-byte Solana signature in base58. */
const signature = (label: string) => digest(label) + digest(`${label}/2`);

function token(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signed = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signed.toString("base64url")}`;
}
const KAI = `Bearer ${token("did:privy:presale-story-kai")}`;
const LUCA = `Bearer ${token("did:privy:presale-story-luca")}`;
const NOVA = `Bearer ${token("did:privy:presale-story-nova")}`;
const STRANGER = `Bearer ${token("did:privy:nobody-here")}`;
const SESSION = { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${WALLET_COOKIE_TOKEN}`, "sec-fetch-site": "same-origin" };

const EMBEDDED: Readonly<Record<string, string | null>> = {
  "did:privy:presale-story-kai": KAI_WALLET,
  "did:privy:presale-story-luca": normalizeSuiAddress(PRESALE_STORY_WALLETS.luca),
  "did:privy:presale-story-nova": null,
};

const ON: BridgeActivation = { active: true, recordId: "1", forwarding: "blast", destinationCaller: RELAYER, hookData: null };

type Fixture = Readonly<{
  admin: Pool;
  limiter: PostgresRateLimitEnforcer;
  circle: ReturnType<typeof fixtureCircle>;
  clock: { ms: number };
  bridge: { state: BridgeActivation };
  /** The relayer's moves, as `blast_watcher`. */
  relayer: PostgresBridgeTransfers;
  deposit(id: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  available(headers?: Record<string, string>): Promise<Response>;
  log(headers?: Record<string, string>): Promise<SocialTransactionsPage>;
  /** The deposit routes as the browser's flow calls them. */
  fetch: typeof globalThis.fetch;
  rows(): Promise<Record<string, unknown>[]>;
  transfers(): Promise<Record<string, unknown>[]>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, circleOverride?: CircleIris): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  await seedPresaleStory(admin, { nowMs: NOW, crowd: 8 });
  await admin.query(
    "INSERT INTO social_accounts (account_id, privy_did, callsign, privacy, onboarded_at) VALUES ($1, 'did:privy:presale-story-nova', 'nova_x', 'public', now())",
    ["00000000-0000-4000-8000-00000000c0a7"],
  );
  const web = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-deposits-web");
  const watcher = createRuntimePool(urlAs(database.url, "blast_watcher"), POOL, "social-deposits-watcher");
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
    const circle = fixtureCircle();
    const clock = { ms: NOW };
    const bridge = { state: ON };
    const primary = autocommitReader(web, "social");
    const routes = createSocialDepositRoutes({
      kit,
      database: () => primary,
      activation: async () => bridge.state,
      circle: circleOverride ?? createCachedCircle(createCircleIris({ fetch: circle.fetch }), { now: () => clock.ms }),
      transfers: new PostgresBridgeTransfers(web),
      blastWallet: async (caller) => (caller.kind === "privy" ? (EMBEDDED[caller.did] ?? null) : caller.address),
    });
    const transactions = createSocialTransactionsRoute({ kit, database: () => primary });
    const base = { "x-forwarded-for": "203.0.113.25" };
    const deposit = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      routes.deposit(new Request(`${ORIGIN}/api/social/me/deposits/${id}`, {
        method: "PUT",
        headers: { ...base, origin: ORIGIN, "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }), testClient());
    const available = (headers: Record<string, string> = {}) =>
      routes.bridge(new Request(`${ORIGIN}/api/social/me/deposits`, { headers: { ...base, ...headers } }), testClient());
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      const headers = new Headers(init?.headers);
      headers.set("x-forwarded-for", "203.0.113.25");
      headers.set("origin", ORIGIN);
      if (!headers.has("authorization") && init?.credentials === "same-origin") {
        headers.set("cookie", SESSION.cookie);
        headers.set("sec-fetch-site", "same-origin");
      }
      if (url.pathname === "/api/social/me/deposits") return routes.bridge(new Request(url, { headers }), testClient());
      return routes.deposit(new Request(url, { method: init?.method, headers, body: init?.body ?? null }), testClient());
    }) as typeof globalThis.fetch;
    await run({
      admin,
      limiter,
      circle,
      clock,
      bridge,
      relayer: new PostgresBridgeTransfers(watcher),
      deposit,
      available,
      fetch,
      log: async (headers = { authorization: KAI }) => {
        const response = await transactions.GET(new Request(`${ORIGIN}/api/social/me/transactions`, { headers: { ...base, ...headers } }), testClient());
        assert.equal(response.status, 200);
        return (await response.json()) as SocialTransactionsPage;
      },
      rows: async () =>
        (await admin.query(
          `SELECT tx_id::text, kind, state, digest, failure_code, presale_id, coin_type, amount::text, usd_value::text, idempotency_key
           FROM social_transactions WHERE kind = 'deposit' ORDER BY created_at_ms, tx_id`,
        )).rows,
      transfers: async () =>
        (await admin.query("SELECT id, source, tx_hash, sui_address, amount::text, presale_id, privy_did, status FROM presale_bridge_transfers ORDER BY sent_at, id")).rows,
    });
  } finally {
    await Promise.all([admin.end(), web.end(), watcher.end()]);
    await database.drop();
  }
}

async function answer(response: Response, status: number): Promise<SocialDeposit> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate("deposit-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as SocialDeposit;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
}

/** The attested V2 burn message Circle would return for this deposit. */
const attested = (options: Parameters<typeof cctpMessageFixture>[0] = {}) =>
  cctpMessageFixture({ version: 1, source: "base", recipient: KAI_WALLET, amount: 500_000_000n, destinationCaller: RELAYER, ...options });

test("OA-25-AC-1: a Fast deposit from Base is logged before anything is signed, registered with the bridge once its hash comes, and confirmed from the attested mint", { skip }, async () => {
  await withFixture(async ({ deposit, available, relayer, rows, transfers, log }) => {
    const bridgeBody: unknown = await (await available({ authorization: KAI })).json();
    assert.deepEqual(validator.validate("deposit-bridge-response", bridgeBody).errors, []);
    assert.deepEqual(bridgeBody as SocialDepositBridge, { available: true });

    const id = randomUUID();
    const body = { source: "base", amount: "500000000" };
    assert.deepEqual(validator.validate("deposit-request", body).errors, []);
    const recorded = await answer(await deposit(id, body, { authorization: KAI }), 201);
    assert.deepEqual([recorded.request_id, recorded.state, recorded.digest, recorded.tx_hash, recorded.transfer], [id, "submitted", null, null, null]);
    // The burn to sign: Fast (Circle lists 1.3 bps for Base and the allowance covers it), to Kai's Blast wallet, pinned to the relayer.
    assert.deepEqual(recorded.plan, {
      speed: "fast",
      eta_seconds: 18,
      fee_bps: "1.3",
      max_fee: "81250",
      min_finality_threshold: 1000,
      destination_domain: 8,
      mint_recipient: KAI_WALLET,
      destination_caller: RELAYER,
      hook_data: null,
    });
    assert.deepEqual(await rows(), [{
      tx_id: id, kind: "deposit", state: "submitted", digest: null, failure_code: null, presale_id: null,
      coin_type: USDC, amount: "500000000", usd_value: "500.00", idempotency_key: `deposit:base:${id}`,
    }]);
    assert.equal((await log()).transactions[0]?.state, "submitted", "listed at once (This session: Pending)");
    // A repeat of the record is the same attempt, with the burn to sign again.
    const again = await answer(await deposit(id, body, { authorization: KAI }), 200);
    assert.deepEqual(again.plan, recorded.plan);
    assert.equal((await rows()).length, 1);
    assert.deepEqual(await transfers(), [], "nothing is registered before a burn exists");

    // The burn's hash: registered for the Blast wallet (no sale), in flight (202).
    const txHash = hash("base-burn-1");
    const sent = await answer(await deposit(id, { ...body, tx_hash: txHash.toUpperCase().replace("0X", "0x") }, { authorization: KAI }), 202);
    assert.deepEqual([sent.state, sent.tx_hash, sent.plan, sent.transfer?.status, sent.transfer?.minted_amount], ["submitted", txHash, null, "sent", null]);
    const [registered] = await transfers();
    assert.deepEqual(
      { ...registered, id: undefined },
      { id: undefined, source: "base", tx_hash: txHash, sui_address: KAI_WALLET, amount: "500000000", presale_id: DEPOSIT_NO_PRESALE_ID, privy_did: "did:privy:presale-story-kai", status: "sent" },
    );
    // Asked again: the same registration (never a second one).
    await answer(await deposit(id, { ...body, tx_hash: txHash }, { authorization: KAI }), 202);
    assert.equal((await transfers()).length, 1);

    // Circle attests: still in flight, and now what will land is known (less the 500-atom feeExecuted).
    const message = attested();
    await relayer.markAttested(String(registered!.id), { message, attestation: fixtureAttestation(message) });
    const attestedAnswer = await answer(await deposit(id, { ...body, tx_hash: txHash }, { authorization: KAI }), 202);
    assert.deepEqual([attestedAnswer.transfer?.status, attestedAnswer.transfer?.minted_amount], ["attested", "499999500"]);

    // The relayer minted on Sui: confirmed with the mint's digest.
    const mint = digest("sui-mint-1");
    await relayer.markMinted(String(registered!.id), { suiDigest: mint });
    const confirmed = await answer(await deposit(id, { ...body, tx_hash: txHash }, { authorization: KAI }), 200);
    assert.deepEqual([confirmed.state, confirmed.digest, confirmed.transfer?.status, confirmed.transfer?.minted_amount], ["confirmed", mint, "minted", "499999500"]);
    assert.ok(confirmed.settled_at_ms !== null && confirmed.settled_at_ms >= confirmed.created_at_ms);
    await answer(await deposit(id, { ...body, tx_hash: txHash }, { authorization: KAI }), 200);
    const listed = (await log()).transactions[0]!;
    assert.deepEqual([listed.kind, listed.state, listed.digest, listed.explorer_url], ["deposit", "confirmed", mint, `https://suiscan.xyz/mainnet/tx/${mint}`]);
    // A settled attempt never turns into a failure.
    await refused(await deposit(id, { ...body, failure: "rejected" }, { authorization: KAI }), 409, "deposit_conflict");
  });
});

test("OA-25-AC-2: Standard when Circle lists no Fast route or the allowance is short; Circle forwarding carries its hook; a wallet session deposits too", { skip }, async () => {
  await withFixture(async ({ deposit, circle, clock, bridge, rows }) => {
    // Solana, Standard only: Circle's Standard fee (0) applies; Solana's signature is the hash.
    circle.state.fees.solana = CIRCLE_FEES_STANDARD_ONLY;
    const solana = await answer(await deposit(randomUUID(), { source: "solana", amount: "25000000" }, { authorization: KAI }), 201);
    assert.deepEqual(
      [solana.plan?.speed, solana.plan?.max_fee, solana.plan?.min_finality_threshold, solana.plan?.eta_seconds],
      ["standard", "0", 2000, 35],
    );
    // The global Fast allowance (USDC) below the amount: Standard.
    circle.state.allowance = { allowance: 10, lastUpdated: "2026-10-06T12:00:00.000Z" };
    clock.ms += 60_000;
    const capped = await answer(await deposit(randomUUID(), { source: "arbitrum", amount: "500000000" }, { authorization: KAI }), 201);
    assert.equal(capped.plan?.speed, "standard");
    // Circle's forwarding: any caller (zero) and Circle's forward hook, so the burn is `depositForBurnWithHook`.
    bridge.state = { active: true, recordId: "2", forwarding: "circle", destinationCaller: ZERO, hookData: CIRCLE_FORWARD_HOOK_DATA };
    const forwarded = await answer(await deposit(randomUUID(), { source: "ethereum", amount: "100000000" }, SESSION), 201);
    assert.deepEqual([forwarded.plan?.destination_caller, forwarded.plan?.hook_data, forwarded.plan?.mint_recipient], [ZERO, CIRCLE_FORWARD_HOOK_DATA, KAI_WALLET]);
    assert.deepEqual((await rows()).map((row) => [String(row.idempotency_key).split(":")[1], row.amount, row.usd_value]), [
      ["solana", "25000000", "25.00"],
      ["arbitrum", "500000000", "500.00"],
      ["ethereum", "100000000", "100.00"],
    ]);
  });
});

test("OA-25-AC-3: failures are rows with published codes — declined, a refused burn, a burn for anything else, a burn Circle never saw — and one mint is one attempt's", { skip }, async () => {
  await withFixture(async ({ deposit, relayer, rows, transfers }) => {
    const body = { source: "base", amount: "500000000" };
    const record = async () => {
      const id = randomUUID();
      await answer(await deposit(id, body, { authorization: KAI }), 201);
      return id;
    };
    const registeredId = async (txHash: string) => String((await transfers()).find((row) => row.tx_hash === txHash)!.id);

    // The wallet declined: failed / rejected, once; another failure is a conflict.
    const declined = await record();
    const rejected = await answer(await deposit(declined, { ...body, failure: "rejected" }, { authorization: KAI }), 200);
    assert.deepEqual([rejected.state, rejected.failure_code, rejected.plan], ["failed", "rejected", null]);
    await answer(await deposit(declined, { ...body, failure: "rejected" }, { authorization: KAI }), 200);
    await refused(await deposit(declined, { ...body, failure: "dry_run_failed" }, { authorization: KAI }), 409, "deposit_conflict");

    // Attested for another recipient: mismatch, at once.
    const other = await record();
    const otherHash = hash("burn-other-recipient");
    await answer(await deposit(other, { ...body, tx_hash: otherHash }, { authorization: KAI }), 202);
    const foreign = attested({ recipient: `0x${"50".repeat(32)}` });
    await relayer.markAttested(await registeredId(otherHash), { message: foreign, attestation: fixtureAttestation(foreign) });
    assert.deepEqual((await answer(await deposit(other, { ...body, tx_hash: otherHash }, { authorization: KAI }), 200)).failure_code, "mismatch");

    // A burn the relayer refused (invalid_burn): mismatch.
    const invalid = await record();
    const invalidHash = hash("burn-invalid");
    await answer(await deposit(invalid, { ...body, tx_hash: invalidHash }, { authorization: KAI }), 202);
    await relayer.markFailed(await registeredId(invalidHash), { error: "invalid_burn" });
    assert.deepEqual((await answer(await deposit(invalid, { ...body, tx_hash: invalidHash }, { authorization: KAI }), 200)).failure_code, "mismatch");

    // Circle never attested it and the relayer parked it: expired. Reading it again never re-arms it.
    const unseen = await record();
    const unseenHash = hash("burn-unseen");
    await answer(await deposit(unseen, { ...body, tx_hash: unseenHash }, { authorization: KAI }), 202);
    const unseenId = await registeredId(unseenHash);
    await relayer.markFailed(unseenId, { error: "attestation_timeout" });
    await relayer.recordPoll(unseenId, { nextPollAt: PARKED });
    assert.deepEqual((await answer(await deposit(unseen, { ...body, tx_hash: unseenHash }, { authorization: KAI }), 200)).failure_code, "expired");
    assert.equal((await relayer.find(unseenId))?.nextPollAt.getTime(), PARKED.getTime(), "still parked");

    // Two attempts reporting the same burn: the first takes the mint, the second is a conflict.
    const first = await record();
    const second = await record();
    const sharedHash = hash("burn-shared");
    await answer(await deposit(first, { ...body, tx_hash: sharedHash }, { authorization: KAI }), 202);
    const message = attested();
    const sharedId = await registeredId(sharedHash);
    await relayer.markAttested(sharedId, { message, attestation: fixtureAttestation(message) });
    await relayer.markMinted(sharedId, { suiDigest: digest("sui-mint-shared") });
    assert.equal((await answer(await deposit(first, { ...body, tx_hash: sharedHash }, { authorization: KAI }), 200)).state, "confirmed");
    await refused(await deposit(second, { ...body, tx_hash: sharedHash }, { authorization: KAI }), 409, "deposit_conflict");

    assert.deepEqual(
      (await rows()).map((row) => [row.state, row.failure_code]),
      [["failed", "rejected"], ["failed", "mismatch"], ["failed", "mismatch"], ["failed", "expired"], ["confirmed", null], ["submitted", null]],
    );
  });
});

test("review L6: a Privy account holds at most five burns Circle has not attested; a known burn is still read, and attestation frees a slot", { skip }, async () => {
  await withFixture(async ({ deposit, relayer, transfers }) => {
    const body = { source: "base", amount: "500000000" };
    const attempts: { id: string; txHash: string }[] = [];
    for (let n = 0; n < 6; n += 1) {
      const id = randomUUID();
      await answer(await deposit(id, body, { authorization: KAI }), 201);
      attempts.push({ id, txHash: hash(`burn-open-${n}`) });
    }
    for (const attempt of attempts.slice(0, 5)) {
      await answer(await deposit(attempt.id, { ...body, tx_hash: attempt.txHash }, { authorization: KAI }), 202);
    }
    const sixth = attempts[5]!;
    await refused(await deposit(sixth.id, { ...body, tx_hash: sixth.txHash }, { authorization: KAI }), 429, "rate_limited");
    assert.equal((await transfers()).length, 5, "the sixth hash was not registered");
    // A burn already registered keeps answering.
    await answer(await deposit(attempts[0]!.id, { ...body, tx_hash: attempts[0]!.txHash }, { authorization: KAI }), 202);
    // Once Circle attests one, the sixth fits.
    const first = (await transfers()).find((row) => row.tx_hash === attempts[0]!.txHash)!;
    const message = attested();
    await relayer.markAttested(String(first.id), { message, attestation: fixtureAttestation(message) });
    await answer(await deposit(sixth.id, { ...body, tx_hash: sixth.txHash }, { authorization: KAI }), 202);
    assert.equal((await transfers()).length, 6);
  });
});

test("OA-25-AC-4: refusals record nothing — the bridge off, Circle down, no route, too small, no Blast wallet, no sign-in, malformed, another account's id, a full bucket", { skip }, async () => {
  await withFixture(async ({ deposit, available, bridge, circle, clock, rows, limiter }) => {
    const body = { source: "base", amount: "500000000" };
    // The bridge's activation record is not complete: GET says so, and nothing can be recorded.
    bridge.state = { active: false, reason: "no_record", recordId: null };
    assert.deepEqual(await (await available({ authorization: KAI })).json(), { available: false });
    await refused(await deposit(randomUUID(), body, { authorization: KAI }), 409, "deposit_unavailable");
    bridge.state = ON;
    // Circle is down: 503 with its retry, never a guessed fee.
    circle.state.mode = "error";
    const outage = await deposit(randomUUID(), body, { authorization: KAI });
    await refused(outage, 503, "service_unavailable");
    assert.ok(Number(outage.headers.get("retry-after")) > 0);
    circle.state.mode = "ok";
    clock.ms += 60_000;
    // Circle lists no Standard route from Arbitrum.
    circle.state.fees.arbitrum = [{ finalityThreshold: 1000, minimumFee: 1.3 }];
    await refused(await deposit(randomUUID(), { source: "arbitrum", amount: "500000000" }, { authorization: KAI }), 409, "deposit_unavailable");
    // One atom from Solana: every route's fee would take it all.
    await refused(await deposit(randomUUID(), { source: "solana", amount: "1" }, { authorization: KAI }), 422, "invalid_amount");
    await refused(await deposit(randomUUID(), body, { authorization: NOVA }), 409, "blast_wallet_missing");
    await refused(await deposit(randomUUID(), body), 401, "unauthorized");
    await refused(await deposit(randomUUID(), body, { authorization: STRANGER }), 409, "account_required");
    await refused(await deposit("not-a-uuid", body, { authorization: KAI }), 400, "invalid_parameter");
    for (const bad of [
      { ...body, source: "polygon" },
      { ...body, amount: "0" },
      { ...body, amount: "1.5" },
      { ...body, amount: 500 },
      { ...body, tx_hash: signature("a solana signature on base") },
      { source: "solana", amount: "1000000", tx_hash: hash("an evm hash on solana") },
      { ...body, failure: "mismatch" },
      { ...body, tx_hash: hash("x"), failure: "rejected" },
      { ...body, extra: true },
      "not json",
    ]) {
      await refused(await deposit(randomUUID(), bad, { authorization: KAI }), 400, "invalid_request");
    }
    // A hash or a failure for an attempt never recorded.
    await refused(await deposit(randomUUID(), { ...body, tx_hash: hash("y") }, { authorization: KAI }), 404, "not_found");
    await refused(await deposit(randomUUID(), { ...body, failure: "rejected" }, { authorization: KAI }), 404, "not_found");
    assert.deepEqual(await rows(), [], "no refusal logged anything");

    // One recorded attempt: another account cannot read it, and it cannot change source or amount.
    const id = randomUUID();
    await answer(await deposit(id, body, { authorization: KAI }), 201);
    await refused(await deposit(id, body, { authorization: LUCA }), 404, "not_found");
    await refused(await deposit(id, { ...body, amount: "400000000" }, { authorization: KAI }), 409, "deposit_conflict");
    await refused(await deposit(id, { ...body, source: "arbitrum" }, { authorization: KAI }), 409, "deposit_conflict");

    // A full `social_deposit` bucket: 429 with Retry-After.
    for (let n = 0; n < 120; n += 1) await limiter.consume("social_deposit", { accountId: "did:privy:presale-story-kai" });
    const limited = await deposit(randomUUID(), body, { authorization: KAI });
    await refused(limited, 429, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });
});


test("failed Circle fee request retains ownership until the allowance sibling settles", { skip }, async () => {
  let release!: (value: string) => void;
  let started!: () => void;
  const called = new Promise<void>((resolve) => { started = resolve; });
  const allowance = new Promise<string>((resolve) => { release = resolve; });
  const circle: CircleIris = {
    fees: async () => { throw new Error("fixture fee failure"); },
    fastAllowance: () => { started(); return allowance; },
  };
  await withFixture(async ({ deposit, rows }) => {
    let settled = false;
    const result = deposit(randomUUID(), { source: "base", amount: "500000000" }, { authorization: KAI }).finally(() => { settled = true; });
    try {
      await called;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false);
    } finally {
      release("0");
    }
    assert.equal((await result).status, 503);
    assert.deepEqual(await rows(), []);
  }, circle);
});
