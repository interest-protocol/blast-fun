import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";

import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { createPresaleOutcomeRecorder } from "../presale/outcomes/recorder.ts";
import { PostgresPresaleOutcomeStore } from "../presale/outcomes/repository.ts";
import {
  executeHarness,
  executeRequest,
  NET_GAS_USED,
  scaledClock,
} from "../../../test/fixtures/modules/sponsor/execute-fixtures.ts";
import { PostgresSponsorExecutions } from "./executions.ts";
import {
  kindOf,
  PRESALE_ID,
  sdkCommit,
} from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  assertError,
  CLOCK,
  DID,
  fixtureKit,
  harness,
  kindBytes,
  ORIGIN,
  OTHER_DID,
  post,
  SECONDS_TO_UTC_MIDNIGHT,
  sponsorBody,
  validator,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import {
  PostgresSponsorReservations,
  sponsorClaimWindow,
} from "./reservations.ts";

/**
 * T-018 over a disposable Postgres: the sponsor route reserves (T-016), the
 * test signs as the embedded wallet, and the execute route submits through a
 * fake sui-gas-pool, settles the row, counts `presale_sponsor_exec` in the
 * shared rate-limit table, and links the commit through the real outcome
 * store. The fixture node and fake pool share one chain.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl
  ? false
  : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const wallet = Ed25519Keypair.generate();
const WALLET = wallet.toSuiAddress();
/** A second outside wallet, signed in with its own session. */
const otherWallet = Ed25519Keypair.generate();
const OTHER_WALLET_ADDRESS = otherWallet.toSuiAddress();
/** Wallet-session cookies: A signs in as `WALLET`, B as `OTHER_WALLET_ADDRESS`. */
const SESSION_A = "a".repeat(43);
const SESSION_B = "b".repeat(43);
const walletSessions = {
  live: async (cookie: string) =>
    cookie === SESSION_A
      ? { address: WALLET }
      : cookie === SESSION_B
        ? { address: OTHER_WALLET_ADDRESS }
        : null,
};

type Setup = Readonly<{
  pool: Pool;
  limiter: PostgresRateLimitEnforcer;
  sponsor: ReturnType<typeof harness>;
}>;

async function withDatabase(
  run: (setup: Setup) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl);
  const pool = createPool(databaseUrl, { max: 16 });
  try {
    await migrateDatabase(pool);
    await pool.query("DELETE FROM presale_sponsor_reservations");
    await pool.query("DELETE FROM presale_outcomes");
    await pool.query(
      "DELETE FROM mission_control_rate_limit_windows WHERE policy_name LIKE 'presale\\_%'",
    );
    const limiter = new PostgresRateLimitEnforcer({
      pool,
      subjectPepper: "p".repeat(32),
      clock: () => new Date(CLOCK),
    });
    const sponsor = harness(
      {
        kit: fixtureKit(limiter, undefined, walletSessions),
        wallets: { require: async () => WALLET },
        reservations: new PostgresSponsorReservations(pool),
        executions: {
          today: (did) =>
            limiter.peek("presale_sponsor_exec", { accountId: did }),
        },
      },
      { limiter },
    );
    await run({ pool, limiter, sponsor });
  } finally {
    await pool.end();
  }
}

/** The execute route over Postgres, the shared limiter, and the real outcome store with a verifier reading the fake chain. */
function executeOver(
  setup: Setup,
  options: Parameters<typeof executeHarness>[1] = {},
) {
  const recorder = (chain: () => ReadonlyMap<string, { status: string }>) =>
    createPresaleOutcomeRecorder({
      store: new PostgresPresaleOutcomeStore(setup.pool),
      verify: async ({ txDigest }) =>
        chain().get(txDigest)?.status === "success"
          ? {
              status: "verified",
              senderWallet: WALLET,
              completion: {
                status: "completed",
                checkpoint: 412_000_201,
                txDigest,
                eventSeq: 0,
                completedAt: "2026-10-02T21:00:07.000Z",
              },
            }
          : { status: "refused", reason: "unknown-transaction" },
      embeddedWallet: async (did) => (did === DID ? WALLET : null),
      pendingRetryDelaysMs: [],
    });
  let chain: ReadonlyMap<string, { status: string }> = new Map();
  const h = executeHarness(
    {
      kit: fixtureKit(setup.limiter, undefined, walletSessions),
      executions: new PostgresSponsorExecutions(setup.pool),
      outcomes: recorder(() => chain),
    },
    { limiter: setup.limiter, ...options },
  );
  chain = h.pool.state.chain;
  return h;
}

/** Reserves a commit for the test wallet through the sponsor route; the page's `{ reservation_id, transaction_bytes }`. */
async function walletCommit(address = WALLET) {
  return sponsorBody({
    sender: address,
    transaction_kind_bytes: await kindBytes(
      kindOf(sdkCommit("open", { recipient: address }), { sender: address }),
    ),
  });
}

/** A wallet session's request: its cookie from the site itself, and no Privy token. */
function sessionRequest(
  path: string,
  body: unknown,
  cookie: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${cookie}`,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
  });
}

async function reserve(
  setup: Setup,
  as: Readonly<{ session: string; signer: Ed25519Keypair }> | null = null,
): Promise<{ id: string; bytes: Uint8Array; signature: string }> {
  const signer = as?.signer ?? wallet;
  const commit = await walletCommit(signer.toSuiAddress());
  const response = await setup.sponsor.route(
    as ? sessionRequest("/api/presale/sponsor", commit, as.session) : post(commit),
    testClient(),
  );
  const body = (await response.json()) as {
    reservation_id: string;
    transaction_bytes: string;
  };
  assert.equal(response.status, 200, JSON.stringify(body));
  const bytes = fromBase64(body.transaction_bytes);
  return {
    id: body.reservation_id,
    bytes,
    signature: (await signer.signTransaction(bytes)).signature,
  };
}

async function row(pool: Pool, id: string) {
  const result = await pool.query(
    `SELECT privy_did, presale_id, intent, digest, state, effects_status, gas_used::text AS gas_used, submitted_at, completed_at
     FROM presale_sponsor_reservations WHERE id = $1`,
    [id],
  );
  return result.rows[0] as Record<string, unknown>;
}

async function budgetUsed(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT coalesce(sum(request_count), 0)::int AS count FROM mission_control_rate_limit_windows WHERE policy_name = 'presale_sponsor_exec'",
  );
  return result.rows[0]?.count ?? 0;
}

async function success(response: Response) {
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("execute-response", body).errors, []);
  return body as {
    digest: string;
    effects: { status: string; gas_used: string };
  };
}

test(
  "working path: reserve, sign, execute; the row, the budget and the outcome link are stored, and a repeat changes nothing",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const { pool } = setup;
      const reservation = await reserve(setup);
      const h = executeOver(setup);
      const submittedAt = h.time.clock();
      const body = await success(
        await h.route(
          executeRequest(reservation.id, {
            user_signature: reservation.signature,
          }), testClient()
        ),
      );
      const stored = await row(pool, reservation.id);
      assert.deepEqual(body, {
        digest: stored.digest,
        effects: { status: "success", gas_used: NET_GAS_USED },
      });
      // AC-044: DID, presale, intent, digest and outcome for the executed reservation.
      assert.deepEqual(stored, {
        privy_did: DID,
        presale_id: PRESALE_ID,
        intent: "commit",
        digest: body.digest,
        state: "executed",
        effects_status: "success",
        gas_used: NET_GAS_USED,
        submitted_at: submittedAt,
        completed_at: submittedAt,
      });
      assert.equal(h.pool.state.submissions.length, 1);
      assert.equal(await budgetUsed(pool), 1);
      // AC-134: the commit's outcome is linked to the account through the reservation digest.
      await Promise.all(h.background);
      const outcomes = await pool.query(
        "SELECT tx_digest, presale_id, sender_wallet, privy_did FROM presale_outcomes",
      );
      assert.deepEqual(outcomes.rows, [
        {
          tx_digest: body.digest,
          presale_id: PRESALE_ID,
          sender_wallet: WALLET,
          privy_did: DID,
        },
      ]);

      // A repeat: the stored outcome, no second submission, no second budget unit.
      assert.deepEqual(
        await success(
          await h.route(
            executeRequest(reservation.id, {
              user_signature: reservation.signature,
            }), testClient()
          ),
        ),
        body,
      );
      assert.equal(h.pool.state.submissions.length, 1);
      assert.equal(await budgetUsed(pool), 1);
      // Another account sees nothing.
      await assertError(
        await h.route(
          executeRequest(
            reservation.id,
            { user_signature: reservation.signature },
            { did: OTHER_DID },
          ), testClient()
        ),
        "not_found",
      );
    });
  },
);

test(
  "0162 wallet session: its reservation is keyed sui:<address>, another session cannot execute it, a cross-site cookie is refused, and the commit is recorded unlinked",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const { pool } = setup;
      const mine = await reserve(setup, { session: SESSION_A, signer: wallet });
      const theirs = await reserve(setup, { session: SESSION_B, signer: otherWallet });
      assert.equal((await row(pool, mine.id)).privy_did, `sui:${WALLET}`);
      assert.equal((await row(pool, theirs.id)).privy_did, `sui:${OTHER_WALLET_ADDRESS}`);
      const h = executeOver(setup);
      const execute = (id: string, signature: string, cookie: string, headers: Record<string, string> = {}) =>
        h.route(sessionRequest(`/api/presale/sponsor/${id}/execute`, { user_signature: signature }, cookie, headers), testClient());

      // Session A asks for B's reservation, with B's own valid signature: not found, nothing submitted.
      await assertError(await execute(theirs.id, theirs.signature, SESSION_A), "not_found");
      // The cookie is ambient: another site's request carrying it is refused before the reservation is read.
      await assertError(
        await execute(mine.id, mine.signature, SESSION_A, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }),
        "origin_invalid",
      );
      assert.equal(h.pool.state.submissions.length, 0);
      assert.equal((await row(pool, theirs.id)).state, "reserved");

      const submittedAt = h.time.clock();
      const body = await success(await execute(mine.id, mine.signature, SESSION_A));
      assert.equal(h.pool.state.submissions.length, 1);
      assert.deepEqual(await row(pool, mine.id), {
        privy_did: `sui:${WALLET}`,
        presale_id: PRESALE_ID,
        intent: "commit",
        digest: body.digest,
        state: "executed",
        effects_status: "success",
        gas_used: NET_GAS_USED,
        submitted_at: submittedAt,
        completed_at: submittedAt,
      });
      // The outcome names the sender wallet; no Privy account owns a wallet session's commit.
      await Promise.all(h.background);
      const outcomes = await pool.query(
        "SELECT tx_digest, presale_id, sender_wallet, privy_did FROM presale_outcomes",
      );
      assert.deepEqual(outcomes.rows, [
        { tx_digest: body.digest, presale_id: PRESALE_ID, sender_wallet: WALLET, privy_did: null },
      ]);
    });
  },
);

test(
  "T-018-AC-3 over Postgres: six concurrent executes submit once and answer the same outcome",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const reservation = await reserve(setup);
      const h = executeOver(setup, { delayMs: 40, time: scaledClock(100) });
      const request = () =>
        h.route(
          executeRequest(reservation.id, {
            user_signature: reservation.signature,
          }), testClient()
        );
      const bodies = await Promise.all(
        (await Promise.all(Array.from({ length: 6 }, request))).map(success),
      );
      for (const body of bodies) assert.deepEqual(body, bodies[0]);
      assert.equal(h.pool.state.submissions.length, 1);
      assert.equal(await budgetUsed(setup.pool), 1);
      assert.equal((await row(setup.pool, reservation.id)).state, "executed");
    });
  },
);

test(
  "T-018-AC-1/2 over Postgres: a bad signature, an expired or an unfinished reservation submits nothing",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const reservation = await reserve(setup);
      const h = executeOver(setup);
      const other = Ed25519Keypair.generate();
      await assertError(
        await h.route(
          executeRequest(reservation.id, {
            user_signature: (await other.signTransaction(reservation.bytes))
              .signature,
          }), testClient()
        ),
        "invalid_signature",
      );
      assert.equal((await row(setup.pool, reservation.id)).state, "reserved");
      // At expires_at by the route's clock: expired, stored as such.
      const { expires_at: expiresAt } = (
        await setup.pool.query<{ expires_at: Date }>(
          "SELECT expires_at FROM presale_sponsor_reservations WHERE id = $1",
          [reservation.id],
        )
      ).rows[0]!;
      h.time.advance(expiresAt.getTime() - h.time.clock().getTime());
      await assertError(
        await h.route(
          executeRequest(reservation.id, {
            user_signature: reservation.signature,
          }), testClient()
        ),
        "reservation_expired",
      );
      assert.equal((await row(setup.pool, reservation.id)).state, "expired");
      // A claim still reserving (no bytes yet) is not found.
      const store = new PostgresSponsorReservations(setup.pool);
      const claim = await store.claim(
        {
          privyDid: DID,
          sender: WALLET,
          presaleId: PRESALE_ID,
          intent: "commit",
          gasBudget: 3_000_000n,
          ...sponsorClaimWindow(CLOCK),
        },
        CLOCK,
      );
      assert.equal(claim.status, "claimed");
      if (claim.status === "claimed") {
        await assertError(
          await h.route(
            executeRequest(claim.id, { user_signature: reservation.signature }), testClient()
          ),
          "not_found",
        );
      }
      assert.equal(h.pool.state.submissions.length, 0);
      assert.equal(await budgetUsed(setup.pool), 0);
    });
  },
);

test(
  "T-018-AC-4/5 over Postgres: a failure counts, a lost answer resolves on chain, an unknown fate is unconfirmed",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const failed = await reserve(setup);
      const failure = executeOver(setup, { mode: "failure" });
      const failedBody = await success(
        await failure.route(
          executeRequest(failed.id, { user_signature: failed.signature }), testClient()
        ),
      );
      assert.equal(failedBody.effects.status, "failure");
      assert.deepEqual(
        [
          (await row(setup.pool, failed.id)).state,
          (await row(setup.pool, failed.id)).effects_status,
          await budgetUsed(setup.pool),
        ],
        ["failed_execution", "failure", 1],
      );

      const lost = await reserve(setup);
      const late = executeOver(setup, { mode: "sent_then_timeout" });
      assert.equal(
        (
          await success(
            await late.route(
              executeRequest(lost.id, { user_signature: lost.signature }), testClient()
            ),
          )
        ).effects.status,
        "success",
      );
      assert.deepEqual(
        [(await row(setup.pool, lost.id)).state, await budgetUsed(setup.pool)],
        ["executed", 2],
      );

      const unknown = await reserve(setup);
      const silent = executeOver(setup, { mode: "timeout" });
      const error = await assertError(
        await silent.route(
          executeRequest(unknown.id, { user_signature: unknown.signature }), testClient()
        ),
        "execution_unconfirmed",
      );
      const stored = await row(setup.pool, unknown.id);
      assert.deepEqual(
        [
          error.digest,
          stored.state,
          stored.effects_status,
          await budgetUsed(setup.pool),
        ],
        [stored.digest, "unconfirmed", null, 2],
      );
      await Promise.all([
        ...failure.background,
        ...late.background,
        ...silent.background,
      ]);
      // Only the executed commit is linked; the failure and the unconfirmed one are not outcomes.
      const outcomes = await setup.pool.query(
        "SELECT tx_digest FROM presale_outcomes",
      );
      assert.deepEqual(outcomes.rows, [
        { tx_digest: (await row(setup.pool, lost.id)).digest },
      ]);
    });
  },
);

test(
  "AC-034: execute consumes the daily budget the sponsor route reads",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      for (let unit = 0; unit < 99; unit += 1)
        await setup.limiter.consume("presale_sponsor_exec", { accountId: DID });
      const reservation = await reserve(setup);
      const h = executeOver(setup);
      await success(
        await h.route(
          executeRequest(reservation.id, {
            user_signature: reservation.signature,
          }), testClient()
        ),
      );
      assert.equal(await budgetUsed(setup.pool), 100);
      const refused = await setup.sponsor.route(post(await walletCommit()), testClient());
      assert.equal(
        (await assertError(refused, "budget_exceeded")).reason,
        "daily_limit",
      );
      assert.equal(
        refused.headers.get("retry-after"),
        String(SECONDS_TO_UTC_MIDNIGHT),
      );
    });
  },
);

test(
  "B-001 over Postgres: a commit that lands after its row went unconfirmed settles, counts and links on the repeat",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const reservation = await reserve(setup);
      const h = executeOver(setup, { mode: "timeout" });
      const error = await assertError(
        await h.route(
          executeRequest(reservation.id, {
            user_signature: reservation.signature,
          }), testClient()
        ),
        "execution_unconfirmed",
      );
      assert.equal(
        (await row(setup.pool, reservation.id)).state,
        "unconfirmed",
      );
      // The pool's execution completes after the window: the digest is on chain now.
      h.pool.state.chain.set(String(error.digest), {
        digest: String(error.digest),
        status: "success",
        gasUsed: BigInt(NET_GAS_USED),
      });
      const body = await success(
        await h.route(
          executeRequest(reservation.id, {
            user_signature: reservation.signature,
          }), testClient()
        ),
      );
      assert.deepEqual(body, {
        digest: error.digest,
        effects: { status: "success", gas_used: NET_GAS_USED },
      });
      const stored = await row(setup.pool, reservation.id);
      assert.deepEqual(
        [stored.state, stored.effects_status, stored.gas_used],
        ["executed", "success", NET_GAS_USED],
      );
      assert.equal(await budgetUsed(setup.pool), 1);
      assert.equal(h.pool.state.submissions.length, 1);
      await Promise.all(h.background);
      const outcomes = await setup.pool.query(
        "SELECT tx_digest, privy_did FROM presale_outcomes",
      );
      assert.deepEqual(outcomes.rows, [
        { tx_digest: error.digest, privy_did: DID },
      ]);
      // Another repeat is the stored outcome: no second unit.
      assert.deepEqual(
        await success(
          await h.route(
            executeRequest(reservation.id, {
              user_signature: reservation.signature,
            }), testClient()
          ),
        ),
        body,
      );
      assert.equal(await budgetUsed(setup.pool), 1);
    });
  },
);

test(
  "Q-001 over Postgres: expire reports whether it matched; it never matches a row another request submitted",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const reservation = await reserve(setup);
      const store = new PostgresSponsorExecutions(setup.pool);
      const row = await store.find(reservation.id, DID);
      assert.ok(row);
      const justBefore = new Date(row.expiresAt.getTime() - 1);
      assert.equal(
        await store.expire(reservation.id, DID, justBefore),
        false,
        "not yet expired",
      );
      assert.equal(
        await store.submit(reservation.id, DID, justBefore),
        true,
        "a request with an earlier clock submits",
      );
      assert.equal(
        await store.expire(reservation.id, DID, row.expiresAt),
        false,
        "the expiry loses to the submission",
      );
      assert.equal((await store.find(reservation.id, DID))?.state, "submitted");

      const other = await reserve(setup);
      const expiresAt = (await store.find(other.id, DID))?.expiresAt;
      assert.ok(expiresAt);
      assert.equal(await store.expire(other.id, DID, expiresAt), true);
      assert.equal(
        await store.expire(other.id, DID, expiresAt),
        false,
        "only once",
      );
      assert.equal((await store.find(other.id, DID))?.state, "expired");
    });
  },
);

test(
  "review H2 over Postgres: the third wrong signature expires the reservation; revoke moves only a reserved row",
  { skip },
  async () => {
    await withDatabase(async (setup) => {
      const reservation = await reserve(setup);
      const h = executeOver(setup);
      const wrong = (
        await Ed25519Keypair.generate().signTransaction(reservation.bytes)
      ).signature;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await assertError(
          await h.route(
            executeRequest(reservation.id, { user_signature: wrong }), testClient()
          ),
          "invalid_signature",
        );
        assert.equal(
          (await row(setup.pool, reservation.id)).state,
          attempt < 3 ? "reserved" : "expired",
          `after wrong signature ${attempt}`,
        );
      }
      await assertError(
        await h.route(
          executeRequest(reservation.id, {
            user_signature: reservation.signature,
          }), testClient()
        ),
        "reservation_expired",
      );
      assert.equal(h.pool.state.submissions.length, 0);
      const platform = await setup.pool.query<{ count: number }>(
        "SELECT coalesce(sum(request_count), 0)::int AS count FROM mission_control_rate_limit_windows WHERE policy_name = 'presale_sponsor_exec_global'",
      );
      assert.equal(
        platform.rows[0]?.count,
        0,
        "no wrong signature reached the platform's cap",
      );

      const store = new PostgresSponsorExecutions(setup.pool);
      assert.equal(
        await store.revoke(reservation.id, DID),
        false,
        "an expired row stays as it is",
      );
      const other = await reserve(setup);
      assert.equal(
        await store.revoke(other.id, "did:privy:someone-else"),
        false,
        "another account's row is not touched",
      );
      assert.equal(await store.revoke(other.id, DID), true);
      assert.equal((await store.find(other.id, DID))?.state, "expired");
    });
  },
);
