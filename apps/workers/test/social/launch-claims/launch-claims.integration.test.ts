import { testClient } from "../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { launchpadEventBcs } from "@interest-protocol/blast-sdk/launchpad";
import { vaultEventBcs } from "@interest-protocol/blast-sdk/vault";
import { bcs } from "@mysten/sui/bcs";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { launchClaimEvents } from "@blast/core/modules/social/claims/launch-events.ts";
import { launchClaimStep } from "#workers/modules/social/claims/launch.ts";
import type { LaunchClaim } from "@blast/core/modules/social/contracts/launch-claims.ts";
import type { SocialTransactionsPage } from "@blast/core/modules/social/contracts/transactions.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { urlAs } from "../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { PRESALE_STORY_ACCOUNTS, PRESALE_STORY_WALLETS, seedPresaleStory } from "../../../../../packages/core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialTransactionsRoute } from "@blast/server/modules/social/transactions/route.ts";
import type { ExecutedLaunchClaim, LaunchClaimChain, LaunchClaimSimulation } from "@blast/server/modules/social/launch-claims/chain.ts";
import { createLaunchClaimRoutes, type LaunchClaimSponsorRequest } from "@blast/server/modules/social/launch-claims/route.ts";

/**
 * LP-12 over the real route: `PUT /api/social/me/launch-claims/{request_id}` on the social route
 * kit, as `blast_web` on a disposable primary with migration 0136, and the social worker's step
 * as `blast_watcher` over the fixture `chain_read_v1.transaction_evidence`. The chain is a stub
 * (what the Blast wallet may claim, the dry run, executed transactions by digest), the sponsor
 * answers a reservation, blast-infra names the vault. Nothing is signed and nothing reaches a
 * network.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "launch-claims-app";
const PEPPER = "launch-claims-fixture-pepper-0123456789abcdef0123";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.UTC(2026, 9, 23, 12);
const PRIVATE = "private, no-store";
const KAI_WALLET = normalizeSuiAddress(PRESALE_STORY_WALLETS.kai);
/** Embedded wallets by DID: Kai's holds the launch's cap; Luca's holds none. */
const EMBEDDED: Readonly<Record<string, string>> = {
  "did:privy:presale-story-kai": KAI_WALLET,
  "did:privy:presale-story-luca": normalizeSuiAddress(PRESALE_STORY_WALLETS.luca),
};
const WALLET_COOKIE_TOKEN = "c".repeat(43);
const LAUNCH = normalizeSuiAddress(`0x${"1a".repeat(32)}`);
const OTHER_LAUNCH = normalizeSuiAddress(`0x${"1b".repeat(32)}`);
const VAULT = normalizeSuiAddress(`0x${"2b".repeat(32)}`);
const MEME = `0x${"3c".repeat(32)}::froggy::FROGGY`;
const QUOTE = `0x${"0".repeat(63)}2::sui::SUI`;
const LAUNCHPAD = normalizeSuiAddress(`0x${"aa".repeat(32)}`);
const MIGRATORS = normalizeSuiAddress(`0x${"bb".repeat(32)}`);
const PACKAGES = { launchpad: LAUNCHPAD, vault: MIGRATORS };
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OTHER_DIGEST = "9GmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nWx";

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
const SESSION = { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${WALLET_COOKIE_TOKEN}`, "sec-fetch-site": "same-origin" };

const kindTransaction = new Transaction();
kindTransaction.moveCall({ target: "0x2::coin::zero", typeArguments: ["0x2::sui::SUI"] });
const KIND = await kindTransaction.build({ onlyTransactionKind: true });

const curveEvent = (launchId = LAUNCH) => ({
  eventType: `${LAUNCHPAD}::events::CreatorFeesClaimed<0x3::coin::COIN,0x2::sui::SUI>`,
  bcs: launchpadEventBcs.CreatorFeesClaimed.serialize({ launch_id: launchId, meme_amount: 5n, quote_amount: 7n }).toBytes(),
});
const vaultEvent = (vaultId = VAULT) => ({
  eventType: `${MIGRATORS}::blast_vault_events::OwnerBalancesClaimed<0x3::coin::COIN,0x2::sui::SUI>`,
  bcs: vaultEventBcs.OwnerBalancesClaimed.serialize({ vault_id: vaultId, meme_amount: 5n, quote_amount: 7n }).toBytes(),
});

/** The chain as the route reads it: Kai's wallet holds `LAUNCH`'s cap; every claim of it simulates as `simulation`. */
function stubChain() {
  const calls = { target: 0, simulate: 0, executed: 0 };
  const seen: { vaultId: string | null; participant: string }[] = [];
  const executions = new Map<string, ExecutedLaunchClaim>();
  const state: { simulation: LaunchClaimSimulation } = { simulation: { status: "success" } };
  const chain: LaunchClaimChain = {
    packages: PACKAGES,
    async target(input) {
      calls.target += 1;
      seen.push({ vaultId: input.vaultId, participant: input.participant });
      if (input.launchId !== LAUNCH || normalizeSuiAddress(input.participant) !== KAI_WALLET) return null;
      if (input.kind === "claim_launch_lp_fees" && input.vaultId !== VAULT) return null;
      return { kindBytes: KIND, memeType: MEME, quoteType: QUOTE };
    },
    async simulate() {
      calls.simulate += 1;
      return state.simulation;
    },
    async executed(digest) {
      calls.executed += 1;
      return executions.get(digest) ?? null;
    },
  };
  return { chain, calls, seen, executions, state };
}

type Fixture = Readonly<{
  admin: Pool;
  watcher: Pool;
  stub: ReturnType<typeof stubChain>;
  sponsored: LaunchClaimSponsorRequest[];
  sponsor: { refuse: boolean };
  released: { on: boolean };
  claim(id: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  log(headers?: Record<string, string>): Promise<SocialTransactionsPage>;
  rows(): Promise<Record<string, unknown>[]>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await seedPresaleStory(admin, { nowMs: NOW, crowd: 2 });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "launch-claims-web");
  const watcher = createRuntimePool(urlAs(url, "blast_watcher"), { ...POOL, max: 1 }, "launch-claims-worker");
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => web),
      walletSessions: { live: async (cookie) => (cookie === WALLET_COOKIE_TOKEN ? { address: KAI_WALLET } : null) },
      primary: () => web,
    });
    const stub = stubChain();
    const sponsored: LaunchClaimSponsorRequest[] = [];
    const sponsor = { refuse: false };
    const released = { on: true };
    const primary = autocommitReader(web, "social");
    const routes = createLaunchClaimRoutes({
      kit,
      database: () => primary,
      chain: async () => (released.on ? stub.chain : null),
      blastWallet: async (caller) => (caller.kind === "privy" ? (EMBEDDED[caller.did] ?? null) : caller.address),
      async sponsor(request) {
        if (sponsor.refuse) throw new PresaleRouteError("budget_exceeded", { extra: { reason: "daily_limit" } });
        sponsored.push(request);
        return { reservation_id: "res-1", transaction_bytes: toBase64(KIND), sponsor_signature: "", expires_at_ms: NOW + 60_000, gas_budget: "5000000" };
      },
      vaultOf: async (launchId) => (launchId === LAUNCH ? VAULT : null),
    });
    const transactions = createSocialTransactionsRoute({ kit, database: () => primary });
    const base = { "x-forwarded-for": "203.0.113.12" };
    await run({
      admin,
      watcher,
      stub,
      sponsored,
      sponsor,
      released,
      claim: (id, body, headers = {}) =>
        routes.claim(new Request(`${ORIGIN}/api/social/me/launch-claims/${id}`, {
          method: "PUT",
          headers: { ...base, origin: ORIGIN, "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }), testClient()),
      log: async (headers = { authorization: KAI }) => {
        const response = await transactions.GET(new Request(`${ORIGIN}/api/social/me/transactions`, { headers: { ...base, ...headers } }), testClient());
        assert.equal(response.status, 200);
        const page = (await response.json()) as SocialTransactionsPage;
        assert.deepEqual(validator.validate("transactions-page", page).errors, []);
        return page;
      },
      rows: async () =>
        (await admin.query(
          `SELECT tx_id::text, kind, state, digest, failure_code, presale_id, coin_type, quote_type, idempotency_key, settled_at_ms IS NOT NULL AS settled
           FROM social_transactions ORDER BY created_at_ms, tx_id`,
        )).rows,
    });
  } finally {
    await Promise.all([admin.end(), web.end(), watcher.end()]);
    await database.drop();
  }
}

async function answer(response: Response, status: number): Promise<LaunchClaim> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate("launch-claim-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as LaunchClaim;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
}

/** Full TransactionData for `kind` from `sender`, as a wallet signs it. */
const signedBytes = (kind: Uint8Array, sender: string): Uint8Array =>
  bcs.TransactionData.serialize({
    V1: {
      kind: bcs.TransactionKind.parse(kind),
      sender: normalizeSuiAddress(sender),
      gasData: { payment: [], owner: normalizeSuiAddress(sender), price: 1_000n, budget: 5_000_000n },
      expiration: { None: true },
    },
  }).toBytes();
const STRANGER = `0x${"77".repeat(32)}`;

const executed = (over: Partial<ExecutedLaunchClaim> = {}): ExecutedLaunchClaim => ({
  success: true,
  sender: KAI_WALLET,
  failure: null,
  claims: launchClaimEvents([curveEvent()], PACKAGES),
  timestampMs: NOW + 2_000,
  ...over,
});

test("LP-12: a sponsored curve claim is logged before anything is signed, with the sponsorship; its digest settles from the fullnode", { skip }, async () => {
  await withFixture(async ({ claim, stub, sponsored, rows, log }) => {
    const id = randomUUID();
    const body = { launch_id: LAUNCH, kind: "claim_launch_fees" };
    assert.deepEqual(validator.validate("launch-claim-request", body).errors, []);
    const recorded = await answer(await claim(id, body, { authorization: KAI }), 201);
    assert.deepEqual([recorded.state, recorded.fee, recorded.transaction_kind_bytes, recorded.sponsored?.reservation_id], ["submitted", "sponsored", toBase64(KIND), "res-1"]);
    // The sponsor got the server's own kind, for Kai's embedded wallet, after the dry run.
    assert.deepEqual(sponsored.map((request) => [request.sender, toBase64(request.kindBytes)]), [[KAI_WALLET, toBase64(KIND)]]);
    assert.deepEqual(stub.seen, [{ vaultId: null, participant: KAI_WALLET }]);
    assert.deepEqual(await rows(), [{
      tx_id: id, kind: "claim_launch_fees", state: "submitted", digest: null, failure_code: null, presale_id: null,
      coin_type: MEME, quote_type: QUOTE, idempotency_key: `claim_launch_fees:${id}:${LAUNCH}`, settled: false,
    }]);
    assert.equal((await log()).transactions[0]?.kind, "claim_launch_fees", "listed at once (This session: Pending)");

    // A repeat is the same attempt: nothing is built, dry-run or sponsored again, and nothing to sign is answered.
    const again = await answer(await claim(id, body, { authorization: KAI }), 200);
    assert.deepEqual([again.transaction_kind_bytes, again.sponsored, stub.calls.simulate, sponsored.length], [null, null, 1, 1]);

    // A digest is unique across accounts: one the wallet did not sign reserves nothing (another's deposit mint, say).
    stub.executions.set(OTHER_DIGEST, executed({ sender: STRANGER }));
    await refused(await claim(id, { ...body, digest: OTHER_DIGEST }, { authorization: KAI }), 400, "invalid_request");
    const strangers = signedBytes(KIND, STRANGER);
    await refused(await claim(id, { ...body, digest: TransactionDataBuilder.getDigestFromBytes(strangers), transaction_bytes: toBase64(strangers) }, { authorization: KAI }), 400, "invalid_request");
    // Not yet visible and no signed bytes: nothing proves it, nothing is reserved.
    await refused(await claim(id, { ...body, digest: DIGEST }, { authorization: KAI }), 503, "service_unavailable");
    assert.equal((await rows())[0]!.digest, null);

    const mine = signedBytes(KIND, KAI_WALLET);
    const pending = TransactionDataBuilder.getDigestFromBytes(mine);
    const waiting = await answer(await claim(id, { ...body, digest: pending, transaction_bytes: toBase64(mine) }, { authorization: KAI }), 202);
    assert.deepEqual([waiting.state, waiting.digest], ["submitted", pending]);
    stub.executions.set(pending, executed());
    const confirmed = await answer(await claim(id, { ...body, digest: pending }, { authorization: KAI }), 200);
    assert.deepEqual([confirmed.state, confirmed.digest], ["confirmed", pending]);
    assert.equal((await log()).transactions[0]?.state, "confirmed");
    await refused(await claim(id, { ...body, digest: OTHER_DIGEST }, { authorization: KAI }), 409, "claim_conflict");
  });
});

test("LP-12: a vault claim binds the vault blast-infra names; only that vault's claim event, sent by the wallet, confirms it", { skip }, async () => {
  await withFixture(async ({ claim, stub, rows }) => {
    const body = { launch_id: LAUNCH, kind: "claim_launch_lp_fees" };
    const id = randomUUID();
    await answer(await claim(id, body, { authorization: KAI }), 201);
    assert.deepEqual(stub.seen.at(-1), { vaultId: VAULT, participant: KAI_WALLET });
    assert.equal((await rows())[0]!.idempotency_key, `claim_launch_lp_fees:${id}:${LAUNCH}:${VAULT}`);
    // The curve's event is not this claim.
    stub.executions.set(DIGEST, executed());
    const mismatch = await answer(await claim(id, { ...body, digest: DIGEST }, { authorization: KAI }), 200);
    assert.deepEqual([mismatch.state, mismatch.failure_code], ["failed", "mismatch"]);

    const second = randomUUID();
    await answer(await claim(second, body, { authorization: KAI }), 201);
    stub.executions.set(OTHER_DIGEST, executed({ claims: launchClaimEvents([vaultEvent()], PACKAGES) }));
    const confirmed = await answer(await claim(second, { ...body, digest: OTHER_DIGEST }, { authorization: KAI }), 200);
    assert.equal(confirmed.state, "confirmed");
  });
});

test("LP-12: nothing to claim, claiming off, another launch on a stored id, another account, a sponsor at its limit", { skip }, async () => {
  await withFixture(async ({ claim, rows, released, sponsor, sponsored }) => {
    await refused(await claim(randomUUID(), { launch_id: OTHER_LAUNCH, kind: "claim_launch_fees" }, { authorization: KAI }), 409, "nothing_to_claim");
    await refused(await claim(randomUUID(), { launch_id: OTHER_LAUNCH, kind: "claim_launch_lp_fees" }, { authorization: KAI }), 409, "nothing_to_claim");
    // The cap is Kai's: Luca's wallet claims nothing of this launch.
    await refused(await claim(randomUUID(), { launch_id: LAUNCH, kind: "claim_launch_fees" }, { authorization: LUCA }), 409, "nothing_to_claim");
    await refused(await claim(randomUUID(), { launch_id: LAUNCH, kind: "claim_launch_fees", vault_id: VAULT }, { authorization: KAI }), 400, "invalid_request");
    released.on = false;
    await refused(await claim(randomUUID(), { launch_id: LAUNCH, kind: "claim_launch_fees" }, { authorization: KAI }), 409, "claim_unavailable");
    released.on = true;

    // The sponsor at its budget: nothing is logged, so nothing waits to expire.
    sponsor.refuse = true;
    await refused(await claim(randomUUID(), { launch_id: LAUNCH, kind: "claim_launch_fees" }, { authorization: KAI }), 429, "rate_limited");
    assert.deepEqual(await rows(), []);
    sponsor.refuse = false;

    const id = randomUUID();
    await answer(await claim(id, { launch_id: LAUNCH, kind: "claim_launch_fees" }, { authorization: KAI }), 201);
    await refused(await claim(id, { launch_id: OTHER_LAUNCH, kind: "claim_launch_fees" }, { authorization: KAI }), 409, "claim_conflict");
    await refused(await claim(id, { launch_id: LAUNCH, kind: "claim_launch_lp_fees" }, { authorization: KAI }), 409, "claim_conflict");
    await refused(await claim(id, { launch_id: LAUNCH, kind: "claim_launch_fees" }, { authorization: LUCA }), 404, "not_found");
    assert.equal(sponsored.length, 1);
  });
});

test("LP-12: a wallet session is sponsored like an embedded wallet; a dry run that aborts is logged failed; a declined signature is reported", { skip }, async () => {
  await withFixture(async ({ claim, stub, sponsored }) => {
    const body = { launch_id: LAUNCH, kind: "claim_launch_fees" };
    const own = await answer(await claim(randomUUID(), body, SESSION), 201);
    assert.deepEqual([own.fee, own.sponsored?.reservation_id, own.transaction_kind_bytes], ["sponsored", "res-1", toBase64(KIND)]);
    assert.deepEqual(sponsored.map((request) => request.caller.kind), ["wallet"]);

    stub.state.simulation = { status: "failure", failure: { moveAbort: null, reason: "abort_launch" } };
    const dry = await answer(await claim(randomUUID(), body, { authorization: KAI }), 201);
    assert.deepEqual([dry.state, dry.failure_code, dry.transaction_kind_bytes, dry.sponsored], ["failed", "dry_run_failed", null, null]);
    assert.equal(sponsored.length, 1, "a claim that would abort is never sponsored");
    stub.state.simulation = { status: "success" };

    const id = randomUUID();
    await answer(await claim(id, body, { authorization: KAI }), 201);
    const declined = await answer(await claim(id, { ...body, failure: "rejected" }, { authorization: KAI }), 200);
    assert.deepEqual([declined.state, declined.failure_code], ["failed", "rejected"]);
    await refused(await claim(id, { ...body, digest: DIGEST }, { authorization: KAI }), 409, "claim_conflict");
  });
});

test("LP-12: the social worker settles a sent claim whose client never came back, from native evidence, once", { skip }, async () => {
  await withFixture(async ({ admin, watcher }) => {
    await admin.query(
      `INSERT INTO checkpoint_journal(checkpoint,network,digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash)
       VALUES(30,'mainnet','launch-claim-checkpoint-30',0,$1,0,1,''::bytea,decode(repeat('00',32),'hex'))`,
      [NOW],
    );
    const insert = async (n: number, kind: string, key: string, digest: string) =>
      admin.query(
        `INSERT INTO social_transactions(tx_id,account_id,kind,state,digest,idempotency_key,created_at_ms) VALUES($1,$2,$3,'submitted',$4,$5,$6)`,
        [`00000000-0000-4000-8000-00000000000${n}`, PRESALE_STORY_ACCOUNTS.kai, kind, digest, key, NOW - 10_000],
      );
    const evidence = (digest: string, sender: string, success: boolean, events: readonly { eventType: string; bcs: Uint8Array }[]) =>
      admin.query(
        `INSERT INTO blast_infra_fixture.transaction_evidence(digest,checkpoint,timestamp_ms,sender,success,events) VALUES($1,30,$2,$3,$4,$5::jsonb)`,
        [digest, NOW, sender, success, JSON.stringify(events.map((event) => ({ eventType: event.eventType, bcs: toBase64(event.bcs) })))],
      );
    const digests = ["1".repeat(32), "2".repeat(32), "3".repeat(32), "4".repeat(32)];
    const request = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    await insert(1, "claim_launch_fees", `claim_launch_fees:${request(1)}:${LAUNCH}`, digests[0]!);
    await evidence(digests[0]!, KAI_WALLET, true, [curveEvent()]);
    await insert(2, "claim_launch_lp_fees", `claim_launch_lp_fees:${request(2)}:${LAUNCH}:${VAULT}`, digests[1]!);
    await evidence(digests[1]!, KAI_WALLET, true, [vaultEvent(OTHER_LAUNCH)]);
    await insert(3, "claim_launch_fees", `claim_launch_fees:${request(3)}:${LAUNCH}`, digests[2]!);
    await evidence(digests[2]!, normalizeSuiAddress(`0x${"dd".repeat(32)}`), true, [curveEvent()]);
    await insert(4, "claim_launch_fees", `claim_launch_fees:${request(4)}:${LAUNCH}`, digests[3]!);
    await evidence(digests[3]!, KAI_WALLET, false, []);

    const step = launchClaimStep({ batchSize: 16, packages: PACKAGES });
    const pass = () => withTransaction(watcher, (tx) => step.run(tx.forModule("social"), { pipeline: "presale", checkpoint: 30, timestampMs: NOW }, { now: () => NOW }));
    assert.deepEqual(await pass(), { claims_confirmed: 1, claims_failed: 3 });
    const states = (await admin.query("SELECT tx_id::text, state, failure_code FROM social_transactions ORDER BY tx_id")).rows;
    assert.deepEqual(states, [
      { tx_id: request(1), state: "confirmed", failure_code: null },
      { tx_id: request(2), state: "failed", failure_code: "mismatch" },
      { tx_id: request(3), state: "failed", failure_code: "mismatch" },
      { tx_id: request(4), state: "failed", failure_code: "execution_failed" },
    ]);
    assert.deepEqual(await pass(), { claims_confirmed: 0, claims_failed: 0 }, "recovery is idempotent");
  });
});

test("0136: the log takes launch claims and the sponsor the server-built launch_claim, and the migration goes down and up again", { skip }, async () => {
  await withFixture(async ({ admin }) => {
    const MIGRATIONS = new URL("../../../../../packages/core/src/modules/database/migrations/", import.meta.url);
    const migration = (direction: "up" | "down") => readFile(new URL(`0136_launchpad_creator_claims.${direction}.sql`, MIGRATIONS), "utf8");
    const logClaim = (n: number) =>
      admin.query(
        `INSERT INTO social_transactions(tx_id,account_id,kind,state,idempotency_key,created_at_ms) VALUES($1,$2,'claim_launch_fees','submitted',$3,$4)`,
        [`00000000-0000-4000-8000-0000000001${n}0`, PRESALE_STORY_ACCOUNTS.kai, `claim_launch_fees:${n}`, NOW],
      );
    const indexed = async () => (await admin.query("SELECT 1 FROM pg_indexes WHERE indexname = 'social_transactions_open_launch_claims_idx'")).rows.length;
    assert.equal(await indexed(), 1);
    await admin.query(await migration("down"));
    assert.equal(await indexed(), 0);
    await assert.rejects(logClaim(1), /social_transactions_kind_check/);
    await admin.query(await migration("up"));
    assert.equal(await indexed(), 1);
    await logClaim(2);
  });
});

