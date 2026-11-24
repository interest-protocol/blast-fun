import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import {
  coinWithBalance,
  Transaction,
  TransactionDataBuilder,
} from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
} from "../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import type { SponsorSimulation } from "./chain.ts";
import {
  CETUS_SWAP_TARGETS,
  OTHER_PRESALE_ID,
  OTHER_WALLET,
  PRESALE_ID,
  PRESALE_PACKAGE,
  QUOTE,
  SENDER,
  cetusSwapAndCommit,
  kindOf,
  sdkClaim,
  sdkCommit,
  sdkRewardClaim,
  sdkSettle,
} from "../../../../core/test/fixtures/modules/sponsor/fixtures.ts";
import {
  assertError,
  assertNothingReserved,
  CAP,
  CLOCK,
  DID,
  EPOCH,
  EXTERNAL_WALLET,
  harness,
  identity,
  INTENTS,
  intentKind,
  kindBytes,
  memoryReservations,
  OTHER_DID,
  OUTAGE_DID,
  post,
  RGP,
  SECONDS_TO_UTC_MIDNIGHT,
  SPONSOR,
  sponsorBody,
  token,
  validator,
  OTHER_VESTING_SCHEDULE,
  VESTING_SCHEDULE,
  WALLETLESS_DID,
} from "../../../test/fixtures/modules/sponsor/route-fixtures.ts";
import { requireSponsorConfig, SPONSOR_MAX_NET_STORAGE_MIST, sponsorConfigFromEnvironment } from "./service.ts";
import { linearVestingClaim } from "@blast/core/modules/sponsor/linear-vesting.ts";

/**
 * T-016: `POST /api/presale/sponsor` as a Request -> Response handler over
 * the route harness (`route-fixtures.ts`). Every refusal must leave the pool
 * untouched.
 */

test("AC-1: no or an invalid Privy token is 401 unauthorized, before the bucket and the pool", async () => {
  const h = harness();
  const body = await sponsorBody();
  for (const headers of [
    { authorization: "" },
    { authorization: "Bearer not-a-token" },
  ]) {
    await assertError(await h.route(post(body, headers), testClient()), "unauthorized");
  }
  assert.deepEqual(h.limiter.calls, []);
  assertNothingReserved(h, "unauthorized");
});

test("AC-1, AC-7: another user's embedded wallet or the caller's external wallet as sender is 403 not_embedded_wallet", async () => {
  const h = harness();
  for (const sender of [OTHER_WALLET, EXTERNAL_WALLET]) {
    await assertError(
      await h.route(post(await sponsorBody({ sender })), testClient()),
      "not_embedded_wallet",
    );
  }
  // A user without an embedded wallet cannot be sponsored at all.
  await assertError(
    await h.route(
      post(await sponsorBody(), {
        authorization: `Bearer ${token(WALLETLESS_DID)}`,
      }), testClient()
    ),
    "not_embedded_wallet",
  );
  // Per IP, then per account (WP3), each request; a request refused before its dry run never reaches the
  // account's daily share or the platform's daily cap (review H1).
  assert.deepEqual(
    h.limiter.calls,
    Array(3).fill(["presale_sponsor_ip", "presale_sponsor"]).flat(),
  );
  assert.equal(h.chain.state.reads, 0, "no chain read before the wallet check");
  assert.equal(
    h.node.calls,
    0,
    "the wallet check comes before the deployment check",
  );
  assertNothingReserved(h, "external wallet");
});

test("a Privy outage on a cache miss is 503 identity_unavailable", async () => {
  const h = harness();
  await assertError(
    await h.route(
      post(await sponsorBody(), {
        authorization: `Bearer ${token(OUTAGE_DID)}`,
      }), testClient()
    ),
    "identity_unavailable",
  );
  assertNothingReserved(h, "outage");
});

test("AC-7: with no deployment identity the route is 503 deployment_unavailable after the wallet check", async () => {
  const h = harness({}, { environment: {} });
  await assertError(
    await h.route(post(await sponsorBody()), testClient()),
    "deployment_unavailable",
  );
  // The wallet check still comes first: an external wallet is refused as such.
  await assertError(
    await h.route(post(await sponsorBody({ sender: EXTERNAL_WALLET })), testClient()),
    "not_embedded_wallet",
  );
  assertNothingReserved(h, "no identity");
});

test("a chain identifier mismatch is 503 deployment_mismatch", async () => {
  const h = harness({
    deployment: createPresaleDeploymentGate({
      environment: identity(),
      node: async () => fixtureChainNode("other-chain-genesis"),
    }),
  });
  await assertError(
    await h.route(post(await sponsorBody()), testClient()),
    "deployment_mismatch",
  );
  assertNothingReserved(h, "mismatch");
});

test("AC-6: every intent gets the caller's kind unchanged, the sponsor's address balance as gas, ValidDuring this epoch or the next, and a capped budget", async () => {
  const h = harness();
  for (const intent of INTENTS) {
    const encodedKind = await intentKind(intent);
    const response = await h.route(
      post(await sponsorBody({ intent, transaction_kind_bytes: encodedKind })), testClient()
    );
    const body = (await response.json()) as Record<string, string | number>;
    assert.equal(response.status, 200, `${intent}: ${JSON.stringify(body)}`);
    assert.deepEqual(
      validator.validate("sponsor-response", body).errors,
      [],
      intent,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(body.sponsor_signature, "");
    // ceil((1,000,000 + 2,000,000) x 1.2) = 3,600,000 MIST.
    assert.equal(body.gas_budget, "3600000");
    assert.equal(
      body.expires_at_ms,
      CLOCK.getTime() + 110_000,
      "reservation time + 120 s - 10 s",
    );

    const bytes = fromBase64(String(body.transaction_bytes));
    const data = bcs.TransactionData.parse(bytes).V1;
    assert.ok(data, intent);
    assert.equal(
      toBase64(bcs.TransactionKind.serialize(data.kind).toBytes()),
      encodedKind,
      `${intent}: the kind is unchanged`,
    );
    assert.equal(data.sender, SENDER);
    assert.equal(data.gasData.owner, SPONSOR);
    assert.equal(data.gasData.price, RGP.toString());
    assert.equal(data.gasData.budget, "3600000");
    assert.ok(BigInt(data.gasData.budget) <= CAP);
    assert.deepEqual(
      data.gasData.payment,
      [],
      `${intent}: no gas coins; the sponsor's address balance pays`,
    );
    const valid = data.expiration.ValidDuring;
    assert.ok(valid, `${intent}: an address-balance payment needs ValidDuring`);
    assert.deepEqual(
      [
        valid.minEpoch,
        valid.maxEpoch,
        valid.minTimestamp,
        valid.maxTimestamp,
        valid.chain,
      ],
      [
        EPOCH.toString(),
        (EPOCH + 1n).toString(),
        null,
        null,
        SUI_MAINNET_CHAIN_IDENTIFIER,
      ],
    );

    // The stored reservation carries the bytes and their digest for execute.
    const row = h.reservations.rows.find(
      (candidate) => candidate.id === body.reservation_id,
    );
    assert.ok(row, `${intent}: stored`);
    assert.equal(row.privyDid, DID);
    assert.equal(row.intent, intent);
    assert.equal(row.digest, TransactionDataBuilder.getDigestFromBytes(bytes));
    assert.deepEqual(row.txBytes, bytes);
    // Two open reservations per account: let each intent start from none.
    h.reservations.rows.length = 0;
  }
  // The simulation used the sponsor's address balance at the reference price and the cap, with the same expiration.
  for (const simulated of h.chain.state.simulated) {
    const data = bcs.TransactionData.parse(simulated).V1;
    const gas = data?.gasData;
    assert.deepEqual(
      gas && [gas.owner, gas.price, gas.budget, gas.payment.length],
      [SPONSOR, RGP.toString(), CAP.toString(), 0],
    );
    assert.equal(
      data?.expiration.ValidDuring?.maxEpoch,
      (EPOCH + 1n).toString(),
    );
  }
});

test("AC-6: the budget is at least 2,000,000 MIST and at most the cap", async () => {
  for (const [computation, storage, expected] of [
    [100_000n, 0n, "2000000"],
    [40_000_000n, 5_000_000n, "50000000"],
    [41_666_666n, 0n, "50000000"],
    [1_000_001n, 0n, "2000000"],
    [2_000_001n, 0n, "2400002"],
  ] as const) {
    const h = harness();
    h.chain.state.simulation = {
      status: "success",
      gasUsed: { computationCost: computation, storageCost: storage },
    };
    const response = await h.route(post(await sponsorBody()), testClient());
    const body = (await response.json()) as Record<string, string>;
    assert.equal(body.gas_budget, expected, `${computation} + ${storage}`);
  }
});

test("AC-2: a commit after the hard cap fills is dry_run_failed EPresaleFilled, and the pool records nothing", async () => {
  const h = harness();
  h.chain.state.simulation = {
    status: "failure",
    gasUsed: { computationCost: 900_000n, storageCost: 0n },
    failure: {
      kind: "move_abort",
      packageId: PRESALE_PACKAGE,
      module: "blast_presale",
      code: 29,
    },
  };
  const error = await assertError(
    await h.route(post(await sponsorBody()), testClient()),
    "dry_run_failed",
  );
  assert.deepEqual(error.move_abort, "EPresaleFilled");
  assert.equal(Object.hasOwn(error, "reason"), false);
  assertNothingReserved(h, "abort");
});

test("CL-19: an abort outside the presale package is move_abort null with reason external_abort", async () => {
  const h = harness();
  // A Cetus module named like a presale module still is not the presale's abort.
  for (const failure of [
    {
      kind: "move_abort",
      packageId: `0x${"c0".repeat(32)}`,
      module: "cetus",
      code: 1,
    },
    { kind: "move_abort", packageId: null, module: "blast_presale", code: 25 },
    { kind: "other", label: "CommandArgumentError" },
  ] as const) {
    h.chain.state.simulation = {
      status: "failure",
      gasUsed: { computationCost: 1n, storageCost: 0n },
      failure,
    };
    const error = await assertError(
      await h.route(post(await sponsorBody()), testClient()),
      "dry_run_failed",
    );
    assert.deepEqual(
      [error.move_abort, error.reason],
      [null, "external_abort"],
      JSON.stringify(failure),
    );
  }
  assertNothingReserved(h, "external abort");
});

test("AC-4: a simulation costing more than the cap is dry_run_failed gas_cap_exceeded", async () => {
  for (const simulation of [
    {
      status: "success",
      gasUsed: { computationCost: 45_000_000n, storageCost: 5_000_001n },
    },
    {
      status: "failure",
      gasUsed: { computationCost: 50_000_000n, storageCost: 0n },
      failure: { kind: "insufficient_gas" },
    },
  ] as const satisfies readonly SponsorSimulation[]) {
    const h = harness();
    h.chain.state.simulation = simulation;
    const error = await assertError(
      await h.route(post(await sponsorBody()), testClient()),
      "dry_run_failed",
    );
    assert.deepEqual(
      [error.move_abort, error.reason],
      [null, "gas_cap_exceeded"],
      simulation.status,
    );
    assertNothingReserved(h, "over the cap");
  }
});

test("a client-built kind that leaves the sponsor paying for more storage than SPONSOR_MAX_NET_STORAGE_MIST is gas_cap_exceeded; rebates count", async () => {
  const over = harness();
  over.chain.state.simulation = {
    status: "success",
    gasUsed: { computationCost: 1_000_000n, storageCost: SPONSOR_MAX_NET_STORAGE_MIST + 1n },
  };
  const error = await assertError(await over.route(post(await sponsorBody()), testClient()), "dry_run_failed");
  assert.deepEqual([error.move_abort, error.reason], [null, "gas_cap_exceeded"]);
  assertNothingReserved(over, "storage over the net cap");

  const rebated = harness();
  rebated.chain.state.simulation = {
    status: "success",
    gasUsed: { computationCost: 1_000_000n, storageCost: SPONSOR_MAX_NET_STORAGE_MIST + 1n, storageRebate: 2n },
  };
  const ok = await rebated.route(post(await sponsorBody()), testClient());
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
});

test("B-005: a claim that cannot get the account's lock is 429 open_reservations with a short Retry-After", async () => {
  const h = harness();
  const busy = harness({
    reservations: {
      ...h.reservations.store,
      claim: async () => ({ status: "busy" }),
    },
  });
  const response = await busy.route(post(await sponsorBody()), testClient());
  assert.equal(
    (await assertError(response, "budget_exceeded")).reason,
    "open_reservations",
  );
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(busy.reservations.reserved().length, 0);
});

test("a claim the route cannot complete stays reserving and keeps its slot until the claim expiry", async () => {
  const h = harness();
  const failing = harness({
    reservations: {
      ...h.reservations.store,
      complete: async () => {
        throw new Error("database gone");
      },
    },
  });
  await assertError(
    await failing.route(post(await sponsorBody()), testClient()),
    "service_unavailable",
  );
  assert.deepEqual(
    h.reservations.rows.map((row) => row.state),
    ["reserving"],
  );
  // The claim expiry covers the claim window (5 s) and the reservation (120 s).
  assert.equal(
    h.reservations.rows[0].expiresAt.getTime(),
    CLOCK.getTime() + 125_000,
  );
  assert.equal((await h.reservations.store.open(DID, CLOCK)).count, 1);
});

test("AC-3: ten executed transactions today are 429 budget_exceeded until the next UTC midnight", async () => {
  const h = harness();
  h.executed.set(DID, 10);
  const response = await h.route(post(await sponsorBody()), testClient());
  assert.equal(
    (await assertError(response, "budget_exceeded")).reason,
    "daily_limit",
    "CL-25",
  );
  assert.equal(
    response.headers.get("retry-after"),
    String(SECONDS_TO_UTC_MIDNIGHT),
  );
  assert.equal(
    h.chain.state.simulated.length,
    0,
    "no simulation after the budget refusal",
  );
  assertNothingReserved(h, "daily budget");
  h.executed.set(DID, 9);
  assert.equal(
    (await h.route(post(await sponsorBody()), testClient())).status,
    200,
    "nine leave one more",
  );
});

test("AC-3: a third open reservation is 429 budget_exceeded until the first one expires", async () => {
  const h = harness();
  for (let index = 0; index < 2; index += 1)
    assert.equal((await h.route(post(await sponsorBody()), testClient())).status, 200);
  const response = await h.route(post(await sponsorBody()), testClient());
  assert.equal(
    (await assertError(response, "budget_exceeded")).reason,
    "open_reservations",
    "CL-25",
  );
  assert.equal(response.headers.get("retry-after"), "110");
  assert.equal(
    h.reservations.reserved().length,
    2,
    "the third request reserved nothing",
  );
  assert.equal(h.chain.state.simulated.length, 2);
  // Another account has its own two.
  const bobKind = await kindBytes(
    kindOf(sdkCommit("open", { recipient: OTHER_WALLET }), {
      sender: OTHER_WALLET,
    }),
  );
  const bob = post(
    await sponsorBody({
      sender: OTHER_WALLET,
      transaction_kind_bytes: bobKind,
    }),
    { authorization: `Bearer ${token(OTHER_DID)}` },
  );
  assert.equal((await h.route(bob, testClient())).status, 200);
});

test("a kind the target policy refuses is 403 target_not_allowed, counted per hour and reason, before any budget, simulation or pool use", async () => {
  const h = harness();
  const refused = [
    // Settle under the commit intent.
    await sponsorBody({
      transaction_kind_bytes: await kindBytes(kindOf(sdkSettle())),
    }),
    // A commit to another presale than the one named.
    await sponsorBody({
      transaction_kind_bytes: await kindBytes(
        kindOf(sdkCommit("open", { presaleId: OTHER_PRESALE_ID })),
      ),
    }),
    // A claim for another participant.
    await sponsorBody({
      intent: "claim",
      transaction_kind_bytes: await kindBytes(kindOf(sdkClaim([OTHER_WALLET]))),
    }),
    // A reward round the chain does not know.
    await sponsorBody({
      intent: "reward_claim",
      transaction_kind_bytes: await kindBytes(
        kindOf(sdkRewardClaim({ round: `0x${"77".repeat(32)}` })),
      ),
    }),
    // A presale the deployment does not have.
    await sponsorBody({ presale_id: OTHER_PRESALE_ID }),
  ];
  h.executed.set(DID, 10);
  for (const body of refused)
    await assertError(await h.route(post(body), testClient()), "target_not_allowed");
  assert.equal(h.chain.state.simulated.length, 0);
  assertNothingReserved(h, "policy");
  const counted = [...h.reservations.refusals.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  assert.equal(counted, refused.length);
  assert.ok(
    [...h.reservations.refusals.keys()].every((key) =>
      key.startsWith("2026-10-02T21|"),
    ),
    "counted in the request's UTC hour",
  );
});

test("P-13: a vesting claim of the sender's own schedule is sponsored under claim; another wallet's schedule is target_not_allowed", async () => {
  const h = harness();
  const own = await kindBytes(kindOf(linearVestingClaim(VESTING_SCHEDULE)));
  const response = await h.route(
    post(await sponsorBody({ intent: "claim", transaction_kind_bytes: own })), testClient()
  );
  assert.equal(
    response.status,
    200,
    JSON.stringify(await response.clone().json()),
  );
  const data = bcs.TransactionData.parse(
    fromBase64(
      String(
        ((await response.json()) as Record<string, unknown>).transaction_bytes,
      ),
    ),
  ).V1!;
  assert.equal(
    toBase64(bcs.TransactionKind.serialize(data.kind).toBytes()),
    own,
    "the kind is unchanged",
  );
  assert.equal(data.gasData.owner, SPONSOR);
  for (const body of [
    await sponsorBody({
      intent: "claim",
      transaction_kind_bytes: await kindBytes(
        kindOf(linearVestingClaim(OTHER_VESTING_SCHEDULE)),
      ),
    }),
    await sponsorBody({ intent: "commit", transaction_kind_bytes: own }),
  ]) {
    await assertError(await h.route(post(body), testClient()), "target_not_allowed");
  }
  assert.equal(
    h.reservations.rows.length,
    1,
    "only the sender's own claim reserved",
  );
});

test("review H1: only a request that passed the body, the policy and the dry run spends the account's daily share and the platform's cap", async () => {
  const h = harness();
  const platform = () =>
    h.limiter.calls.filter(
      (bucket) =>
        bucket === "presale_sponsor_global" ||
        bucket === "presale_sponsor_account_daily",
    ).length;
  // An empty body, a refused target and a failed simulation: refused, and the platform's budget untouched.
  await assertError(await h.route(post({}), testClient()), "invalid_request");
  await assertError(
    await h.route(
      post(
        await sponsorBody({
          transaction_kind_bytes: await kindBytes(kindOf(sdkSettle())),
        }),
      ), testClient()
    ),
    "target_not_allowed",
  );
  h.chain.state.simulation = {
    status: "failure",
    gasUsed: { computationCost: 900_000n, storageCost: 0n },
    failure: {
      kind: "move_abort",
      packageId: PRESALE_PACKAGE,
      module: "blast_presale",
      code: 25,
    },
  };
  await assertError(await h.route(post(await sponsorBody()), testClient()), "dry_run_failed");
  assert.equal(platform(), 0, "no refused request reached the platform's cap");
  assert.deepEqual(
    h.limiter.calls,
    Array(3).fill(["presale_sponsor_ip", "presale_sponsor"]).flat(),
  );
  assertNothingReserved(h, "refused");

  // A request that passes counts once in each, after the dry run, with the account and no subject for the platform.
  h.chain.state.simulation = {
    status: "success",
    gasUsed: { computationCost: 1_000_000n, storageCost: 2_000_000n },
  };
  const ok = await h.route(
    post(await sponsorBody(), { "x-forwarded-for": "203.0.113.44" }), testClient("203.0.113.44")
  );
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.deepEqual(h.limiter.calls.slice(-4), [
    "presale_sponsor_ip",
    "presale_sponsor",
    "presale_sponsor_account_daily",
    "presale_sponsor_global",
  ]);
  assert.deepEqual(h.limiter.subjects.slice(-2), [{ accountId: DID }, {}]);
  assert.deepEqual(
    h.limiter.subjects.at(-4),
    { accountId: DID, ip: "203.0.113.44" },
    "the kit counted the IP; the service does not count it twice",
  );
});

test("review H1: a full platform cap or account share is 429 rate_limited after the dry run, before any slot or pool coin", async () => {
  for (const bucket of [
    "presale_sponsor_account_daily",
    "presale_sponsor_global",
  ] as const) {
    const h = harness();
    h.limiter.refuse.add(bucket);
    await assertError(await h.route(post(await sponsorBody()), testClient()), "rate_limited");
    assert.equal(
      h.chain.state.simulated.length,
      1,
      `${bucket}: refused after the dry run`,
    );
    assertNothingReserved(h, bucket);
  }
});

test("a Cetus swap-and-commit on a configured swap target is sponsored", async () => {
  const h = harness();
  const response = await h.route(
    post(
      await sponsorBody({
        transaction_kind_bytes: await kindBytes(
          kindOf(await cetusSwapAndCommit(), { amount: 1_000_000_000n }),
        ),
      }),
    ), testClient()
  );
  assert.equal(
    response.status,
    200,
    JSON.stringify(await response.clone().json()),
  );
});

test("a malformed body is 400 invalid_request and a kind over 16 KiB is 413 body_too_large, before the wallet check", async () => {
  const h = harness();
  const valid = await sponsorBody();
  for (const body of [
    "not json",
    { ...valid, extra: true },
    { presale_id: PRESALE_ID, sender: SENDER, intent: "commit" },
    { ...valid, intent: "transfer" },
    { ...valid, sender: SENDER.toUpperCase().replace("0X", "0x") },
    { ...valid, presale_id: "0x51" },
    { ...valid, transaction_kind_bytes: "not base64!" },
    { ...valid, transaction_kind_bytes: "AAEC" },
    {
      ...valid,
      transaction_kind_bytes: `${valid.transaction_kind_bytes.slice(0, -4)}`,
    },
  ]) {
    await assertError(await h.route(post(body), testClient()), "invalid_request");
  }
  await assertError(
    await h.route(
      post({
        ...valid,
        transaction_kind_bytes: Buffer.alloc(16 * 1_024 + 1, 1).toString(
          "base64",
        ),
      }), testClient()
    ),
    "body_too_large",
  );
  assert.equal(h.chain.state.reads, 0);
  assertNothingReserved(h, "malformed");
});

test("the sponsor settings: a sponsor address, a cap of at least 2,000,000 MIST (default 50,000,000), the swap targets", () => {
  const plain = sponsorConfigFromEnvironment({ PRESALE_SPONSOR_ADDRESS: SPONSOR }, null)!;
  assert.deepEqual(
    [plain.sponsorAddress, plain.maxGasMist, plain.swapTargets, plain.tradeFee()],
    [SPONSOR, 50_000_000n, [], null],
  );
  const fee = { bps: 50, ppm: 5_000, receiver: `0x${"fe".repeat(32)}` };
  assert.equal(sponsorConfigFromEnvironment({ PRESALE_SPONSOR_ADDRESS: SPONSOR }, fee)!.tradeFee(), fee);
  const configured = sponsorConfigFromEnvironment({
    PRESALE_SPONSOR_ADDRESS: ` ${SPONSOR.toUpperCase().replace("0X", "0x")} `,
    PRESALE_SPONSOR_MAX_GAS_MIST: "2000000",
    PRESALE_SPONSOR_SWAP_TARGETS: CETUS_SWAP_TARGETS,
  }, null)!;
  assert.deepEqual(
    [configured.sponsorAddress, configured.maxGasMist, configured.swapTargets.length],
    [SPONSOR, 2_000_000n, 3],
  );
  // This fails if an unset sponsor stops boot instead of leaving sponsoring off.
  assert.equal(sponsorConfigFromEnvironment({ PRESALE_SPONSOR_ADDRESS: " " }, null), null);
  // This fails if a set but invalid value is accepted, or its message repeats the value.
  for (const [environment, message] of [
    [{ PRESALE_SPONSOR_ADDRESS: "sponsor" }, /^Error: PRESALE_SPONSOR_ADDRESS must be a Sui address\.$/],
    [{ PRESALE_SPONSOR_ADDRESS: "0x5b" }, /^Error: PRESALE_SPONSOR_ADDRESS must be a Sui address\.$/],
    [{ PRESALE_SPONSOR_ADDRESS: SPONSOR, PRESALE_SPONSOR_MAX_GAS_MIST: "1999999" }, /^Error: PRESALE_SPONSOR_MAX_GAS_MIST must be a whole number of MIST from 2000000 to 9007199254740991\.$/],
    [{ PRESALE_SPONSOR_ADDRESS: SPONSOR, PRESALE_SPONSOR_MAX_GAS_MIST: "5e7" }, /^Error: PRESALE_SPONSOR_MAX_GAS_MIST must be/],
    [{ PRESALE_SPONSOR_ADDRESS: SPONSOR, PRESALE_SPONSOR_SWAP_TARGETS: "0x2::coin" }, /^Error: PRESALE_SPONSOR_SWAP_TARGETS must list valid swap targets\.$/],
  ] as const) {
    assert.throws(() => sponsorConfigFromEnvironment(environment, null), message, JSON.stringify(environment));
  }
});

test("missing sponsor settings are 503 service_unavailable, and nothing is reserved", async () => {
  const h = harness({ config: () => requireSponsorConfig(null) });
  await assertError(
    await h.route(post(await sponsorBody()), testClient()),
    "service_unavailable",
  );
  assertNothingReserved(h, "unconfigured");
});

test("Q-001: eight concurrent requests of one account reserve at most two transactions; the rest are 429", async () => {
  const reservations = memoryReservations();
  const completion = Promise.withResolvers<void>();
  const h = harness({
    reservations: {
      ...reservations.store,
      async complete(...args) {
        await completion.promise;
        await reservations.store.complete(...args);
      },
    },
  });
  const bodies = await Promise.all(
    Array.from({ length: 8 }, () => sponsorBody()),
  );
  let answered = 0;
  const responses = await Promise.all(
    bodies.map(async (body) => {
      const response = await h.route(post(body), testClient());
      // Keep the winners reserving until all six refusals have observed the claim deadline.
      if (++answered === 6) {
        assert.deepEqual(
          reservations.rows.map((row) => row.state),
          ["reserving", "reserving"],
        );
        completion.resolve();
      }
      return response;
    }),
  ).finally(() => completion.resolve());
  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 200, 429, 429, 429, 429, 429, 429]);
  for (const response of responses.filter(
    (candidate) => candidate.status === 429,
  )) {
    assert.equal(
      (await assertError(response, "budget_exceeded")).reason,
      "open_reservations",
    );
    // Q-017: the two winners are still `reserving` while the others are refused:
    // retry at the completion deadline (5 s), rather than the 125 s claim expiry.
    assert.equal(
      response.headers.get("retry-after"),
      "5",
      "until the winners' claims complete",
    );
  }
  assert.equal(reservations.reserved().length, 2);
});

/** Social UI-14: the embedded wallet's USDC to another address, as the coins sheet builds it. */
async function withdrawKind(recipient = OTHER_WALLET): Promise<string> {
  const tx = new Transaction();
  const coin = tx.add(
    coinWithBalance({ type: QUOTE, balance: 2_500_000n, useGasCoin: false }),
  );
  tx.transferObjects([coin], tx.pure.address(recipient));
  return kindBytes(kindOf(tx));
}

test("UI-14 withdraw: no presale, no presale read; the caller's kind unchanged, the sponsor pays, the reservation names no presale", async () => {
  const h = harness();
  const encodedKind = await withdrawKind();
  const body = {
    sender: SENDER,
    transaction_kind_bytes: encodedKind,
    intent: "withdraw",
  };
  assert.deepEqual(validator.validate("sponsor-request", body).errors, []);
  const response = await h.route(post(body), testClient());
  const answer = (await response.json()) as Record<string, string | number>;
  assert.equal(response.status, 200, JSON.stringify(answer));
  assert.deepEqual(validator.validate("sponsor-response", answer).errors, []);
  const data = bcs.TransactionData.parse(
    fromBase64(String(answer.transaction_bytes)),
  ).V1;
  assert.ok(data);
  assert.equal(
    toBase64(bcs.TransactionKind.serialize(data.kind).toBytes()),
    encodedKind,
  );
  assert.equal(data.gasData.owner, SPONSOR);
  assert.equal(
    h.chain.state.reads,
    0,
    "a withdrawal reads no presale or round",
  );
  const row = h.reservations.rows.find(
    (candidate) => candidate.id === answer.reservation_id,
  );
  assert.ok(row);
  assert.equal(row.intent, "withdraw");
  assert.equal(row.presaleId, null);
});

test("UI-14 withdraw: a presale_id, another sender, or a kind beyond a coin transfer is refused", async () => {
  const h = harness();
  const encodedKind = await withdrawKind();
  await assertError(
    await h.route(
      post({
        presale_id: PRESALE_ID,
        sender: SENDER,
        transaction_kind_bytes: encodedKind,
        intent: "withdraw",
      }), testClient()
    ),
    "invalid_request",
  );
  await assertError(
    await h.route(
      post({
        sender: OTHER_WALLET,
        transaction_kind_bytes: encodedKind,
        intent: "withdraw",
      }), testClient()
    ),
    "not_embedded_wallet",
  );
  // A commit sent as a withdrawal: the withdraw policy refuses the presale call.
  await assertError(
    await h.route(
      post({
        sender: SENDER,
        transaction_kind_bytes: await intentKind("commit"),
        intent: "withdraw",
      }), testClient()
    ),
    "target_not_allowed",
  );
  // A withdrawal sent as a commit: the presale policy refuses the transfer to another address.
  await assertError(
    await h.route(
      post(await sponsorBody({ transaction_kind_bytes: encodedKind })), testClient()
    ),
    "target_not_allowed",
  );
  assertNothingReserved(h, "refused withdrawals");
});
