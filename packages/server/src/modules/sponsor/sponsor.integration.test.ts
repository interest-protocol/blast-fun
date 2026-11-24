import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
} from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import {
  CAP,
  fixtureChain,
  identity,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import { createSponsorService } from "./service.ts";
import { namesPresale, SPONSOR_INTENTS, type SponsorIntent } from "@blast/core/modules/sponsor/intents.ts";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import test from "node:test";

import { generateKeyPairSync } from "node:crypto";

import { bcs } from "@mysten/sui/bcs";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";

import { syntheticGoogleOnlyUser } from "../../../../core/test/fixtures/lib/privy-adapter/fixtures.ts";
import { createPrivyHttpGateway } from "@blast/server/lib/privy-adapter/http-gateway.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import {
  createPool,
  createRuntimePool,
} from "@blast/core/modules/database/pool.ts";
import { createPresaleEmbeddedWallets } from "@blast/server/modules/presale/embedded-wallets/service.ts";
import {
  PRESALE_PACKAGE,
  SENDER,
} from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  assertError,
  CLOCK,
  DID,
  harness,
  INTENTS,
  intentKind,
  post,
  SECONDS_TO_UTC_MIDNIGHT,
  SPONSOR,
  sponsorBody,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import {
  MAX_OPEN_SPONSOR_RESERVATIONS,
  PostgresSponsorReservations,
  sponsorClaimWindow,
  type SponsorReservationClaim,
  type SponsorReservationCompletion,
} from "./reservations.ts";

type NewSponsorReservation = Omit<
  SponsorReservationClaim,
  "expiresAt" | "poolDeadline"
> &
  SponsorReservationCompletion;

/**
 * T-016: the reservation table contract (`presale_sponsor_reservations`) and
 * the hourly refusal counts (`presale_sponsor_refusal_counts`), migration 0042,
 * on a disposable Postgres.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl
  ? false
  : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const STORE_DID = "did:privy:presale-sponsor-store";
const NOW = new Date("2026-10-02T21:15:00.000Z");
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
function reservation(
  overrides: Partial<NewSponsorReservation> = {},
): NewSponsorReservation {
  return {
    privyDid: STORE_DID,
    sender: `0x${"a1".repeat(32)}`,
    presaleId: `0x${"51".repeat(32)}`,
    intent: "commit",
    txBytes: Uint8Array.from([0, 1, 2, 3, 250]),
    digest: DIGEST,
    gasBudget: 3_600_000n,
    expiresAt: new Date(NOW.getTime() + 110_000),
    ...overrides,
  };
}

/** The claim expiry the route sets: the claim window (5 s) plus the reservation (120 s). */
const claimExpiry = (now: Date) => sponsorClaimWindow(now).expiresAt;

/** Claims a slot and completes it, as the route does; null when the account is full. */
async function create(
  store: PostgresSponsorReservations,
  row: NewSponsorReservation,
  now: Date,
) {
  const { txBytes, digest, expiresAt, ...claim } = row;
  const claimed = await store.claim(
    { ...claim, ...sponsorClaimWindow(now) },
    now,
  );
  if (claimed.status !== "claimed") return null;
  await store.complete(claimed.id, { txBytes, digest, expiresAt }, now);
  return { id: claimed.id };
}

function claimOf(
  privyDid: string,
): Omit<SponsorReservationClaim, "expiresAt" | "poolDeadline"> {
  return {
    privyDid,
    sender: `0x${"a1".repeat(32)}`,
    presaleId: `0x${"51".repeat(32)}`,
    intent: "commit",
    gasBudget: 3_600_000n,
  };
}

test(
  "Q-011: a claim left by a crash counts toward the cap until its expiry, and cannot be completed after it",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    try {
      await migrateDatabase(pool);
      const store = new PostgresSponsorReservations(pool);
      const did = "did:privy:presale-sponsor-crash";
      await pool.query(
        "DELETE FROM presale_sponsor_reservations WHERE privy_did = $1",
        [did],
      );
      // Two claims whose route crashed before completing: both hold their slots.
      for (let index = 0; index < 2; index += 1) {
        assert.equal(
          (
            await store.claim(
              { ...claimOf(did), ...sponsorClaimWindow(NOW) },
              NOW,
            )
          ).status,
          "claimed",
        );
      }
      // Q-017: while their claims may still complete, a slot may free at the claim deadline (claim + 5 s);
      // after it, a claim still reserving holds its slot to the claim expiry.
      assert.deepEqual(
        await store.claim({ ...claimOf(did), ...sponsorClaimWindow(NOW) }, NOW),
        { status: "full", nextExpiry: new Date(NOW.getTime() + 5_000) },
      );
      const pastDeadline = new Date(NOW.getTime() + 6_000);
      assert.deepEqual(await store.open(did, pastDeadline), {
        count: 2,
        nextExpiry: claimExpiry(NOW),
      });
      const states = await pool.query(
        "SELECT state, pool_reservation_id, tx_bytes, digest FROM presale_sponsor_reservations WHERE privy_did = $1",
        [did],
      );
      assert.deepEqual(
        states.rows,
        Array(2).fill({
          state: "reserving",
          pool_reservation_id: null,
          tx_bytes: null,
          digest: null,
        }),
      );
      // Past the claim expiry they no longer count, and the account claims again.
      const afterExpiry = new Date(claimExpiry(NOW).getTime() + 1);
      assert.equal((await store.open(did, afterExpiry)).count, 0);
      const reclaimed = await store.claim(
        { ...claimOf(did), ...sponsorClaimWindow(afterExpiry) },
        afterExpiry,
      );
      assert.equal(reclaimed.status, "claimed");
      assert.ok(reclaimed.status === "claimed");

      // A completion after the claim expiry changes nothing (Q-016).
      const late = new Date(claimExpiry(afterExpiry).getTime() + 1);
      await assert.rejects(
        store.complete(
          reclaimed.id,
          { txBytes: Uint8Array.from([1]), digest: DIGEST, expiresAt: late },
          late,
        ),
        /no longer being reserved/,
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "Q-016: completing a claim after its expiry fails and never revives the slot",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 2 });
    try {
      await migrateDatabase(pool);
      const store = new PostgresSponsorReservations(pool);
      const did = "did:privy:presale-sponsor-stalled";
      await pool.query(
        "DELETE FROM presale_sponsor_reservations WHERE privy_did = $1",
        [did],
      );
      // A claim made long ago whose route stalled past the claim expiry before completing.
      const long = new Date(Date.now() - 3_600_000);
      const claimed = await store.claim(
        { ...claimOf(did), ...sponsorClaimWindow(long) },
        long,
      );
      assert.ok(claimed.status === "claimed");
      await assert.rejects(
        store.complete(
          claimed.id,
          {
            txBytes: Uint8Array.from([1]),
            digest: DIGEST,
            expiresAt: new Date(Date.now() + 110_000),
          },
          new Date(),
        ),
        /no longer being reserved/,
      );
      const row = await pool.query(
        "SELECT state, expires_at FROM presale_sponsor_reservations WHERE id = $1",
        [claimed.id],
      );
      assert.deepEqual(
        row.rows,
        [{ state: "reserving", expires_at: claimExpiry(long) }],
        "the stalled claim is not revived",
      );
      assert.equal((await store.open(did, new Date())).count, 0);
    } finally {
      await pool.end();
    }
  },
);

test(
  "B-005: a claim that cannot take the account's lock within the lock timeout is busy, not an error",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const setup = createPool(databaseUrl, { max: 2 });
    await migrateDatabase(setup);
    const pool = createRuntimePool(databaseUrl, {
      connectionTimeoutMs: 1_000,
      idleInTransactionMs: 15_000,
      idleTimeoutMs: 10_000,
      lockTimeoutMs: 200,
      max: 2,
      statementTimeoutMs: 8_000,
    });
    const holder = await setup.connect();
    try {
      const did = "did:privy:presale-sponsor-busy";
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`presale_sponsor:${did}`],
      );
      const store = new PostgresSponsorReservations(pool);
      assert.deepEqual(
        await store.claim({ ...claimOf(did), ...sponsorClaimWindow(NOW) }, NOW),
        { status: "busy" },
      );
      await holder.query("ROLLBACK");
      assert.equal(
        (
          await store.claim(
            { ...claimOf(did), ...sponsorClaimWindow(NOW) },
            NOW,
          )
        ).status,
        "claimed",
      );
    } finally {
      holder.release();
      await pool.end();
      await setup.end();
    }
  },
);

test(
  "reservations: the stored row is the execute route's contract, and an account holds at most two open ones",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 8 });
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_reservations");
      const store = new PostgresSponsorReservations(pool);

      assert.deepEqual(await store.open(STORE_DID, NOW), {
        count: 0,
        nextExpiry: null,
      });
      const first = await create(
        store,
        reservation({ expiresAt: new Date(NOW.getTime() + 50_000) }),
        NOW,
      );
      assert.ok(first);
      assert.match(
        first.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const row = await pool.query(
        `SELECT privy_did, sender, presale_id, intent, pool_reservation_id, tx_bytes, digest, gas_budget::text,
              expires_at, state, effects_status, gas_used, submitted_at, completed_at
       FROM presale_sponsor_reservations WHERE id = $1`,
        [first.id],
      );
      assert.deepEqual(row.rows[0], {
        privy_did: STORE_DID,
        sender: `0x${"a1".repeat(32)}`,
        presale_id: `0x${"51".repeat(32)}`,
        intent: "commit",
        pool_reservation_id: null,
        tx_bytes: Buffer.from([0, 1, 2, 3, 250]),
        digest: DIGEST,
        gas_budget: "3600000",
        expires_at: new Date(NOW.getTime() + 50_000),
        state: "reserved",
        effects_status: null,
        gas_used: null,
        submitted_at: null,
        completed_at: null,
      });

      assert.ok(await create(store, reservation(), NOW));
      assert.deepEqual(await store.open(STORE_DID, NOW), {
        count: 2,
        nextExpiry: new Date(NOW.getTime() + 50_000),
      });
      assert.equal(
        await create(store, reservation(), NOW),
        null,
        "a third open reservation is refused",
      );

      // A reservation stops counting once it expires or executes; a submitted one still counts.
      const later = new Date(NOW.getTime() + 60_000);
      assert.equal((await store.open(STORE_DID, later)).count, 1);
      assert.ok(await create(store, reservation(), later));
      await pool.query(
        "UPDATE presale_sponsor_reservations SET state = 'submitted' WHERE id = $1",
        [first.id],
      );
      assert.equal(
        (await store.open(STORE_DID, NOW)).count,
        3,
        "a submitted row holds its coins until it expires",
      );
      await pool.query(
        "UPDATE presale_sponsor_reservations SET state = 'executed', effects_status = 'success', gas_used = -1200 WHERE privy_did = $1",
        [STORE_DID],
      );
      assert.equal((await store.open(STORE_DID, NOW)).count, 0);

      // Concurrent creations for one account store exactly the open cap.
      const racer = "did:privy:presale-sponsor-racer";
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          create(store, reservation({ privyDid: racer }), NOW),
        ),
      );
      assert.equal(
        results.filter(Boolean).length,
        MAX_OPEN_SPONSOR_RESERVATIONS,
      );
      assert.equal(
        (await store.open(racer, NOW)).count,
        MAX_OPEN_SPONSOR_RESERVATIONS,
      );

      // The table refuses shapes outside the contract.
      for (const [index, bad] of [
        reservation({ sender: `0x${"A1".repeat(32)}` }),
        reservation({ privyDid: "user-1" }),
        reservation({ digest: "0xnot-base58" }),
        reservation({ gasBudget: 0n }),
        reservation({ intent: "transfer" as NewSponsorReservation["intent"] }),
      ].entries()) {
        // A claim whose completion fails keeps its slot, so each shape uses its own account.
        const privyDid =
          bad.privyDid === STORE_DID
            ? `did:privy:presale-sponsor-shape-${index}`
            : bad.privyDid;
        await assert.rejects(create(store, { ...bad, privyDid }, NOW));
      }

      // Only a completed row may carry the reserved states: the CHECK refuses a `reserved` row without its bytes.
      const bare = await store.claim(
        {
          ...claimOf("did:privy:presale-sponsor-check"),
          ...sponsorClaimWindow(NOW),
        },
        NOW,
      );
      assert.equal(bare.status, "claimed");
      await assert.rejects(
        pool.query(
          "UPDATE presale_sponsor_reservations SET state = 'reserved' WHERE id = $1",
          [bare.status === "claimed" ? bare.id : ""],
        ),
        (error: { code?: string }) => error.code === "23514",
      );
      // Q-019: and the other way round, a claim or a closed claim never carries bytes or a pool id.
      for (const [state, column, value] of [
        ["reserving", "pool_reservation_id", "5"],
        ["reserving", "tx_bytes", "\\x01"],
        ["reservation_failed", "digest", DIGEST],
      ] as const) {
        await assert.rejects(
          pool.query(
            `UPDATE presale_sponsor_reservations SET state = $2, ${column} = $3 WHERE id = $1`,
            [bare.status === "claimed" ? bare.id : "", state, value],
          ),
          (error: { code?: string }) => error.code === "23514",
          `${state} with ${column}`,
        );
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  "refusal counts: one row per UTC hour and reason, IDs and numbers folded",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_refusal_counts");
      const store = new PostgresSponsorReservations(pool);
      const reason = (pkg: string, index: number) =>
        `command ${index}: ${pkg}::router::swap is not allowed for intent commit`;
      await store.countRefusal(
        reason(`0x${"c0".repeat(32)}`, 3),
        new Date("2026-10-02T21:00:00.000Z"),
      );
      await store.countRefusal(
        reason(`0x${"c9".repeat(32)}`, 4),
        new Date("2026-10-02T21:59:59.999Z"),
      );
      await store.countRefusal(
        reason(`0x${"c0".repeat(32)}`, 3),
        new Date("2026-10-02T22:00:00.000Z"),
      );
      await store.countRefusal(
        "x".repeat(500),
        new Date("2026-10-02T22:10:00.000Z"),
      );
      const rows = await pool.query<{
        hour: Date;
        reason: string;
        count: string;
      }>(
        "SELECT hour, reason, count::text FROM presale_sponsor_refusal_counts ORDER BY hour, reason",
      );
      assert.deepEqual(rows.rows, [
        {
          hour: new Date("2026-10-02T21:00:00.000Z"),
          reason:
            "command N: 0x…::router::swap is not allowed for intent commit",
          count: "2",
        },
        {
          hour: new Date("2026-10-02T22:00:00.000Z"),
          reason:
            "command N: 0x…::router::swap is not allowed for intent commit",
          count: "1",
        },
        {
          hour: new Date("2026-10-02T22:00:00.000Z"),
          reason: "x".repeat(160),
          count: "1",
        },
      ]);
    } finally {
      await pool.end();
    }
  },
);

test(
  "B-004: refusal counts land in the UTC hour whatever the session TimeZone",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const url = new URL(databaseUrl);
    url.searchParams.set("options", "-c TimeZone=Asia/Kolkata");
    const pool = createPool(url.toString(), { max: 2 });
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_refusal_counts");
      assert.equal(
        (
          await pool.query<{ zone: string }>(
            "SELECT current_setting('TimeZone') AS zone",
          )
        ).rows[0].zone,
        "Asia/Kolkata",
      );
      const store = new PostgresSponsorReservations(pool);
      await store.countRefusal(
        "refused on a +05:30 session",
        new Date("2026-10-02T21:40:00.000Z"),
      );
      const rows = await pool.query<{ hour: Date; count: number }>(
        "SELECT hour, count::int FROM presale_sponsor_refusal_counts",
      );
      assert.deepEqual(rows.rows, [
        { hour: new Date("2026-10-02T21:00:00.000Z"), count: 1 },
      ]);
    } finally {
      await pool.end();
    }
  },
);

/** A fixture Privy users API serving one Google-only user whose embedded Sui wallet is the fixtures' sender. */
function fixturePrivy() {
  const user = syntheticGoogleOnlyUser();
  const linked = user.linked_accounts.map((account) =>
    account.connector_type === "embedded" && account.chain_type === "sui"
      ? { ...account, address: SENDER }
      : account,
  );
  const externalWallet = String(
    linked.find((account) => account.connector_type === "injected")?.address,
  );
  const verificationKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString();
  const gateway = createPrivyHttpGateway({
    appId: "presale-sponsor-fixture-app",
    appSecret: "fixture-secret-not-a-credential",
    baseUrl: "https://privy.fixture.test",
    fetch: async (input) => {
      const did = decodeURIComponent(
        new URL(String(input)).pathname.replace(/^\/v1\/users\//, ""),
      );
      return did === DID
        ? Response.json({ ...user, id: DID, linked_accounts: linked })
        : new Response("{}", { status: 404 });
    },
    jwtVerificationKey: verificationKey,
    sleep: async () => undefined,
  });
  return { gateway, externalWallet };
}

test(
  "working path: valid and hostile requests over Postgres, the Privy gateway fixture and a fake pool",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 8 });
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_reservations");
      await pool.query("DELETE FROM presale_sponsor_refusal_counts");
      await pool.query("DELETE FROM presale_embedded_wallets");
      await pool.query(
        "DELETE FROM mission_control_rate_limit_windows WHERE policy_name LIKE 'presale\\_%'",
      );
      const limiter = new PostgresRateLimitEnforcer({
        pool,
        subjectPepper: "p".repeat(32),
        clock: () => new Date(CLOCK),
      });
      const privy = fixturePrivy();
      const reservations = new PostgresSponsorReservations(pool);
      const h = harness(
        {
          wallets: createPresaleEmbeddedWallets({
            pool,
            gateway: privy.gateway,
          }),
          reservations,
          executions: {
            today: (did) =>
              limiter.peek("presale_sponsor_exec", { accountId: did }),
          },
        },
        { limiter },
      );
      const stored = async () =>
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM presale_sponsor_reservations",
          )
        ).rows[0].count;

      // Hostile first: the linked external wallet, a refused target, an abort. Nothing is reserved.
      await assertError(
        await h.route(
          post(await sponsorBody({ sender: privy.externalWallet })), testClient()
        ),
        "not_embedded_wallet",
      );
      await assertError(
        await h.route(
          post(
            await sponsorBody({
              transaction_kind_bytes: await intentKind("settle"),
            }),
          ), testClient()
        ),
        "target_not_allowed",
      );
      h.chain.state.simulation = {
        status: "failure",
        gasUsed: { computationCost: 1n, storageCost: 0n },
        failure: {
          kind: "move_abort",
          packageId: PRESALE_PACKAGE,
          module: "blast_presale",
          code: 29,
        },
      };
      assert.equal(
        (
          await assertError(
            await h.route(post(await sponsorBody()), testClient()),
            "dry_run_failed",
          )
        ).move_abort,
        "EPresaleFilled",
      );
      assert.equal(await stored(), 0);
      const refusals = await pool.query(
        "SELECT hour, count::int FROM presale_sponsor_refusal_counts",
      );
      assert.deepEqual(refusals.rows, [
        { hour: new Date("2026-10-02T21:00:00.000Z"), count: 1 },
      ]);

      // Every intent: valid bytes, stored with their digest.
      h.chain.state.simulation = {
        status: "success",
        gasUsed: { computationCost: 1_000_000n, storageCost: 2_000_000n },
      };
      for (const intent of INTENTS) {
        await pool.query(
          "UPDATE presale_sponsor_reservations SET state = 'executed', effects_status = 'success', gas_used = 1 WHERE state = 'reserved'",
        );
        const response = await h.route(
          post(
            await sponsorBody({
              intent,
              transaction_kind_bytes: await intentKind(intent),
            }),
          ), testClient()
        );
        const body = (await response.json()) as {
          reservation_id: string;
          transaction_bytes: string;
        };
        assert.equal(
          response.status,
          200,
          `${intent}: ${JSON.stringify(body)}`,
        );
        const bytes = fromBase64(body.transaction_bytes);
        assert.equal(
          bcs.TransactionData.parse(bytes).V1?.gasData.owner,
          SPONSOR,
        );
        const row = await pool.query(
          "SELECT intent, digest, tx_bytes, state FROM presale_sponsor_reservations WHERE id = $1",
          [body.reservation_id],
        );
        assert.deepEqual(row.rows[0], {
          intent,
          digest: TransactionDataBuilder.getDigestFromBytes(bytes),
          tx_bytes: Buffer.from(bytes),
          state: "reserved",
        });
      }

      // A third open reservation, then 100 executions today: both 429, neither stores a row.
      assert.equal((await h.route(post(await sponsorBody()), testClient())).status, 200);
      assert.equal(
        (
          await assertError(
            await h.route(post(await sponsorBody()), testClient()),
            "budget_exceeded",
          )
        ).reason,
        "open_reservations",
      );
      await pool.query(
        "UPDATE presale_sponsor_reservations SET state = 'expired'",
      );
      for (let execution = 0; execution < 100; execution += 1)
        await limiter.consume("presale_sponsor_exec", { accountId: DID });
      const daily = await h.route(post(await sponsorBody()), testClient());
      assert.equal(
        (await assertError(daily, "budget_exceeded")).reason,
        "daily_limit",
      );
      assert.equal(
        daily.headers.get("retry-after"),
        String(SECONDS_TO_UTC_MIDNIGHT),
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "Q-001 over Postgres: eight concurrent requests of one account reserve and store at most two",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 12 });
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_reservations");
      await pool.query(
        "DELETE FROM mission_control_rate_limit_windows WHERE policy_name LIKE 'presale\\_%'",
      );
      const limiter = new PostgresRateLimitEnforcer({
        pool,
        subjectPepper: "p".repeat(32),
        clock: () => new Date(CLOCK),
      });
      const h = harness(
        {
          reservations: new PostgresSponsorReservations(pool),
          executions: {
            today: (did) =>
              limiter.peek("presale_sponsor_exec", { accountId: did }),
          },
        },
        { limiter },
      );
      const bodies = await Promise.all(
        Array.from({ length: 8 }, () => sponsorBody()),
      );
      const responses = await Promise.all(
        bodies.map((body) => h.route(post(body), testClient())),
      );
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 200, 429, 429, 429, 429, 429, 429],
      );
      for (const response of responses.filter(
        (candidate) => candidate.status === 429,
      )) {
        assert.equal(
          (await assertError(response, "budget_exceeded")).reason,
          "open_reservations",
        );
      }
      const rows = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM presale_sponsor_reservations WHERE privy_did = $1",
        [DID],
      );
      assert.equal(rows.rows[0].count, 2);
    } finally {
      await pool.end();
    }
  },
);

test(
  "UI-14 (0074): a withdraw reservation names no presale, every presale intent names one, and the CHECK constraints list exactly the registry's intents",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_reservations");
      const store = new PostgresSponsorReservations(pool);
      const withdraw = await create(
        store,
        reservation({
          privyDid: "did:privy:presale-sponsor-withdraw",
          intent: "withdraw",
          presaleId: null,
        }),
        NOW,
      );
      assert.ok(withdraw);
      const { rows } = await pool.query(
        "SELECT intent, presale_id FROM presale_sponsor_reservations WHERE id = $1",
        [withdraw.id],
      );
      assert.deepEqual(rows[0], { intent: "withdraw", presale_id: null });
      // The pairing CHECK: a withdrawal with a presale, or a presale intent without one, is refused.
      await assert.rejects(
        create(
          store,
          reservation({
            privyDid: "did:privy:presale-sponsor-withdraw-2",
            intent: "withdraw",
          }),
          NOW,
        ),
        (error: { code?: string }) => error.code === "23514",
      );
      await assert.rejects(
        create(
          store,
          reservation({
            privyDid: "did:privy:presale-sponsor-withdraw-3",
            presaleId: null,
          }),
          NOW,
        ),
        (error: { code?: string }) => error.code === "23514",
      );
      // The CHECK constraints are the registry's one other copy: a new intent fails here until its migration lands.
      const { rows: checks } = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid = 'presale_sponsor_reservations'::regclass
           AND conname IN ('presale_sponsor_reservations_intent_check', 'presale_sponsor_reservations_presale_by_intent')
         ORDER BY conname`,
      );
      const intents = Object.keys(SPONSOR_INTENTS) as SponsorIntent[];
      assert.deepEqual(
        checks.map(({ definition }) => new Set(definition.match(/'[a-z_]+'/g)?.map((quoted) => quoted.slice(1, -1)))),
        [new Set(intents), new Set(intents.filter((intent) => !namesPresale(intent)))],
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "0162: a wallet session's reservation is keyed sui:<its sender>, and a key naming another address is refused",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 4 });
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_reservations");
      const store = new PostgresSponsorReservations(pool);
      const sender = `0x${"5e".repeat(32)}`;
      const other = `0x${"0e".repeat(32)}`;
      const own = await create(store, reservation({ privyDid: `sui:${sender}`, sender }), NOW);
      assert.ok(own);
      const { rows } = await pool.query(
        "SELECT privy_did, sender FROM presale_sponsor_reservations WHERE id = $1",
        [own.id],
      );
      assert.deepEqual(rows[0], { privy_did: `sui:${sender}`, sender });
      // A wallet session reserves only for the address it signed in with: `sui:` names the sender, or the row is refused.
      await assert.rejects(
        create(store, reservation({ privyDid: `sui:${other}`, sender }), NOW),
        (error: { code?: string; constraint?: string }) =>
          error.code === "23514" && error.constraint === "presale_sponsor_reservations_privy_did_check",
      );
      const { rows: count } = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM presale_sponsor_reservations",
      );
      assert.deepEqual(count[0], { count: 1 });
    } finally {
      await pool.end();
    }
  },
);

test(
  "creation: 32 concurrent users reserve independently while another account is locked",
  { skip },
  async () => {
    assert.ok(databaseUrl);
    const pool = createPool(databaseUrl, { max: 16 });
    let holder: PoolClient | undefined;
    try {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM presale_sponsor_reservations");
      await pool.query(
        "DELETE FROM mission_control_rate_limit_windows WHERE policy_name LIKE 'presale%'",
      );
      const store = new PostgresSponsorReservations(pool);
      const limiter = new PostgresRateLimitEnforcer({
        pool,
        subjectPepper: "p".repeat(32),
        clock: () => NOW,
      });
      const wallets = new Map(
        Array.from({ length: 32 }, (_, index) => [
          `did:privy:creation-load-${index}`,
          `0x${(index + 1).toString(16).padStart(64, "0")}`,
        ]),
      );
      const service = createSponsorService({
        deployment: createPresaleDeploymentGate({
          environment: identity(),
          node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
        }),
        wallets: {
          require: async (did) => {
            const sender = wallets.get(did);
            assert.ok(sender);
            return sender;
          },
        },
        chain: fixtureChain().chain,
        reservations: store,
        limits: limiter,
        executions: {
          today: (did) =>
            limiter.peek("presale_sponsor_exec", { accountId: did }),
        },
        config: () => ({
          sponsorAddress: SPONSOR,
          maxGasMist: CAP,
          swapTargets: [],
          tradeFee: () => null,
        }),
        clock: () => NOW,
      });
      holder = await pool.connect();
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        ["presale_sponsor:did:privy:creation-locked"],
      );
      const tx = new Transaction();
      tx.publish({ modules: [], dependencies: [] });
      const kindBytes = await tx.build({ onlyTransactionKind: true });
      const started = performance.now();
      const results = await Promise.all(
        [...wallets].map(([privyDid, sender]) =>
          service.sponsor({
            intent: "create",
            presaleId: null,
            caller: { kind: "privy", did: privyDid },
            sender,
            kindBytes,
            ip: "203.0.113.7",
          }),
        ),
      );
      assert.equal(results.length, 32);
      assert.equal(new Set(results.map((r) => r.reservation_id)).size, 32);
      assert.equal(
        new Set(
          results.map((r) =>
            TransactionDataBuilder.getDigestFromBytes(
              fromBase64(r.transaction_bytes),
            ),
          ),
        ).size,
        32,
      );
      const rows = await pool.query(
        "SELECT intent, presale_id, state FROM presale_sponsor_reservations",
      );
      assert.equal(rows.rowCount, 32);
      assert.ok(
        rows.rows.every(
          (row) =>
            row.intent === "create" &&
            row.presale_id === null &&
            row.state === "reserved",
        ),
      );
      // The held account lock is still held: independent users completed without waiting for it.
      await holder.query("ROLLBACK");
      holder.release();
      holder = undefined;
      console.log(
        `32 independent creation reservations completed in ${Math.round(performance.now() - started)} ms`,
      );
      const [privyDid, sender] = [...wallets][0]!;
      const request = { intent: "create" as const, presaleId: null, caller: { kind: "privy" as const, did: privyDid }, sender, kindBytes, ip: "203.0.113.7" };
      const raced = await Promise.allSettled(
        Array.from({ length: 8 }, () => service.sponsor(request)),
      );
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(
        (await store.open(privyDid, NOW)).count,
        MAX_OPEN_SPONSOR_RESERVATIONS,
      );
      for (const result of raced)
        if (result.status === "rejected")
          assert.equal(result.reason.code, "budget_exceeded");
    } finally {
      if (holder) {
        await holder.query("ROLLBACK");
        holder.release();
      }
      await pool.end();
    }
  },
);
