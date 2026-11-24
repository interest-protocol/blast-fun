import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { Pool } from "pg";

import {
  COIN_VIEW_EVENT,
  LAUNCHPAD_REPORTING_POLICY,
  LaunchpadTelemetryRejection,
  OUTCOME_KINDS,
  parseCoinViewEvent,
  parseCompletedOutcome,
  outcomeCommitmentWindowMs,
  parseVisitorId,
  reportingPeriodStart,
  reportingPolicy,
} from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import {
  LAUNCHPAD_TELEMETRY_TIMEOUT_MS,
  createLaunchpadTelemetryEmitter,
  type LaunchpadTelemetrySink,
} from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import {
  LAUNCHPAD_TELEMETRY_BODY_LIMIT,
  VISITOR_COOKIE_NAME,
  createLaunchpadTelemetryRouteHandler,
  visitorIdFromRequest,
} from "@blast/server/modules/launchpad-telemetry/route.ts";
import { LaunchpadTelemetryService } from "@blast/server/modules/launchpad-telemetry/service.ts";
import type { LaunchpadTelemetryRepository } from "@blast/server/modules/launchpad-telemetry/repository.ts";
import { LAUNCHPAD_TELEMETRY_PATH, createCoinViewReporter } from "./client.ts";
import { testClient } from "../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

const LAUNCH_ID = `0x${"ab".repeat(32)}`;
const WALLET = `0x${"c0".repeat(32)}`;
const VISITOR = "3f0c8f5e-2a47-4c1b-9d7e-5b8a1c2d3e4f";
const DIGEST = "4pFwTqfQ3m1kVg7nN8hQ9hXg5Y5y7p8E2yR6bW3sJmGv";

function rejectionReason(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof LaunchpadTelemetryRejection, String(error));
    return error.reason;
  }
  assert.fail("expected a rejection");
}

test("a coin view names one canonical launch ID and a bounded surface", () => {
  assert.deepEqual(
    parseCoinViewEvent({ event: COIN_VIEW_EVENT, launchId: LAUNCH_ID, surface: "coin-page" }),
    { event: "launchpad.coin_view.v1", launchId: LAUNCH_ID, surface: "coin-page" },
  );
});

test("coin views reject unknown events, labels, extra fields and private values", () => {
  const view = { event: COIN_VIEW_EVENT, launchId: LAUNCH_ID, surface: "coin-page" };
  assert.equal(rejectionReason(() => parseCoinViewEvent(null)), "shape");
  assert.equal(rejectionReason(() => parseCoinViewEvent("coin_view")), "shape");
  assert.equal(
    rejectionReason(() => parseCoinViewEvent({ ...view, event: "mission_control.blastoff" })),
    "event",
  );
  assert.equal(rejectionReason(() => parseCoinViewEvent({ ...view, event: WALLET })), "event");
  assert.equal(rejectionReason(() => parseCoinViewEvent({ ...view, surface: WALLET })), "label");
  assert.equal(
    rejectionReason(() => parseCoinViewEvent({ ...view, surface: "did:privy:cm0abc" })),
    "label",
  );
  // Extra fields cannot smuggle a wallet, profile, thesis, URL or signature in.
  for (const extra of [
    { wallet: WALLET },
    { privySubject: "did:privy:cm0abc" },
    { profileId: "pilot_one" },
    { thesis: "this coin will moon" },
    { evidenceUrl: "https://x.com/pilot/status/1" },
    { signature: "AKd3...base64" },
    { [WALLET]: "coin-page" },
  ]) {
    assert.equal(rejectionReason(() => parseCoinViewEvent({ ...view, ...extra })), "shape");
  }
  // A launch ID is the canonical Sui object ID only, never normalized.
  for (const launchId of [LAUNCH_ID.toUpperCase(), "0xab", `${LAUNCH_ID}0`, "pilot_one", 7]) {
    assert.equal(rejectionReason(() => parseCoinViewEvent({ ...view, launchId })), "launch-id");
  }
});

test("a visitor is correlated only by a first-party opaque random ID", () => {
  const visitor = VISITOR;
  assert.equal(parseVisitorId(visitor), visitor);
  for (const value of [
    WALLET,
    "did:privy:cm0abc123",
    "pilot@example.com",
    "pilot_one",
    visitor.toUpperCase(),
    "3f0c8f5e-2a47-1c1b-9d7e-5b8a1c2d3e4f", // not random (version 1)
    "",
    null,
    42,
  ]) {
    assert.equal(rejectionReason(() => parseVisitorId(value)), "visitor");
  }
});

test("the reporting policy sets the UTC period a first view is counted once in", () => {
  // One policy drives the period, the funnel range, the cookie lifetime and cleanup.
  assert.deepEqual(LAUNCHPAD_REPORTING_POLICY, { periodDays: 1, retentionDays: 90 });
  const daily = reportingPolicy({ periodDays: 1, retentionDays: 90 });
  assert.equal(reportingPeriodStart(new Date("2026-09-30T00:00:00.000Z"), daily), "2026-09-30");
  assert.equal(reportingPeriodStart(new Date("2026-09-30T23:59:59.999Z"), daily), "2026-09-30");
  // Weekly periods are aligned to the Unix epoch (a Thursday), in UTC.
  const weekly = reportingPolicy({ periodDays: 7, retentionDays: 91 });
  assert.equal(reportingPeriodStart(new Date("2026-09-24T00:00:00.000Z"), weekly), "2026-09-24");
  assert.equal(reportingPeriodStart(new Date("2026-09-30T23:59:59.999Z"), weekly), "2026-09-24");
  assert.equal(reportingPeriodStart(new Date("2026-10-01T00:00:00.000Z"), weekly), "2026-10-01");
  for (const policy of [
    { periodDays: 0, retentionDays: 90 },
    { periodDays: 1.5, retentionDays: 90 },
    { periodDays: 32, retentionDays: 90 },
    { periodDays: 7, retentionDays: 6 },
    { periodDays: 1, retentionDays: 401 },
  ]) {
    assert.throws(() => reportingPolicy(policy), TypeError);
  }
  assert.throws(() => reportingPeriodStart(new Date(Number.NaN), daily), TypeError);
});

test("an outcome record is a completed chain event, never an intent", () => {
  const completion = {
    status: "completed",
    checkpoint: 326_274_009,
    txDigest: DIGEST,
    eventSeq: 0,
    completedAt: "2026-09-30T12:00:00.000Z",
  };
  const outcome = { kind: "buy", launchId: LAUNCH_ID, senderWallet: WALLET, visitorId: null, completion };
  assert.deepEqual(OUTCOME_KINDS, ["buy", "launch", "migration"]);
  assert.deepEqual(parseCompletedOutcome(outcome), outcome);
  const lastEvent = { ...completion, eventSeq: 2_147_483_647 };
  assert.equal(parseCompletedOutcome({ ...outcome, completion: lastEvent }).completion.eventSeq, 2_147_483_647);

  // Clicks, simulations, signatures and submitted digests are not success.
  for (const status of ["clicked", "simulated", "signed", "submitted", "pending", "failed"]) {
    assert.equal(
      rejectionReason(() => parseCompletedOutcome({ ...outcome, completion: { ...completion, status } })),
      "completion",
      status,
    );
  }
  // A digest alone (no checkpoint or event) is only a submission.
  for (const partial of [
    { status: "completed", txDigest: DIGEST },
    { ...completion, checkpoint: undefined },
    { ...completion, signature: "AKd3...base64" },
  ]) {
    assert.equal(
      rejectionReason(() => parseCompletedOutcome({ ...outcome, completion: partial })),
      "completion",
    );
  }
  for (const [field, value] of [
    ["checkpoint", -1],
    ["checkpoint", 1.5],
    ["checkpoint", "326274009"],
    ["eventSeq", -1],
    ["txDigest", `0x${"ab".repeat(32)}`],
    ["txDigest", "0OIl".repeat(11)],
    ["eventSeq", 2_147_483_648], // above the stored INTEGER
    ["completedAt", "yesterday"],
    ["completedAt", "2026-02-30T00:00:00.000Z"], // an impossible date
    ["completedAt", "2026-09-30T12:00:00Z"], // not the canonical toISOString() form
  ] as const) {
    assert.equal(
      rejectionReason(() =>
        parseCompletedOutcome({ ...outcome, completion: { ...completion, [field]: value } })),
      "completion",
      `${field}=${String(value)}`,
    );
  }

  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...outcome, kind: "volume" })), "event");
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...outcome, kind: "click" })), "event");
  const linked = { ...outcome, visitorId: VISITOR, visitorLink: "privy_session" };
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...linked, visitorId: WALLET })), "visitor");
  assert.equal(
    rejectionReason(() => parseCompletedOutcome({ ...linked, visitorId: "did:privy:cm0abc" })),
    "visitor",
  );
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...outcome, launchId: WALLET.slice(0, 20) })), "launch-id");
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...outcome, wallet: WALLET })), "shape");
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...outcome, amount: "1000000" })), "shape");
});

test("an undecided outcome commitment is kept for a short configured window, never past the reporting retention", () => {
  const MINUTE = 60_000;
  assert.equal(outcomeCommitmentWindowMs(undefined), 60 * MINUTE);
  assert.equal(outcomeCommitmentWindowMs("15"), 15 * MINUTE);
  assert.equal(outcomeCommitmentWindowMs(" 240 "), 240 * MINUTE);
  const retention = LAUNCHPAD_REPORTING_POLICY.retentionDays * 24 * 60 * MINUTE;
  assert.equal(outcomeCommitmentWindowMs(String(LAUNCHPAD_REPORTING_POLICY.retentionDays * 24 * 60 + 1)), retention);
  for (const malformed of ["", "0", "-5", "1.5", "1e3", "an hour", "NaN"]) {
    assert.equal(outcomeCommitmentWindowMs(malformed), 60 * MINUTE, JSON.stringify(malformed));
  }
});

test("an outcome carries its event's sender wallet, and a visitor only with how that visitor was linked", () => {
  const completion = {
    status: "completed",
    checkpoint: 326_274_009,
    txDigest: DIGEST,
    eventSeq: 0,
    completedAt: "2026-09-30T12:00:00.000Z",
  };
  const walletOnly = { kind: "launch", launchId: LAUNCH_ID, senderWallet: WALLET, visitorId: null, completion };
  assert.deepEqual(parseCompletedOutcome(walletOnly), walletOnly);
  for (const visitorLink of ["privy_session", "signed_commitment"]) {
    const linked = { ...walletOnly, visitorId: VISITOR, visitorLink };
    assert.deepEqual(parseCompletedOutcome(linked), linked, visitorLink);
  }

  // The sender is required and canonical: a chain address, never a label or a short form.
  const noSender: Partial<typeof walletOnly> = { ...walletOnly };
  delete noSender.senderWallet;
  assert.equal(rejectionReason(() => parseCompletedOutcome(noSender)), "shape");
  for (const senderWallet of [null, WALLET.toUpperCase().replace("0X", "0x"), "0x2", "did:privy:cm0abc", VISITOR]) {
    assert.equal(rejectionReason(() => parseCompletedOutcome({ ...walletOnly, senderWallet })), "sender", String(senderWallet));
  }
  // A link exists exactly when a visitor does, and is one of the two ways a visitor is linked.
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...walletOnly, visitorId: VISITOR })), "shape");
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...walletOnly, visitorLink: "privy_session" })), "shape");
  assert.equal(rejectionReason(() => parseCompletedOutcome({ ...walletOnly, visitorLink: null })), "shape");
  for (const visitorLink of ["cookie", "first_reporter", null]) {
    assert.equal(
      rejectionReason(() => parseCompletedOutcome({ ...walletOnly, visitorId: VISITOR, visitorLink })),
      "link",
      String(visitorLink),
    );
  }
});

/** Coin-view sinks never take an outcome commitment. */
const NO_OUTCOME_COMMITMENTS = {
  admitOutcomeCommitment: async () => assert.fail("coin views never use the commitment bucket"),
  recordOutcomeCommitment: async () => assert.fail("coin views never store a commitment"),
} satisfies Pick<LaunchpadTelemetrySink, "admitOutcomeCommitment" | "recordOutcomeCommitment">;

/** Captures the one-line JSON metrics `recordMetric` writes. */
function metrics(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  return lines;
}

const COIN_VIEW = { event: COIN_VIEW_EVENT, launchId: LAUNCH_ID, surface: "coin-page" };
const OUTCOME = {
  kind: "buy",
  launchId: LAUNCH_ID,
  senderWallet: WALLET,
  visitorId: VISITOR,
  visitorLink: "privy_session",
  completion: {
    status: "completed",
    checkpoint: 326_274_009,
    txDigest: DIGEST,
    eventSeq: 0,
    completedAt: "2026-09-30T12:00:00.000Z",
  },
};

function sink(
  outcome: () => Promise<"recorded" | "duplicate">,
  admit: () => Promise<"allowed" | "limited"> = async () => "allowed",
): LaunchpadTelemetrySink {
  return {
    admitCoinView: admit,
    admitOutcomeReport: admit,
    admitOutcomeCommitment: admit,
    recordCoinView: outcome,
    recordOutcome: outcome,
    recordOutcomeCommitment: outcome,
  };
}

test("the server emitter reports what telemetry did without ever rejecting", async (t) => {
  const lines = metrics(t);
  const recorded = createLaunchpadTelemetryEmitter(() => sink(async () => "recorded"));
  assert.equal(await recorded.recordCoinView(VISITOR, COIN_VIEW), "recorded");
  assert.equal(await recorded.admitCoinView("203.0.113.7"), "allowed");
  const duplicate = createLaunchpadTelemetryEmitter(() => sink(async () => "duplicate"));
  assert.equal(await duplicate.recordOutcome(OUTCOME), "duplicate");

  // Storage outage, unconfigured database or limiter, malformed input: all absorbed.
  const outage = createLaunchpadTelemetryEmitter(() =>
    sink(
      async () => {
        throw Object.assign(new Error(`connect ECONNREFUSED for ${WALLET}`), { code: "ECONNREFUSED" });
      },
      async () => {
        throw Object.assign(new Error("rate limiter down"), { code: "57P01" });
      },
    ));
  assert.equal(await outage.recordOutcome(OUTCOME), "dropped");
  assert.equal(await outage.admitCoinView("203.0.113.7"), "dropped");
  const unconfigured = createLaunchpadTelemetryEmitter(() => {
    throw new Error("DATABASE_URL is required.");
  });
  assert.equal(await unconfigured.recordCoinView(VISITOR, COIN_VIEW), "dropped");
  const rejecting = createLaunchpadTelemetryEmitter(() =>
    sink(async () => {
      throw new LaunchpadTelemetryRejection("label");
    }));
  assert.equal(await rejecting.recordCoinView(VISITOR, { ...COIN_VIEW, surface: WALLET }), "rejected");

  // Metrics carry bounded labels only: never the wallet, visitor, coin, digest or IP.
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    parsed.map(({ metric, event, result, reason }) => ({ metric, event, result, reason })),
    [
      { metric: "launchpad.telemetry", event: "coin_view", result: "recorded", reason: undefined },
      { metric: "launchpad.telemetry", event: "admission", result: "allowed", reason: undefined },
      { metric: "launchpad.telemetry", event: "outcome", result: "duplicate", reason: undefined },
      { metric: "launchpad.telemetry", event: "outcome", result: "dropped", reason: "ECONNREFUSED" },
      { metric: "launchpad.telemetry", event: "admission", result: "dropped", reason: "57P01" },
      { metric: "launchpad.telemetry", event: "coin_view", result: "dropped", reason: "Error" },
      { metric: "launchpad.telemetry", event: "coin_view", result: "rejected", reason: "label" },
    ],
  );
  for (const secret of [WALLET, VISITOR, LAUNCH_ID, DIGEST, "203.0.113.7"]) {
    assert.ok(!lines.some((line) => line.includes(secret)), secret);
  }
});

test("a hanging telemetry store cannot hold a product action past the emitter timeout", async (t) => {
  metrics(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hanging = createLaunchpadTelemetryEmitter(() => sink(() => new Promise(() => {})));

  // A representative product action that even awaits its telemetry.
  async function completeBuy(): Promise<{ digest: string }> {
    const receipt = { digest: DIGEST };
    await hanging.recordOutcome(OUTCOME);
    return receipt;
  }
  let settled: unknown = "pending";
  const action = completeBuy().then((receipt) => (settled = receipt));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, "pending");
  t.mock.timers.tick(LAUNCHPAD_TELEMETRY_TIMEOUT_MS);
  await action;
  assert.deepEqual(settled, { digest: DIGEST });
  assert.ok(LAUNCHPAD_TELEMETRY_TIMEOUT_MS <= 2_000);
});

/** A pool that only reports its occupancy; the fake repository never touches it. */
function occupiedPool(state: { max: number; total: number; idle: number; waiting: number }): Pool {
  return {
    options: { max: state.max },
    get totalCount() {
      return state.total;
    },
    get idleCount() {
      return state.idle;
    },
    get waitingCount() {
      return state.waiting;
    },
  } as unknown as Pool;
}

test("telemetry takes at most a quarter of its pool and never makes anything wait for a connection", async () => {
  const pending: Array<() => void> = [];
  const repository = {
    recordFirstView: () =>
      new Promise<"recorded">((resolve) => pending.push(() => resolve("recorded"))),
    recordOutcome: async () => ({ result: "recorded", late: 0 }),
  } as unknown as LaunchpadTelemetryRepository;

  // A pool of 4 lends telemetry one connection at a time.
  const small = occupiedPool({ max: 4, total: 1, idle: 1, waiting: 0 });
  const telemetry = new LaunchpadTelemetryService(small, { repository });
  const first = telemetry.recordCoinView(VISITOR, COIN_VIEW);
  await assert.rejects(telemetry.recordCoinView(VISITOR, COIN_VIEW), { code: "LAUNCHPAD_TELEMETRY_BUSY" });
  // The limit is per pool and process, not per service object.
  await assert.rejects(
    new LaunchpadTelemetryService(small, { repository }).recordOutcome(OUTCOME),
    { code: "LAUNCHPAD_TELEMETRY_BUSY" },
  );
  pending.shift()?.();
  assert.equal(await first, "recorded");
  assert.equal(await telemetry.recordOutcome(OUTCOME), "recorded", "the slot is free again");

  // When the pool has waiters, or every connection is lent out at its maximum, telemetry steps aside.
  for (const state of [
    { max: 10, total: 3, idle: 3, waiting: 1 },
    { max: 10, total: 10, idle: 0, waiting: 0 },
  ]) {
    await assert.rejects(
      new LaunchpadTelemetryService(occupiedPool(state), { repository }).recordOutcome(OUTCOME),
      { code: "LAUNCHPAD_TELEMETRY_BUSY" },
    );
  }
  // A pool of 10 lends it two.
  const large = occupiedPool({ max: 10, total: 2, idle: 2, waiting: 0 });
  const busy = new LaunchpadTelemetryService(large, { repository });
  const a = busy.recordCoinView(VISITOR, COIN_VIEW);
  const b = busy.recordCoinView(VISITOR, COIN_VIEW);
  await assert.rejects(busy.recordCoinView(VISITOR, COIN_VIEW), { code: "LAUNCHPAD_TELEMETRY_BUSY" });
  pending.splice(0).forEach((resolve) => resolve());
  assert.deepEqual(await Promise.all([a, b]), ["recorded", "recorded"]);

  // A share that frees within the bounded wait serves the next call instead of dropping it.
  const queued = new LaunchpadTelemetryService(small, { repository });
  const holder = queued.recordCoinView(VISITOR, COIN_VIEW);
  const next = queued.recordCoinView(VISITOR, COIN_VIEW);
  setTimeout(() => pending.shift()?.(), 5);
  assert.equal(await holder, "recorded");
  setTimeout(() => pending.shift()?.(), 5);
  assert.equal(await next, "recorded");
});

const ORIGIN = "https://blast.fun";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/launchpad/telemetry`, {
    method: "POST",
    body,
    headers: { "Content-Type": "text/plain;charset=UTF-8", ...headers },
  });
}

test("ingestion mints a first-party opaque visitor cookie and reuses it for dedupe", async (t) => {
  metrics(t);
  const views: Array<{ visitorId: unknown; input: unknown }> = [];
  const handler = createLaunchpadTelemetryRouteHandler({
    createVisitorId: () => VISITOR,
    expectedOrigin: ORIGIN,
    verifyTradable: async () => "tradable",
    emitter: createLaunchpadTelemetryEmitter(() => ({
      admitOutcomeReport: async () => assert.fail("coin views never use the outcome bucket"),
      ...NO_OUTCOME_COMMITMENTS,
      admitCoinView: async () => "allowed",
      recordCoinView: async (visitorId, input) => {
        views.push({ visitorId, input });
        return views.length === 1 ? "recorded" : "duplicate";
      },
      recordOutcome: async () => assert.fail("the browser cannot record outcomes"),
    })),
  });

  const first = await handler(post(JSON.stringify(COIN_VIEW), { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }), testClient());
  assert.equal(first.status, 204);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(
    first.headers.get("set-cookie"),
    `${VISITOR_COOKIE_NAME}=${VISITOR}; Path=/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax`,
  );
  const second = await handler(
    post(JSON.stringify(COIN_VIEW), { Cookie: `other=1; ${VISITOR_COOKIE_NAME}=${VISITOR}` }), testClient(),
  );
  assert.equal(second.status, 204);
  assert.equal(second.headers.get("set-cookie"), null, "an existing visitor keeps its ID");
  // Server flows read the same opaque ID to correlate their verified outcomes.
  assert.equal(visitorIdFromRequest(post("", { Cookie: `${VISITOR_COOKIE_NAME}=${VISITOR}` })), VISITOR);
  assert.equal(visitorIdFromRequest(post("", { Cookie: `${VISITOR_COOKIE_NAME}=${WALLET}` })), null);
  assert.equal(visitorIdFromRequest(post("")), null);
  assert.deepEqual(views, [
    { visitorId: VISITOR, input: COIN_VIEW },
    { visitorId: VISITOR, input: COIN_VIEW },
  ]);

  // A cookie that is not an opaque visitor ID (say, a wallet) is replaced, never stored.
  const replaced = await handler(
    post(JSON.stringify(COIN_VIEW), { Cookie: `${VISITOR_COOKIE_NAME}=${WALLET}` }), testClient(),
  );
  assert.equal(replaced.status, 204);
  assert.match(replaced.headers.get("set-cookie") ?? "", new RegExp(`^${VISITOR_COOKIE_NAME}=${VISITOR};`));
  assert.equal(views.at(-1)?.visitorId, VISITOR);
});

test("ingestion refuses malformed, oversized, private and foreign telemetry before storage", async (t) => {
  const lines = metrics(t);
  let calls = 0;
  const handler = createLaunchpadTelemetryRouteHandler({
    createVisitorId: () => VISITOR,
    expectedOrigin: ORIGIN,
    verifyTradable: async () => "tradable",
    emitter: createLaunchpadTelemetryEmitter(() => ({
      admitOutcomeReport: async () => assert.fail("coin views never use the outcome bucket"),
      ...NO_OUTCOME_COMMITMENTS,
      admitCoinView: async () => {
        calls += 1;
        return "allowed";
      },
      recordCoinView: async () => {
        calls += 1;
        return "recorded";
      },
      recordOutcome: async () => "recorded",
    })),
  });

  assert.equal((await handler(post("{not json"), testClient())).status, 400);
  assert.equal((await handler(post(JSON.stringify({ ...COIN_VIEW, wallet: WALLET })), testClient())).status, 400);
  assert.equal((await handler(post(JSON.stringify({ ...COIN_VIEW, surface: "did:privy:cm0abc" })), testClient())).status, 400);
  // The browser may only send coin views; outcomes are recorded by verified server flows.
  assert.equal((await handler(post(JSON.stringify(OUTCOME)), testClient())).status, 400);
  assert.equal(
    (await handler(post(JSON.stringify({ ...COIN_VIEW, pad: "x".repeat(LAUNCHPAD_TELEMETRY_BODY_LIMIT) })), testClient())).status,
    413,
  );
  // Another site, a sibling subdomain, or a foreign Origin cannot report views.
  const foreign: Array<Record<string, string>> = [
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
    { Origin: "https://evil.example" },
    { Origin: "https://app.blast.fun", "Sec-Fetch-Site": "same-site" },
    { Origin: "null" },
  ];
  for (const headers of foreign) {
    assert.equal((await handler(post(JSON.stringify(COIN_VIEW), headers), testClient())).status, 403, JSON.stringify(headers));
  }
  // A streamed body without a length is cut off at the limit, not buffered whole.
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new TextEncoder().encode("x".repeat(512)));
    },
  });
  const streamed = new Request(`${ORIGIN}/api/launchpad/telemetry`, {
    method: "POST",
    body: endless,
    duplex: "half",
  } as RequestInit);
  assert.equal((await handler(streamed, testClient())).status, 413);
  assert.ok(pulled <= 4, `read ${pulled} chunks`);
  assert.equal(calls, 0, "nothing refused here reaches the rate limiter or storage");
  assert.ok(!lines.some((line) => line.includes(WALLET) || line.includes("did:privy")));
});

test("a body the client aborts mid-read is a 400, not a server error", async (t) => {
  metrics(t);
  const handler = createLaunchpadTelemetryRouteHandler({
    expectedOrigin: ORIGIN,
    verifyTradable: async () => assert.fail("nothing is read to verify"),
    emitter: createLaunchpadTelemetryEmitter(() => assert.fail("nothing is read to record")),
  });
  const aborted = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      controller.error(new Error("aborted"));
    },
  });
  const response = await handler(new Request(`${ORIGIN}/api/launchpad/telemetry`, {
    method: "POST",
    body: aborted,
    duplex: "half",
  } as RequestInit), testClient());
  assert.equal(response.status, 400);
});

test("a slow-drip body is abandoned at the read deadline", async (t) => {
  metrics(t);
  const handler = createLaunchpadTelemetryRouteHandler({
    bodyDeadlineMs: 50,
    expectedOrigin: ORIGIN,
    verifyTradable: async () => assert.fail("nothing is read in time to verify"),
    emitter: createLaunchpadTelemetryEmitter(() => assert.fail("nothing is read in time to record")),
  });
  let cancelled = false;
  const drip = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const started = performance.now();
  const response = await handler(new Request(`${ORIGIN}/api/launchpad/telemetry`, {
    method: "POST",
    body: drip,
    duplex: "half",
  } as RequestInit), testClient());
  assert.equal(response.status, 408);
  assert.ok(performance.now() - started < 1_000);
  assert.equal(cancelled, true);
});

test("a burst from one client beyond its rate bucket records nothing more and mints no visitor", async (t) => {
  metrics(t);
  const admitted: string[] = [];
  let recorded = 0;
  const handler = createLaunchpadTelemetryRouteHandler({
    createVisitorId: () => VISITOR,
    expectedOrigin: ORIGIN,
    verifyTradable: async () => "tradable",
    emitter: createLaunchpadTelemetryEmitter(() => ({
      admitOutcomeReport: async () => assert.fail("coin views never use the outcome bucket"),
      ...NO_OUTCOME_COMMITMENTS,
      admitCoinView: async (clientIp) => {
        admitted.push(clientIp);
        return admitted.filter((ip) => ip === clientIp).length <= 3 ? "allowed" : "limited";
      },
      recordCoinView: async () => {
        recorded += 1;
        return "recorded";
      },
      recordOutcome: async () => "recorded",
    })),
  });
  const statuses: number[] = [];
  for (let request = 0; request < 6; request += 1) {
    const response = await handler(post(JSON.stringify(COIN_VIEW)), testClient("203.0.113.7"));
    statuses.push(response.status);
    if (response.status === 429) assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.deepEqual(statuses, [204, 204, 204, 429, 429, 429]);
  assert.equal(recorded, 3);
  // Another client is unaffected.
  assert.equal((await handler(post(JSON.stringify(COIN_VIEW)), testClient("198.51.100.2"))).status, 204);
  assert.deepEqual([...new Set(admitted)], ["203.0.113.7", "198.51.100.2"]);
});

test("a failing rate limiter or store drops the beacon without recording or blocking", async (t) => {
  metrics(t);
  let recorded = 0;
  const limiterDown = createLaunchpadTelemetryRouteHandler({
    createVisitorId: () => VISITOR,
    expectedOrigin: ORIGIN,
    verifyTradable: async () => "tradable",
    emitter: createLaunchpadTelemetryEmitter(() => ({
      admitOutcomeReport: async () => assert.fail("coin views never use the outcome bucket"),
      ...NO_OUTCOME_COMMITMENTS,
      admitCoinView: async () => {
        throw new Error("RATE_LIMIT_SUBJECT_PEPPER is missing");
      },
      recordCoinView: async () => {
        recorded += 1;
        return "recorded";
      },
      recordOutcome: async () => "recorded",
    })),
  });
  const refused = await limiterDown(post(JSON.stringify(COIN_VIEW)), testClient());
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("set-cookie"), null);
  assert.equal(recorded, 0);

  const storageDown = createLaunchpadTelemetryRouteHandler({
    createVisitorId: () => VISITOR,
    expectedOrigin: ORIGIN,
    verifyTradable: async () => "tradable",
    emitter: createLaunchpadTelemetryEmitter(() =>
      sink(async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      })),
  });
  const response = await storageDown(post(JSON.stringify(COIN_VIEW)), testClient());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // An admitted visitor keeps one ID across the outage.
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${VISITOR_COOKIE_NAME}=${VISITOR};`));
});

test("only a coin the server verifies as tradable now is counted", async (t) => {
  const lines = metrics(t);
  const verified: string[] = [];
  let recorded = 0;
  let answer: "tradable" | "not-tradable" | "unavailable" = "not-tradable";
  let admitted = 0;
  const handler = createLaunchpadTelemetryRouteHandler({
    createVisitorId: () => VISITOR,
    expectedOrigin: ORIGIN,
    verifyTradable: async (launchId) => {
      verified.push(launchId);
      return answer;
    },
    emitter: createLaunchpadTelemetryEmitter(() => ({
      admitOutcomeReport: async () => assert.fail("coin views never use the outcome bucket"),
      ...NO_OUTCOME_COMMITMENTS,
      admitCoinView: async () => {
        admitted += 1;
        return admitted <= 3 ? "allowed" : "limited";
      },
      recordCoinView: async () => {
        recorded += 1;
        return "recorded";
      },
      recordOutcome: async () => "recorded",
    })),
  });

  const refused = await handler(post(JSON.stringify(COIN_VIEW)), testClient());
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get("set-cookie"), null, "no visitor is minted for a coin that is not tradable");
  answer = "unavailable";
  const unknown = await handler(post(JSON.stringify(COIN_VIEW)), testClient());
  assert.equal(unknown.status, 503);
  assert.equal(unknown.headers.get("set-cookie"), null);
  assert.equal(recorded, 0);
  answer = "tradable";
  assert.equal((await handler(post(JSON.stringify(COIN_VIEW)), testClient())).status, 204);
  assert.equal(recorded, 1);
  assert.deepEqual(verified, [LAUNCH_ID, LAUNCH_ID, LAUNCH_ID]);

  // The rate bucket is checked first: a limited client costs no chain or index read.
  assert.equal((await handler(post(JSON.stringify(COIN_VIEW)), testClient())).status, 429);
  assert.equal(verified.length, 3);
  assert.ok(lines.some((line) => line.includes('"result":"rejected"') && line.includes("not-tradable")));
});

test("the browser reports a tradable coin view once per page, fire-and-forget", () => {
  const beacons: Array<{ url: string; body: string }> = [];
  const reporter = createCoinViewReporter({
    sendBeacon: (url, body) => {
      beacons.push({ url, body });
      return true;
    },
    fetch: () => assert.fail("a queued beacon needs no fetch"),
  });
  // Rendering the same tradable coin twice reports it once.
  assert.equal(reporter.report(LAUNCH_ID), undefined);
  reporter.report(LAUNCH_ID);
  assert.deepEqual(beacons, [{ url: LAUNCHPAD_TELEMETRY_PATH, body: JSON.stringify(COIN_VIEW) }]);
  // Nothing is sent for a value that is not a canonical launch ID.
  reporter.report(WALLET.toUpperCase());
  reporter.report("pilot_one");
  assert.equal(beacons.length, 1);
});

test("browser telemetry failures never reach the page", async () => {
  const sent: RequestInit[] = [];
  // No beacon queue: fetch with keepalive, whose rejection is swallowed.
  const refused = createCoinViewReporter({
    sendBeacon: () => false,
    fetch: async (_url, init) => {
      sent.push(init);
      throw new TypeError("Failed to fetch");
    },
  });
  refused.report(LAUNCH_ID);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, "POST");
  assert.equal(sent[0]?.keepalive, true);
  assert.equal(sent[0]?.credentials, "same-origin");
  assert.equal(sent[0]?.body, JSON.stringify(COIN_VIEW));

  const throwing = createCoinViewReporter({
    sendBeacon: () => {
      throw new Error("beacon blocked");
    },
    fetch: () => {
      throw new Error("fetch blocked");
    },
  });
  assert.doesNotThrow(() => throwing.report(LAUNCH_ID));
  // Without any transport (server render, old browser) it does nothing.
  assert.doesNotThrow(() => createCoinViewReporter({}).report(LAUNCH_ID));
});
