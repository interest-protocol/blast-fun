import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toBase64 } from "@mysten/sui/utils";

import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import {
  MemoryLimiter,
  OTHER_DID,
  DID,
  assertError,
  validator,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import {
  executeHarness,
  executeRequest,
  NET_GAS_USED,
  poolEffects,
  reservedRow,
  scaledClock,
  sponsoredBytes,
} from "../../../test/fixtures/modules/sponsor/execute-fixtures.ts";
import { createSponsorTransactionLookup } from "./chain.ts";
import { PRESALE_ID } from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  createSuiGasPoolExecutor,
  gasPoolExecutor,
  gasPoolSettings,
  parsePoolEffects,
} from "./pool-execute.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";

/**
 * T-018: `POST /api/presale/sponsor/{reservation_id}/execute` submits a signed
 * reservation through the gas pool exactly once and settles its outcome.
 * Tests play the browser: the embedded wallet's key signs here.
 */

const wallet = Ed25519Keypair.generate();
const WALLET = wallet.toSuiAddress();
const otherKey = Ed25519Keypair.generate();

async function signed(bytes: Uint8Array, key = wallet): Promise<string> {
  return (await key.signTransaction(bytes)).signature;
}

/** One reserved commit of the test wallet and its signature, for a harness the test builds itself. */
async function signedReservation(
  row: Partial<Parameters<typeof reservedRow>[0]> = {},
) {
  const txBytes = await sponsoredBytes(WALLET);
  return {
    reservation: reservedRow({
      privyDid: DID,
      sender: WALLET,
      txBytes,
      ...row,
    }),
    signature: await signed(txBytes),
  };
}

/** A harness with one reserved commit of the test wallet, and its signature. */
async function reserved(
  options: Parameters<typeof executeHarness>[1] = {},
  row: Partial<Parameters<typeof reservedRow>[0]> = {},
) {
  const h = executeHarness({}, options);
  const txBytes = await sponsoredBytes(WALLET);
  const reservation = reservedRow({
    privyDid: DID,
    sender: WALLET,
    txBytes,
    ...row,
  });
  h.executions.rows.push(reservation);
  return { h, reservation, signature: await signed(txBytes) };
}

async function successBody(
  response: Response,
): Promise<{ digest: string; effects: { status: string; gas_used: string } }> {
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("execute-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body as {
    digest: string;
    effects: { status: string; gas_used: string };
  };
}

test("the happy path: the pool submits once, the row settles, the budget counts and the commit is linked", async () => {
  const { h, reservation, signature } = await reserved();
  const body = await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.deepEqual(body, {
    digest: reservation.digest,
    effects: { status: "success", gas_used: NET_GAS_USED },
  });
  assert.equal(h.pool.state.submissions.length, 1);
  const [submission] = h.pool.state.submissions;
  assert.equal(submission?.authorization, "Bearer pool-fixture-token");
  // The bytes are the stored bytes; the user's signature as given.
  assert.deepEqual(submission?.body, {
    tx_bytes: toBase64(reservation.txBytes),
    user_sig: signature,
  });
  const [row] = h.executions.rows;
  assert.equal(row?.state, "executed");
  assert.deepEqual(row?.outcome, {
    status: "success",
    gasUsed: BigInt(NET_GAS_USED),
  });
  assert.equal(h.consumed(), 1);
  // AC-134: linked through the reservation digest, with no browser call.
  assert.deepEqual(h.recorded, [
    { presaleId: PRESALE_ID, txDigest: reservation.digest, privyDid: DID },
  ]);
});

test("a retired reservation cannot submit, but an already executed reservation remains readable", async () => {
  const { reservation, signature } = await signedReservation();
  const fingerprint = "a".repeat(64);
  let authorizations = 0;
  const guarded = executeHarness({
    async authorizeSubmission(row) {
      authorizations++;
      if (row.deploymentFingerprint !== fingerprint)
        throw new PresaleRouteError("reservation_expired");
    },
  });
  guarded.executions.rows.push(reservation);
  const execute = () => guarded.route(executeRequest(reservation.id, { user_signature: signature }), testClient());
  await assertError(await execute(), "reservation_expired");
  assert.equal(guarded.pool.state.submissions.length, 0);
  assert.equal(guarded.executions.rows[0]?.state, "reserved");
  guarded.executions.rows[0] = { ...reservation, deploymentFingerprint: fingerprint };
  await successBody(await execute());
  await successBody(await execute());
  assert.equal(guarded.pool.state.submissions.length, 1);
  assert.equal(authorizations, 2);
});

test("T-018-AC-1: a signature from another key, over other bytes, or malformed is invalid_signature and submits nothing", async () => {
  const { h, reservation, signature } = await reserved();
  const otherBytes = await sponsoredBytes(WALLET, `0x${"52".repeat(32)}`);
  for (const [label, userSignature] of [
    ["another key", await signed(reservation.txBytes, otherKey)],
    ["other bytes", await signed(otherBytes)],
    ["not a signature", toBase64(new Uint8Array(97).fill(7))],
    ["truncated", signature.slice(0, 40)],
  ] as const) {
    await assertError(
      await h.route(
        executeRequest(reservation.id, { user_signature: userSignature }), testClient()
      ),
      "invalid_signature",
    );
    assert.equal(h.pool.state.submissions.length, 0, label);
    assert.equal(h.executions.rows[0]?.state, "reserved", label);
  }
  assert.equal(h.consumed(), 0);
  // Review H2: a wrong signature never spends the platform's daily cap; each one is counted for this reservation.
  assert.equal(
    (h.limiter as MemoryLimiter).calls.filter(
      (bucket) => bucket === "presale_sponsor_exec_global",
    ).length,
    0,
  );
  assert.equal(
    (h.limiter as MemoryLimiter).calls.filter(
      (bucket) => bucket === "presale_sponsor_bad_signature",
    ).length,
    4,
  );
  // The reservation is still usable with the right signature (this limiter never fills a bucket).
  await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(
    (h.limiter as MemoryLimiter).calls.filter(
      (bucket) => bucket === "presale_sponsor_exec_global",
    ).length,
    1,
    "counted once, for the valid signature",
  );
});

test("Slush 2026-11-21: a node that cannot check a zkLogin proof is service_unavailable, not a wrong signature", async () => {
  const asked: Array<[Uint8Array, string, string]> = [];
  const h = executeHarness({
    async verifySignature(txBytes, signature, address) {
      asked.push([txBytes, signature, address]);
      throw new Error("node down");
    },
  });
  const { reservation, signature } = await signedReservation();
  h.executions.rows.push(reservation);
  await assertError(
    await h.route(executeRequest(reservation.id, { user_signature: signature }), testClient()),
    "service_unavailable",
  );
  assert.deepEqual(asked, [[reservation.txBytes, signature, WALLET]], "the reservation's bytes and sender");
  assert.equal(h.pool.state.submissions.length, 0);
  assert.equal(h.executions.rows[0]?.state, "reserved", "still usable once the node is back");
  assert.equal(
    (h.limiter as MemoryLimiter).calls.filter((bucket) => bucket === "presale_sponsor_bad_signature").length,
    0,
    "never counted toward the three wrong signatures",
  );
});

test("review H2: the third wrong signature expires the reservation; the platform cap counts only a valid, unexpired one", async () => {
  const limits = new MemoryRateLimiter();
  const h = executeHarness({ limits });
  const { reservation, signature } = await signedReservation();
  h.executions.rows.push(reservation);
  const wrong = await signed(reservation.txBytes, otherKey);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assertError(
      await h.route(executeRequest(reservation.id, { user_signature: wrong }), testClient()),
      "invalid_signature",
    );
    assert.equal(
      h.executions.rows[0]?.state,
      attempt < 3 ? "reserved" : "expired",
      `after wrong signature ${attempt}`,
    );
  }
  // Expired now: the right signature answers 410 and submits nothing.
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "reservation_expired",
  );
  assert.equal(h.pool.state.submissions.length, 0);
  assert.equal(
    (h.limiter as MemoryLimiter).calls.filter(
      (bucket) => bucket === "presale_sponsor_exec_global",
    ).length,
    0,
    "nothing reached the platform cap",
  );

  // Another reservation keeps its own count: two wrong signatures, then the right one executes and counts once.
  const second = await signedReservation();
  h.executions.rows.push(second.reservation);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assertError(
      await h.route(
        executeRequest(second.reservation.id, {
          user_signature: await signed(second.reservation.txBytes, otherKey),
        }), testClient()
      ),
      "invalid_signature",
    );
  }
  await successBody(
    await h.route(
      executeRequest(second.reservation.id, {
        user_signature: second.signature,
      }), testClient()
    ),
  );
  assert.equal(
    (h.limiter as MemoryLimiter).calls.filter(
      (bucket) => bucket === "presale_sponsor_exec_global",
    ).length,
    1,
  );
});

test("review H2: a full platform cap refuses a valid signature as rate_limited before anything is submitted", async () => {
  const limiter = new MemoryLimiter();
  limiter.refuse.add("presale_sponsor_exec_global");
  const { h, reservation, signature } = await reserved({ limiter });
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "rate_limited",
  );
  assert.equal(h.pool.state.submissions.length, 0);
  assert.equal(
    h.executions.rows[0]?.state,
    "reserved",
    "the reservation stays usable until it expires",
  );
  // An expired reservation answers 410 without reaching the cap.
  h.time.advance(reservation.expiresAt.getTime() - h.time.clock().getTime());
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "reservation_expired",
  );
  assert.equal(
    limiter.calls.filter((bucket) => bucket === "presale_sponsor_exec_global")
      .length,
    1,
  );
});

test("the body and the path: exact keys and canonical base64 (invalid_request), a uuid path (invalid_parameter)", async () => {
  const { h, reservation, signature } = await reserved();
  for (const body of [
    {},
    { user_signature: signature, extra: 1 },
    { user_signature: 7 },
    { user_signature: "not base64!" },
    { user_signature: "" },
    "[]",
    "{",
  ]) {
    await assertError(
      await h.route(executeRequest(reservation.id, body), testClient()),
      "invalid_request",
    );
  }
  for (const id of [
    "r-1",
    "ABCDEF00-0000-4000-8000-000000000001",
    `${reservation.id}0`,
  ]) {
    await assertError(
      await h.route(executeRequest(id, { user_signature: signature }), testClient()),
      "invalid_parameter",
    );
  }
  const unsigned = new Request(
    executeRequest(reservation.id, { user_signature: signature }),
    { headers: { "content-type": "application/json" } },
  );
  await assertError(await h.route(unsigned, testClient()), "unauthorized");
  assert.equal(h.pool.state.submissions.length, 0);
});

test("T-018-AC-2: another account's, an unknown, or an unfinished reservation is not_found", async () => {
  const { h, reservation, signature } = await reserved();
  await assertError(
    await h.route(
      executeRequest(
        reservation.id,
        { user_signature: signature },
        { did: OTHER_DID },
      ), testClient()
    ),
    "not_found",
  );
  await assertError(
    await h.route(
      executeRequest("00000000-0000-4000-8000-ffffffffffff", {
        user_signature: signature,
      }), testClient()
    ),
    "not_found",
  );
  h.executions.hide(reservation.id);
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "not_found",
  );
  assert.equal(h.pool.state.submissions.length, 0);
});

test("T-018-AC-2: at or after expires_at, by the route's clock, the reservation is expired and nothing is submitted", async () => {
  const { h, reservation, signature } = await reserved();
  h.time.advance(reservation.expiresAt.getTime() - h.time.clock().getTime());
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "reservation_expired",
  );
  assert.equal(h.executions.rows[0]?.state, "expired");
  // Again, and with a bad signature: still expired, still nothing submitted.
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "reservation_expired",
  );
  await assertError(
    await h.route(
      executeRequest(reservation.id, {
        user_signature: await signed(reservation.txBytes, otherKey),
      }), testClient()
    ),
    "reservation_expired",
  );
  assert.equal(h.pool.state.submissions.length, 0);
  assert.equal(h.consumed(), 0);
});

test("T-018-AC-3: a repeated execute returns the stored outcome without resubmitting or counting again", async () => {
  const { h, reservation, signature } = await reserved();
  const first = await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  // A repeat, even with another key's signature, answers the stored outcome.
  for (const userSignature of [
    signature,
    await signed(reservation.txBytes, otherKey),
  ]) {
    assert.deepEqual(
      await successBody(
        await h.route(
          executeRequest(reservation.id, { user_signature: userSignature }), testClient()
        ),
      ),
      first,
    );
  }
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(h.consumed(), 1);
  assert.equal(h.recorded.length, 1);
});

test("T-018-AC-3: concurrent executes submit once and all answer the same digest and effects", async () => {
  // Real time, scaled: 1 ms is 100 ms of the route's clock, so the pool's 30 ms answer lands within every waiter's window.
  const { h, reservation, signature } = await reserved({
    delayMs: 30,
    time: scaledClock(100),
  });
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      h.route(executeRequest(reservation.id, { user_signature: signature }), testClient()),
    ),
  );
  const bodies = await Promise.all(responses.map(successBody));
  for (const body of bodies)
    assert.deepEqual(body, {
      digest: reservation.digest,
      effects: { status: "success", gas_used: NET_GAS_USED },
    });
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(h.consumed(), 1);
  assert.equal(h.recorded.length, 1);
});

test("T-018-AC-4: a failure-status execution answers 200 with failure, counts one budget unit, and links nothing", async () => {
  const { h, reservation, signature } = await reserved({ mode: "failure" });
  const body = await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.deepEqual(body, {
    digest: reservation.digest,
    effects: { status: "failure", gas_used: NET_GAS_USED },
  });
  assert.equal(h.executions.rows[0]?.state, "failed_execution");
  assert.equal(h.consumed(), 1);
  assert.deepEqual(h.recorded, []);
  assert.deepEqual(
    await successBody(
      await h.route(
        executeRequest(reservation.id, { user_signature: signature }), testClient()
      ),
    ),
    body,
  );
  assert.equal(h.consumed(), 1);
});

test("T-018-AC-5: a pool timeout after sending resolves by the digest on chain", async () => {
  const { h, reservation, signature } = await reserved({
    mode: "sent_then_timeout",
  });
  const body = await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.deepEqual(body, {
    digest: reservation.digest,
    effects: { status: "success", gas_used: NET_GAS_USED },
  });
  assert.equal(h.executions.rows[0]?.state, "executed");
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(h.consumed(), 1);
  assert.equal(h.recorded.length, 1);
});

test("T-018-AC-5: a pool timeout with no digest on chain is execution_unconfirmed with the digest, after the 15 s window", async () => {
  const { h, reservation, signature } = await reserved({ mode: "timeout" });
  const started = h.time.clock().getTime();
  const error = await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "execution_unconfirmed",
  );
  assert.equal(error.digest, reservation.digest);
  assert.ok(
    h.time.clock().getTime() - started >= 15_000,
    "it looked for the digest for 15 s",
  );
  assert.ok(h.pool.state.lookups >= 15);
  assert.equal(h.executions.rows[0]?.state, "unconfirmed");
  assert.equal(h.consumed(), 0);
  assert.deepEqual(h.recorded, []);
  // A repeat looks the digest up once more (B-001), never resubmits, and answers the stored 504 while it is unknown.
  const lookups = h.pool.state.lookups;
  assert.equal(
    (
      await assertError(
        await h.route(
          executeRequest(reservation.id, { user_signature: signature }), testClient()
        ),
        "execution_unconfirmed",
      )
    ).digest,
    reservation.digest,
  );
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(h.pool.state.lookups, lookups + 1);
  assert.equal(h.executions.rows[0]?.state, "unconfirmed");
});

test("B-001: a transaction that lands after the window settles on the next repeat, counted and linked once, never resubmitted", async () => {
  const { h, reservation, signature } = await reserved({ mode: "timeout" });
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "execution_unconfirmed",
  );
  assert.equal(h.executions.rows[0]?.state, "unconfirmed");
  // The pool's fullnode call completes late: the digest is now on chain.
  h.pool.state.chain.set(reservation.digest, {
    digest: reservation.digest,
    status: "success",
    gasUsed: BigInt(NET_GAS_USED),
  });
  const responses = await Promise.all(
    [0, 1, 2].map(() =>
      h.route(executeRequest(reservation.id, { user_signature: signature }), testClient()),
    ),
  );
  for (const response of responses) {
    assert.deepEqual(await successBody(response), {
      digest: reservation.digest,
      effects: { status: "success", gas_used: NET_GAS_USED },
    });
  }
  assert.equal(h.executions.rows[0]?.state, "executed");
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(h.consumed(), 1);
  assert.deepEqual(h.recorded, [
    { presaleId: PRESALE_ID, txDigest: reservation.digest, privyDid: DID },
  ]);
});

test("B-001: a node that was down for the whole window settles the row on a repeat once it is back", async () => {
  let down = true;
  const { reservation, signature } = await signedReservation();
  const h = executeHarness(
    {
      transactions: {
        async effects(digest) {
          if (down) throw new Error("UNAVAILABLE");
          return h.pool.state.chain.get(digest) ?? null;
        },
      },
    },
    { mode: "sent_then_timeout" },
  );
  h.executions.rows.push(reservation);
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "execution_unconfirmed",
  );
  assert.equal(h.executions.rows[0]?.state, "unconfirmed");
  assert.equal(h.consumed(), 0);
  down = false;
  assert.equal(
    (
      await successBody(
        await h.route(
          executeRequest(reservation.id, { user_signature: signature }), testClient()
        ),
      )
    ).effects.status,
    "success",
  );
  assert.equal(h.executions.rows[0]?.state, "executed");
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(h.consumed(), 1);
  assert.equal(h.recorded.length, 1);
});

test("a pool error or effects for another digest are not trusted: the chain decides", async () => {
  for (const mode of ["pool_error", "wrong_digest"] as const) {
    const { h, reservation, signature } = await reserved({ mode });
    const response = await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    );
    if (mode === "pool_error") {
      assert.equal(
        (await assertError(response, "execution_unconfirmed")).digest,
        reservation.digest,
      );
      assert.equal(h.executions.rows[0]?.state, "unconfirmed");
    } else {
      // The pool executed; its answer named another digest, so the route read the stored digest from the chain.
      assert.equal((await successBody(response)).digest, reservation.digest);
      assert.equal(h.executions.rows[0]?.state, "executed");
    }
    assert.equal(h.pool.state.submissions.length, 1, mode);
  }
});

test("after submission the answer is only 200 or execution_unconfirmed, even when the executor throws", async () => {
  const { reservation, signature } = await signedReservation();
  const h = executeHarness({
    pool: () => ({
      execute: async () => {
        throw new Error("socket hang up");
      },
    }),
  });
  h.executions.rows.push(reservation);
  assert.equal(
    (
      await assertError(
        await h.route(
          executeRequest(reservation.id, { user_signature: signature }), testClient()
        ),
        "execution_unconfirmed",
      )
    ).digest,
    reservation.digest,
  );
  assert.equal(h.executions.rows[0]?.state, "unconfirmed");
});

test("a reservation left submitted (a crash, or another request) settles from the chain without resubmitting", async () => {
  const { h, reservation, signature } = await reserved(
    {},
    { state: "submitted", submittedAt: new Date(Date.UTC(2026, 9, 2, 20, 59)) },
  );
  h.pool.state.chain.set(reservation.digest, {
    digest: reservation.digest,
    status: "success",
    gasUsed: 5n,
  });
  const body = await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.deepEqual(body.effects, { status: "success", gas_used: "5" });
  assert.equal(h.pool.state.submissions.length, 0);
  assert.equal(h.consumed(), 1);

  // Not on chain: unconfirmed once the submitter's own window (20 s pool + 15 s) has passed.
  const second = await reserved(
    {},
    { state: "submitted", submittedAt: new Date(Date.UTC(2026, 9, 2, 20, 59)) },
  );
  const before = second.h.time.clock().getTime();
  await assertError(
    await second.h.route(
      executeRequest(second.reservation.id, {
        user_signature: second.signature,
      }), testClient()
    ),
    "execution_unconfirmed",
  );
  assert.ok(second.h.time.clock().getTime() - before >= 15_000);
  assert.equal(second.h.pool.state.submissions.length, 0);

  // A waiter never gives up before the submitter's window (Q-004): the pool call (20 s), the window (15 s),
  // the submitter's last lookup (2 s) and a margin for its own overhead (3 s): 40 s.
  const third = await reserved();
  third.h.executions.rows[0] = {
    ...third.reservation,
    state: "submitted",
    submittedAt: third.h.time.clock(),
  };
  const start = third.h.time.clock().getTime();
  await assertError(
    await third.h.route(
      executeRequest(third.reservation.id, { user_signature: third.signature }), testClient()
    ),
    "execution_unconfirmed",
  );
  assert.ok(third.h.time.clock().getTime() - start >= 40_000);
});

test("effects settle a reservation an earlier call could not confirm", async () => {
  const { h, reservation, signature } = await reserved(
    {},
    {
      state: "unconfirmed",
      submittedAt: new Date(Date.UTC(2026, 9, 2, 20, 59)),
    },
  );
  // The stored outcome answers while unconfirmed.
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "execution_unconfirmed",
  );
  assert.equal(
    await h.executions.store.settle(
      reservation.id,
      { status: "failure", gasUsed: -3n },
      h.time.clock(),
    ),
    true,
  );
  const body = await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.deepEqual(body.effects, { status: "failure", gas_used: "-3" });
});

test("T-018-AC-6: only an executed commit is linked; other intents and failures are not", async () => {
  for (const intent of ["claim", "settle", "cancel", "reward_claim"] as const) {
    const { h, reservation, signature } = await reserved({}, { intent });
    await successBody(
      await h.route(
        executeRequest(reservation.id, { user_signature: signature }), testClient()
      ),
    );
    assert.deepEqual(h.recorded, [], intent);
    assert.equal(h.consumed(), 1, intent);
  }
});

test("Q-003: a settlement the database cannot store answers the effects but counts and links nothing; the repeat that settles counts once", async () => {
  const { reservation, signature } = await signedReservation();
  let failures = 1;
  const h = executeHarness();
  const memory = h.executions.store;
  const failing = executeHarness({
    executions: {
      ...memory,
      async settle(...args) {
        if (failures-- > 0) throw new Error("connection terminated");
        return memory.settle(...args);
      },
    },
  });
  // The failing harness's store is `h`'s rows; its pool and chain are its own.
  h.executions.rows.push(reservation);
  const body = await successBody(
    await failing.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.equal(body.effects.status, "success");
  assert.equal(h.executions.rows[0]?.state, "submitted");
  assert.equal(failing.consumed(), 0);
  assert.equal(failing.recorded.length, 0);
  // The repeat settles from the chain: one unit, one link, no second submission.
  assert.deepEqual(
    await successBody(
      await failing.route(
        executeRequest(reservation.id, { user_signature: signature }), testClient()
      ),
    ),
    body,
  );
  assert.equal(h.executions.rows[0]?.state, "executed");
  assert.equal(failing.pool.state.submissions.length, 1);
  assert.equal(failing.consumed(), 1);
  assert.equal(failing.recorded.length, 1);
});

test("Q-001/B-002: an expire that loses to a concurrent submit answers from the row, not 410", async () => {
  for (const settledFirst of [false, true]) {
    const { reservation, signature } = await signedReservation();
    const h = executeHarness();
    const memory = h.executions.store;
    h.executions.rows.push(reservation);
    h.pool.state.chain.set(reservation.digest, {
      digest: reservation.digest,
      status: "success",
      gasUsed: 7n,
    });
    const executing = executeHarness({
      executions: {
        ...memory,
        // Another request whose clock read a moment earlier wins the row (and maybe settles it) first.
        async expire(id, did, now) {
          await memory.submit(
            id,
            did,
            new Date(reservation.expiresAt.getTime() - 1),
          );
          if (settledFirst)
            await memory.settle(id, { status: "success", gasUsed: 7n }, now);
          return memory.expire(id, did, now);
        },
      },
      transactions: h.pool.lookup,
    });
    executing.time.advance(
      reservation.expiresAt.getTime() - executing.time.clock().getTime(),
    );
    const body = await successBody(
      await executing.route(
        executeRequest(reservation.id, { user_signature: signature }), testClient()
      ),
    );
    assert.deepEqual(
      body,
      {
        digest: reservation.digest,
        effects: { status: "success", gas_used: "7" },
      },
      `settled first: ${settledFirst}`,
    );
    assert.equal(h.executions.rows[0]?.state, "executed");
    assert.equal(
      executing.pool.state.submissions.length,
      0,
      "this request never submits",
    );
  }
});

test("Q-001/B-002: after a lost submit, an expire that loses too answers from the row", async () => {
  const { reservation, signature } = await signedReservation();
  const h = executeHarness();
  const memory = h.executions.store;
  h.executions.rows.push(reservation);
  h.pool.state.chain.set(reservation.digest, {
    digest: reservation.digest,
    status: "success",
    gasUsed: 7n,
  });
  const executing = executeHarness({
    executions: {
      ...memory,
      // By this instance's clock the row expired between its check and its update.
      submit: async (id, did) => memory.submit(id, did, reservation.expiresAt),
      // An instance whose clock is a moment behind submits it first.
      async expire(id, did, now) {
        await memory.submit(
          id,
          did,
          new Date(reservation.expiresAt.getTime() - 1),
        );
        return memory.expire(id, did, now);
      },
    },
    transactions: h.pool.lookup,
  });
  executing.time.advance(
    reservation.expiresAt.getTime() - executing.time.clock().getTime() - 1,
  );
  assert.equal(
    (
      await successBody(
        await executing.route(
          executeRequest(reservation.id, { user_signature: signature }), testClient()
        ),
      )
    ).effects.gas_used,
    "7",
  );
  assert.equal(h.executions.rows[0]?.state, "executed");
});

test("a pool without settings is service_unavailable before anything is submitted", async () => {
  const { reservation, signature } = await signedReservation();
  const h = executeHarness({
    pool: () => {
      throw new PresaleRouteError("service_unavailable");
    },
  });
  h.executions.rows.push(reservation);
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "service_unavailable",
  );
  assert.equal(h.executions.rows[0]?.state, "reserved");
  // This fails if a missing URL or token reaches the pool instead of answering service_unavailable.
  assert.throws(() => gasPoolExecutor(gasPoolSettings({})), /temporarily unavailable/);
  assert.throws(
    () => gasPoolExecutor(gasPoolSettings({ PRESALE_GAS_POOL_URL: "https://pool.fixture.test" })),
    /temporarily unavailable/,
  );
  // This fails if a URL the executor cannot call is accepted at boot.
  assert.throws(
    () => gasPoolSettings({ PRESALE_GAS_POOL_URL: "ftp://pool", PRESALE_GAS_POOL_TOKEN: "t" }),
    /^Error: PRESALE_GAS_POOL_URL must be an http or https URL\.$/,
  );
  assert.ok(
    gasPoolExecutor(gasPoolSettings({
      PRESALE_GAS_POOL_URL: "https://pool.fixture.test",
      PRESALE_GAS_POOL_TOKEN: "t",
    })),
  );
});

test("the pool execute client trusts only a 2xx carrying effects and no error", async () => {
  const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  const input = { txBytes: Uint8Array.from([1, 2, 3]), userSignature: "AAEC" };
  const answer = (
    response: (
      signal: AbortSignal | null | undefined,
    ) => Response | Promise<Response>,
    timeoutMs = 100,
  ) =>
    createSuiGasPoolExecutor({
      url: "http://127.0.0.1:9527/",
      token: "t",
      timeoutMs,
      fetch: async (_url, init) => response(init?.signal),
    }).execute(input);
  assert.deepEqual(
    await answer(() =>
      Response.json({ effects: poolEffects(digest, "success"), error: null }),
    ),
    {
      status: "executed",
      effects: { digest, status: "success", gasUsed: 2_020_000n },
    },
  );
  for (const [label, response, reason, httpStatus] of [
    [
      "refusal",
      () =>
        Response.json(
          { error: "the gas payment must be empty (address balance)" },
          { status: 400 },
        ),
      "pool_error",
      400,
    ],
    [
      "node failure",
      () =>
        Response.json(
          { error: "execution failed or unknown" },
          { status: 502 },
        ),
      "pool_error",
      502,
    ],
    [
      "error beside effects",
      () =>
        Response.json({
          effects: poolEffects(digest, "success"),
          error: "late",
        }),
      "pool_error",
      200,
    ],
    [
      "gateway",
      () => new Response("<html>504</html>", { status: 504 }),
      "malformed",
      504,
    ],
    [
      "effects at 502",
      () =>
        Response.json(
          { effects: poolEffects(digest, "success") },
          { status: 502 },
        ),
      "malformed",
      502,
    ],
    ["empty", () => new Response(null, { status: 200 }), "malformed", 200],
    [
      "no status",
      () =>
        Response.json({
          effects: { ...poolEffects(digest, "success"), status: {} },
        }),
      "malformed",
      200,
    ],
    [
      "bad gas",
      () =>
        Response.json({
          effects: {
            ...poolEffects(digest, "success"),
            gasUsed: { computationCost: "-1" },
          },
        }),
      "malformed",
      200,
    ],
  ] as const) {
    assert.deepEqual(
      await answer(response),
      { status: "unknown", reason, httpStatus },
      label,
    );
  }
  assert.deepEqual(
    await answer(() => {
      throw new TypeError("fetch failed");
    }),
    { status: "unknown", reason: "transport", httpStatus: null },
  );
  const hang = (signal: AbortSignal | null | undefined) =>
    new Promise<Response>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  assert.deepEqual(await answer(hang, 20), {
    status: "unknown",
    reason: "transport",
    httpStatus: null,
  });
  let sent = "";
  await createSuiGasPoolExecutor({
    url: "http://127.0.0.1:9527",
    token: "t",
    fetch: async (_url, init) => {
      sent = String(init?.body);
      return Response.json({ effects: poolEffects(digest, "failure") });
    },
  }).execute(input);
  assert.equal(sent, `{"tx_bytes":"AQID","user_sig":"AAEC"}`);
  assert.deepEqual(
    parsePoolEffects({
      ...poolEffects(digest, "failure"),
      gasUsed: { computationCost: "1", storageCost: "0", storageRebate: "10" },
    }),
    {
      digest,
      status: "failure",
      gasUsed: -9n,
    },
  );
});

test("the route is wired to the published contract: no undeclared code, and a limiter refusal of the budget still answers", async () => {
  class Refusing extends MemoryLimiter {
    override async consume(bucket: Parameters<MemoryLimiter["consume"]>[0]) {
      this.calls.push(bucket);
      // The daily budget refuses; the request-level buckets (WP3) have room.
      const allowed = bucket !== "presale_sponsor_exec";
      return {
        allowed,
        bucket,
        policyVersion: 1,
        retryAfterSeconds: allowed ? 0 : 60,
      };
    }
  }
  const { h, reservation, signature } = await reserved({
    limiter: new Refusing(),
  });
  // The eleventh execution of a day still executed: the budget unit is counted, the answer is the outcome.
  await successBody(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
  );
  assert.equal(h.consumed(), 1);
});

test("the digest lookup reads the node's effects; an unknown digest is null and a node failure rejects", async () => {
  const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
  const effects = (success: boolean, transactionDigest = digest) => ({
    transactionDigest,
    status: success
      ? { success: true, error: null }
      : { success: false, error: { $kind: "MoveAbort", message: "abort" } },
    gasUsed: {
      computationCost: "1000",
      storageCost: "500",
      storageRebate: "2000",
      nonRefundableStorageFee: "20",
    },
  });
  const client = (answer: () => unknown) =>
    ({
      core: { getTransaction: async () => answer() },
    }) as unknown as ClientWithCoreApi;
  const lookup = (answer: () => unknown) =>
    createSponsorTransactionLookup(client(answer)).effects(digest);
  assert.deepEqual(
    await lookup(() => ({
      $kind: "Transaction",
      Transaction: { effects: effects(true) },
    })),
    { digest, status: "success", gasUsed: -500n },
  );
  assert.deepEqual(
    await lookup(() => ({
      $kind: "FailedTransaction",
      FailedTransaction: { effects: effects(false) },
    })),
    { digest, status: "failure", gasUsed: -500n },
  );
  assert.equal(
    await lookup(() => ({
      $kind: "Transaction",
      Transaction: {
        effects: effects(true, "9vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"),
      },
    })),
    null,
  );
  assert.equal(
    await lookup(() => {
      throw new TransactionError("notFound", digest);
    }),
    null,
  );
  await assert.rejects(
    lookup(() => {
      throw new Error("UNAVAILABLE");
    }),
    /UNAVAILABLE/,
  );
});

test("background capacity refuses before global spend or submission, while invalid signatures retain precedence", async () => {
  const h = executeHarness({ reserveBackground: () => null });
  const { reservation, signature } = await signedReservation();
  h.executions.rows.push(reservation);
  await assertError(
    await h.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "service_unavailable",
  );
  assert.equal(h.pool.state.submissions.length, 0);
  assert.equal(h.executions.rows[0]!.state, "reserved");
  assert.equal(
    (h.limiter as MemoryLimiter).calls.includes("presale_sponsor_exec_global"),
    false,
  );
  await assertError(
    await h.route(
      executeRequest(reservation.id, {
        user_signature: await signed(reservation.txBytes, otherKey),
      }), testClient()
    ),
    "invalid_signature",
  );
  const submitted = executeHarness({ reserveBackground: () => null });
  submitted.executions.rows.push({
    ...reservation,
    state: "submitted",
    submittedAt: new Date(),
  });
  await assertError(
    await submitted.route(
      executeRequest(reservation.id, { user_signature: signature }), testClient()
    ),
    "service_unavailable",
  );
  assert.equal(
    submitted.pool.state.lookups,
    0,
    "capacity is known before confirmation can settle",
  );
});

test("only the conditional settle winner attaches, and every unused reservation releases", async () => {
  const {
    createAfterResponseScheduler,
    createRequestWork,
    runWithRequestWork,
    reserveAfterResponse,
  } = await import("@blast/server/lib/request-work.ts");
  const scheduler = createAfterResponseScheduler();
  const h = executeHarness({ reserveBackground: reserveAfterResponse });
  const { reservation, signature } = await signedReservation();
  h.executions.rows.push(reservation);
  const request = createRequestWork(scheduler);
  const response = await runWithRequestWork(request, () =>
    h.route(executeRequest(reservation.id, { user_signature: signature }), testClient()),
  );
  await successBody(response);
  assert.equal(h.recorded.length, 0);
  assert.equal(scheduler.active, 1);
  await request.complete();
  const duplicate = createRequestWork(scheduler);
  await successBody(
    await runWithRequestWork(duplicate, () =>
      h.route(executeRequest(reservation.id, { user_signature: signature }), testClient()),
    ),
  );
  await duplicate.complete();
  await scheduler.drain();
  assert.equal(h.pool.state.submissions.length, 1);
  assert.equal(h.recorded.length, 1);
  assert.equal(h.consumed(), 1);
  assert.equal(scheduler.active, 0);

  const refusing = createAfterResponseScheduler();
  const limiter = new MemoryLimiter();
  limiter.refuse.add("presale_sponsor_exec_global");
  const refused = executeHarness(
    { reserveBackground: reserveAfterResponse },
    { limiter },
  );
  const other = await signedReservation();
  refused.executions.rows.push(other.reservation);
  const scope = createRequestWork(refusing);
  await assertError(
    await runWithRequestWork(scope, () =>
      refused.route(
        executeRequest(other.reservation.id, {
          user_signature: other.signature,
        }), testClient()
      ),
    ),
    "rate_limited",
  );
  assert.equal(
    refusing.active,
    0,
    "unused reservation releases in finally before response completion",
  );
  await scope.complete();
  await refusing.drain();
});

test("an oversized execute body is refused before reading or submitting the reservation", async () => {
  const { h, reservation } = await reserved();
  await assertError(
    await h.route(executeRequest(reservation.id, { user_signature: "A".repeat(16 * 1024) }), testClient()),
    "body_too_large",
  );
  assert.equal(h.pool.state.submissions.length, 0);
  assert.equal(h.executions.rows[0]?.state, "reserved");
  assert.equal(h.consumed(), 0);
});
