import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialCoinsRoutes } from "@blast/server/modules/social/coins/route.ts";
import type { ExecutedTransfer } from "@blast/server/modules/social/coins/transfers.ts";
import type { SocialTransaction, SocialTransactionsPage } from "@blast/core/modules/social/contracts/transactions.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { FEED_STORY_ACCOUNTS, FEED_STORY_PRESALES, FEED_STORY_WALLETS, seedFeedStory } from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { logTransaction, TransactionLogConflict, type TransactionEntry, type TransactionProgress } from "@blast/core/modules/social/transactions/log.ts";
import { TRANSACTIONS_FIRST_PAGE_SQL, TRANSACTIONS_NEXT_PAGE_SQL } from "@blast/server/modules/social/transactions/read.ts";
import { createSocialTransactionsRoute } from "@blast/server/modules/social/transactions/route.ts";

/**
 * Social feed R3-27: the per-account transaction log over a disposable
 * database (migrations through 0084, the fixture `chain_read_v1` and the
 * feed story), as `blast_web` on the primary. The withdrawal path is the
 * real coins route over a stub fullnode; the log's helper is driven
 * directly for the kinds whose paths are not built in the web yet (a claim,
 * a deposit, a commit). Nothing is signed or sent.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-transactions-app";
const PEPPER = "social-transactions-fixture-pepper-0123456789abcd";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.now();
const PRIVATE = "private, no-store";
const USDC = PORTFOLIO_COIN_TYPES.usdc;
const SUI = PORTFOLIO_COIN_TYPES.sui;
const KAI_ID = FEED_STORY_ACCOUNTS.kai;
const NOVA_ID = FEED_STORY_ACCOUNTS.nova;
const W = FEED_STORY_WALLETS;
const RECIPIENT = `0x${"a3".repeat(32)}`;
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const ABORTED = "3dGmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nW";
const CLAIM_DIGEST = "9GmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nWx";
const RAW_CHAIN_ERROR = "MoveAbort(MoveLocation { module: ModuleId { address: 76cb, name: Identifier(\"presale\") }, function: 12 }, 7) in command 0";

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI = bearer("did:privy:feed-story-kai");
const NOVA = bearer("did:privy:feed-story-nova");
const STRANGER = bearer("did:privy:nobody-here");

type Fixture = Readonly<{
  admin: Pool;
  web: Pool;
  executedBy: Map<string, ExecutedTransfer>;
  /** While true, every rate-limit decision is a refusal with a 17 s retry. */
  limiter: { full: boolean };
  list(query?: string, headers?: Record<string, string>): Promise<Response>;
  transfer(id: string, body: unknown): Promise<Response>;
  log(entry: TransactionEntry, progress?: TransactionProgress): ReturnType<typeof logTransaction>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await seedFeedStory(admin, { nowMs: NOW });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-transactions-web");
  try {
    const real = new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER });
    const limiter = { full: false };
    const port: RateLimitPort = {
      consume: async (bucket, subject) =>
        limiter.full ? { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 17 } : real.consume(bucket, subject),
    };
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: port,
      accounts: new PostgresSocialAccounts(() => web),
      primary: () => web,
    });
    const primary = autocommitReader(web, "social");
    const executedBy = new Map<string, ExecutedTransfer>();
    const coins = createSocialCoinsRoutes({
      // Fixture digests are labels; provenance itself is covered with genuine bytes.
      verifyProvenance: async () => {},
      kit,
      database: () => primary,
      fullnode: () => ({
        listBalances: async () => ({ balances: [], hasNextPage: false, cursor: null }),
        getBalance: async () => ({ balance: { balance: "0" } }),
      }),
      transactions: () => ({ executed: async (digest) => executedBy.get(digest) ?? null }),
      blastWallet: async (caller) => (caller.kind === "privy" && caller.did === "did:privy:feed-story-kai" ? W.kai : null),
      now: () => NOW,
    });
    const route = createSocialTransactionsRoute({ kit, database: () => primary });
    const base = { "x-forwarded-for": "203.0.113.27" };
    await run({
      admin,
      web,
      executedBy,
      limiter,
      list: (query = "", headers = { authorization: KAI }) =>
        route.GET(new Request(`${ORIGIN}/api/social/me/transactions${query}`, { headers: { ...base, ...headers } }), testClient()),
      transfer: (id, body) =>
        coins.transfer(new Request(`${ORIGIN}/api/social/me/transfers/${id}`, {
          method: "PUT",
          headers: { ...base, origin: ORIGIN, "content-type": "application/json", authorization: KAI },
          body: JSON.stringify(body),
        }), testClient()),
      log: (entry, progress) => withTransaction(web, (transaction) => logTransaction(transaction.forModule("social"), entry, progress)),
    });
  } finally {
    await Promise.all([admin.end(), web.end()]);
    await database.drop();
  }
}

async function page(response: Response): Promise<SocialTransactionsPage> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("transactions-page", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as SocialTransactionsPage;
}

async function refused(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body.error;
}

async function logged(admin: Pool, accountId = KAI_ID) {
  const { rows } = await admin.query<{ tx_id: string; kind: string; state: string; digest: string | null; failure_code: string | null; settled: boolean }>(
    `SELECT tx_id::text, kind, state, digest, failure_code, settled_at_ms IS NOT NULL AS settled
     FROM social_transactions WHERE account_id = $1 ORDER BY created_at_ms, tx_id`,
    [accountId],
  );
  return rows;
}

const withdrawal = (overrides: Record<string, unknown> = {}) => ({ coin_type: USDC, amount: "100000000", recipient: RECIPIENT, ...overrides });
const moved = (amount: string): ExecutedTransfer => ({
  success: true,
  sender: W.kai,
  balanceChanges: [{ address: W.kai, coinType: USDC, amount: `-${amount}` }, { address: RECIPIENT, coinType: USDC, amount }],
});

test("R3-27-AC-1, AC-2: a withdrawal logs one row with its request id, gains its digest, then moves submitted to confirmed; a repeat logs nothing new", { skip }, async () => {
  await withFixture(async ({ admin, transfer, executedBy, list }) => {
    const id = randomUUID();
    assert.equal((await transfer(id, withdrawal())).status, 201);
    assert.deepEqual(await logged(admin), [{ tx_id: id, kind: "withdraw", state: "submitted", digest: null, failure_code: null, settled: false }]);

    // Before a digest exists the row is listed with no explorer link.
    const pending = await page(await list());
    assert.equal(pending.transactions.length, 1);
    assert.deepEqual(
      { ...pending.transactions[0], created_at_ms: 0 },
      {
        tx_id: id, kind: "withdraw", state: "submitted", digest: null, failure_code: null, presale_id: null, coin_type: USDC, amount: "100000000",
        quote_type: null, quote_amount: null, usd_value: "100.00", recipient: RECIPIENT, created_at_ms: 0, settled_at_ms: null, explorer_url: null,
      },
    );

    assert.equal((await transfer(id, withdrawal())).status, 200);
    assert.equal((await transfer(id, withdrawal({ digest: DIGEST }))).status, 202);
    assert.deepEqual(await logged(admin), [{ tx_id: id, kind: "withdraw", state: "submitted", digest: DIGEST, failure_code: null, settled: false }]);
    executedBy.set(DIGEST, moved("100000000"));
    assert.equal((await transfer(id, withdrawal({ digest: DIGEST }))).status, 200);
    assert.equal((await transfer(id, withdrawal({ digest: DIGEST }))).status, 200);
    assert.deepEqual(await logged(admin), [{ tx_id: id, kind: "withdraw", state: "confirmed", digest: DIGEST, failure_code: null, settled: true }]);

    // The log row and the withdrawal's own record agree on the digest and the times; the record stays the authority.
    const { rows } = await admin.query<{ same: boolean }>(
      `SELECT t.digest = c.digest AND t.created_at_ms = (extract(epoch FROM c.created_at) * 1000)::bigint
         AND t.settled_at_ms = (extract(epoch FROM c.settled_at) * 1000)::bigint AND c.status = 'confirmed' AS same
       FROM social_transactions t JOIN social_coin_transfers c ON c.request_id = t.tx_id`,
    );
    assert.deepEqual(rows, [{ same: true }]);
    const confirmed = (await page(await list())).transactions[0]!;
    assert.deepEqual([confirmed.state, confirmed.digest, confirmed.explorer_url], ["confirmed", DIGEST, `https://suiscan.xyz/mainnet/tx/${DIGEST}`]);
    assert.ok(confirmed.settled_at_ms !== null && confirmed.settled_at_ms >= confirmed.created_at_ms);

    // A withdrawal recorded before the log existed is logged by its next call, as it then stands.
    const earlier = randomUUID();
    assert.equal((await transfer(earlier, withdrawal({ amount: "5000000" }))).status, 201);
    // (The migration login stands in for the time before 0084; no runtime role may delete a row.)
    await admin.query("DELETE FROM social_transactions WHERE tx_id = $1", [earlier]);
    const earlierDigest = "5vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
    executedBy.set(earlierDigest, moved("5000000"));
    assert.equal((await transfer(earlier, withdrawal({ amount: "5000000", digest: earlierDigest }))).status, 200);
    assert.deepEqual((await logged(admin)).find((row) => row.tx_id === earlier), {
      tx_id: earlier, kind: "withdraw", state: "confirmed", digest: earlierDigest, failure_code: null, settled: true,
    });
  });
});

test("R3-27-AC-3: an aborted withdrawal is a failed row with a published code; no raw chain error is stored or served", { skip }, async () => {
  await withFixture(async ({ admin, transfer, executedBy, list, log }) => {
    const id = randomUUID();
    executedBy.set(ABORTED, { success: false, sender: W.kai, balanceChanges: [] });
    assert.equal((await transfer(id, withdrawal({ digest: ABORTED }))).status, 201);
    assert.deepEqual(await logged(admin), [{ tx_id: id, kind: "withdraw", state: "failed", digest: ABORTED, failure_code: "execution_failed", settled: true }]);

    // A claim the wallet refused to sign: failed with no digest, listed rather than hidden.
    await log(
      { accountId: KAI_ID, kind: "claim_refund", idempotencyKey: "claim:refused", presaleId: FEED_STORY_PRESALES.cancelled, coinType: USDC, amount: "250000000", usdValue: "250" },
      { state: "failed", digest: null, failureCode: "rejected" },
    );
    const response = await list();
    const text = await response.clone().text();
    const body = await page(response);
    assert.deepEqual(body.transactions.map((row) => [row.kind, row.state, row.failure_code, row.digest !== null]), [
      ["claim_refund", "failed", "rejected", false],
      ["withdraw", "failed", "execution_failed", true],
    ]);
    assert.equal(body.transactions[1]!.explorer_url, `https://suiscan.xyz/mainnet/tx/${ABORTED}`, "a failed transaction on chain still links to it");
    assert.doesNotMatch(text, /MoveAbort|abort|Error|error/);

    // The helper refuses an unpublished code, and the table refuses a raw chain error from any writer.
    await assert.rejects(
      log({ accountId: KAI_ID, kind: "claim_tokens", idempotencyKey: "claim:raw" }, { state: "failed", digest: null, failureCode: RAW_CHAIN_ERROR as "rejected" }),
      { name: "TypeError", message: /failureCode/ },
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO social_transactions (tx_id, account_id, kind, state, idempotency_key, settled_at_ms, failure_code)
         VALUES ($1, $2, 'claim_tokens', 'failed', 'claim:raw-sql', $3, $4)`,
        [randomUUID(), KAI_ID, Date.now() + 60_000, RAW_CHAIN_ERROR],
      ),
      { code: "23514", constraint: "social_transactions_failure_code_check" },
    );
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM social_transactions WHERE failure_code !~ '^[a-z][a-z0-9_]{2,63}$'");
    assert.deepEqual(rows, [{ n: 0 }]);
  });
});

test("R3-27-AC-1, AC-2: the helper logs a claim, a deposit and a commit once per key, only moves them forward, and refuses a contradiction", { skip }, async () => {
  await withFixture(async ({ admin, log }) => {
    const claim: TransactionEntry = {
      accountId: KAI_ID, kind: "claim_refund", idempotencyKey: "claim:halcyon:1", presaleId: FEED_STORY_PRESALES.cancelled,
      coinType: USDC, amount: "250000000", usdValue: "250.00",
    };
    const first = await log(claim);
    assert.equal(first.outcome, "recorded");
    assert.deepEqual([first.row.state, first.row.digest, first.row.settled_at_ms], ["submitted", null, null]);
    // The same write again logs once (AC-2), with or without the path's own id.
    assert.equal((await log(claim)).outcome, "repeat");
    assert.equal((await log({ ...claim, txId: first.row.tx_id })).outcome, "repeat");
    assert.equal((await log(claim, { state: "submitted", digest: CLAIM_DIGEST })).outcome, "advanced");
    assert.equal((await log(claim, { state: "submitted", digest: null })).outcome, "repeat", "a stale call changes nothing");
    const settleAt = Date.now() + 60_000;
    const settled = await log(claim, { state: "confirmed", digest: CLAIM_DIGEST, settledAtMs: settleAt });
    assert.deepEqual([settled.outcome, settled.row.state, settled.row.settled_at_ms], ["advanced", "confirmed", String(settleAt)]);
    assert.equal((await log(claim, { state: "submitted", digest: CLAIM_DIGEST })).outcome, "repeat");
    assert.equal((await log(claim, { state: "confirmed", digest: CLAIM_DIGEST })).outcome, "repeat");

    // Contradictions are refused and write nothing.
    for (const [entry, progress, reason] of [
      [{ ...claim, amount: "1" }, undefined, "facts"],
      [{ ...claim, kind: "claim_tokens" }, undefined, "facts"],
      [{ ...claim, txId: randomUUID() }, undefined, "facts"],
      [claim, { state: "submitted", digest: DIGEST }, "digest"],
      [claim, { state: "failed", digest: CLAIM_DIGEST, failureCode: "execution_failed" }, "outcome"],
    ] as const) {
      await assert.rejects(log(entry as TransactionEntry, progress as TransactionProgress | undefined), (error) => error instanceof TransactionLogConflict && error.reason === reason);
    }
    // The same digest cannot be logged for two transactions.
    await assert.rejects(log({ ...claim, idempotencyKey: "claim:halcyon:2" }, { state: "submitted", digest: CLAIM_DIGEST }), { code: "23505", constraint: "social_transactions_digest_idx" });

    // A deposit and a commit (helper only: neither path is built in the web yet), and a settled row logged at once.
    await log({ accountId: KAI_ID, kind: "deposit", idempotencyKey: "deposit:cctp:1", coinType: USDC, amount: "500000000", usdValue: "500" });
    await log(
      { accountId: KAI_ID, kind: "commit", idempotencyKey: "commit:1", presaleId: FEED_STORY_PRESALES.open, quoteType: USDC, quoteAmount: "50000000", usdValue: "50" },
      { state: "confirmed", digest: DIGEST },
    );
    // Another account's same key is its own row.
    await log({ ...claim, accountId: NOVA_ID });
    const { rows } = await admin.query(
      `SELECT account_id::text AS account, kind, state, usd_value::text AS usd FROM social_transactions ORDER BY account_id, kind`,
    );
    assert.deepEqual(rows, [
      { account: KAI_ID, kind: "claim_refund", state: "confirmed", usd: "250.00" },
      { account: KAI_ID, kind: "commit", state: "confirmed", usd: "50.00" },
      { account: KAI_ID, kind: "deposit", state: "submitted", usd: "500.00" },
      { account: NOVA_ID, kind: "claim_refund", state: "submitted", usd: "250.00" },
    ]);
  });
});

test("R3-27-AC-4: 31 rows page as 30 then 1 on (created_at_ms, tx_id): no overlap, no gap, ties broken by id, and no OFFSET", { skip }, async () => {
  await withFixture(async ({ log, list, web }) => {
    const empty = await page(await list());
    assert.deepEqual(empty, { transactions: [], next_cursor: null, explorer: "suiscan" });

    // 31 rows, in pairs that share a millisecond, so the tie-break is exercised.
    const ids: string[] = [];
    for (let n = 0; n < 31; n += 1) {
      const txId = randomUUID();
      ids.push(txId);
      await log({ accountId: KAI_ID, kind: n % 2 ? "commit" : "claim_tokens", idempotencyKey: `seed:${n}`, txId, createdAtMs: NOW - 60_000 + Math.floor(n / 2) * 1_000 });
    }
    // Nova's rows never show in Kai's list.
    await log({ accountId: NOVA_ID, kind: "deposit", idempotencyKey: "seed:nova", createdAtMs: NOW });
    const expected = (await web.query<{ tx_id: string }>(
      "SELECT tx_id::text FROM social_transactions WHERE account_id = $1 ORDER BY created_at_ms DESC, tx_id",
      [KAI_ID],
    )).rows.map((row) => row.tx_id);
    assert.equal(expected.length, 31);

    const one = await page(await list());
    assert.equal(one.transactions.length, 30, "the default page is the gate's 30");
    assert.ok(one.next_cursor);
    const two = await page(await list(`?cursor=${one.next_cursor}`));
    assert.equal(two.transactions.length, 1);
    assert.equal(two.next_cursor, null);
    assert.deepEqual([...one.transactions, ...two.transactions].map((row) => row.tx_id), expected, "page two starts exactly after page one");

    // Smaller pages walk the same order.
    const walked: SocialTransaction[] = [];
    let cursor: string | null = null;
    do {
      const next: SocialTransactionsPage = await page(await list(`?limit=7${cursor ? `&cursor=${cursor}` : ""}`));
      walked.push(...next.transactions);
      cursor = next.next_cursor;
    } while (cursor);
    assert.deepEqual(walked.map((row) => row.tx_id), expected);
    assert.equal((await page(await list("?limit=50"))).transactions.length, 31);

    for (const sql of [TRANSACTIONS_FIRST_PAGE_SQL, TRANSACTIONS_NEXT_PAGE_SQL]) assert.doesNotMatch(sql, /\bOFFSET\b/i);
    for (const query of ["?limit=0", "?limit=51", "?limit=x", "?limit=1&limit=2", "?cursor=nope", `?cursor=${Buffer.from('["1","x"]').toString("base64url")}`]) {
      await refused(await list(query), 400, "invalid_parameter");
    }
  });
});

test("R3-27-AC-5, AC-9: private and no-store, a visitor 401, no account 409, and a full social_read bucket 429 with Retry-After", { skip }, async () => {
  await withFixture(async ({ list, limiter, log }) => {
    await refused(await list("", {}), 401, "unauthorized");
    await refused(await list("", { authorization: STRANGER }), 409, "account_required");
    // Read on the primary: a row is listed the moment it is written.
    await log({ accountId: KAI_ID, kind: "withdraw", idempotencyKey: "fresh", txId: randomUUID() });
    assert.equal((await page(await list())).transactions.length, 1);
    limiter.full = true;
    const response = await list();
    await refused(response, 429, "rate_limited");
    assert.equal(response.headers.get("retry-after"), "17");
    limiter.full = false;
    assert.equal((await page(await list("", { authorization: NOVA }))).transactions.length, 0);
  });
});

test("R3-27-AC-6: explorer_url follows the account's explorer, Suiscan by default", { skip }, async () => {
  await withFixture(async ({ admin, list, log }) => {
    await log({ accountId: KAI_ID, kind: "claim_tokens", idempotencyKey: "claim:explorer", coinType: SUI, amount: "1" }, { state: "confirmed", digest: DIGEST });
    await log({ accountId: KAI_ID, kind: "commit", idempotencyKey: "commit:no-digest" });
    const suiscan = await page(await list());
    assert.equal(suiscan.explorer, "suiscan");
    assert.deepEqual(suiscan.transactions.map((row) => row.explorer_url).sort(), [`https://suiscan.xyz/mainnet/tx/${DIGEST}`, null].sort());
    await admin.query("UPDATE social_accounts SET explorer = 'suivision' WHERE account_id = $1", [KAI_ID]);
    const suivision = await page(await list());
    assert.equal(suivision.explorer, "suivision");
    assert.deepEqual(suivision.transactions.map((row) => row.explorer_url).sort(), [`https://suivision.xyz/txblock/${DIGEST}`, null].sort());
  });
});
