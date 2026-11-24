import { fixtureOriginClient } from "../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { NON_PRODUCTION_MANIFEST } from "../../../../../packages/core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";
import { createFixtureLandingHandler } from "../../../test/fixtures/modules/launchpad-coin/fixture-landing.ts";
import { startCoinFixtureServer } from "../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixture-server.ts";
import {
  LAUNCHPAD_OUTCOME_COMMITMENTS_PATH,
  LAUNCHPAD_OUTCOMES_PATH,
  OUTCOME_RETRY_DELAY_MS,
  commitSignedOutcome,
  createOutcomeCommitter,
  createVerifiedOutcomeReporter,
  reportVerifiedOutcome,
} from "./client.ts";
import { parseCompletedOutcome, parseOutcomeReport, parseVisitorId, type CompletedOutcome } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import { createLaunchpadTelemetryEmitter, type LaunchpadTelemetrySink } from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import { OUTCOME_FIXTURE, createOutcomeFixtureNode, outcomeFixtureTransactions, outcomeTransactionWire } from "../../../../../packages/core/test/fixtures/modules/launchpad-telemetry/outcome-fixtures.ts";
import {
  createLaunchpadOutcomeCommitmentRouteHandler,
  createLaunchpadOutcomeRouteHandler,
  createOutcomeVerifier,
  type LaunchpadOutcomeRouteDependencies,
  type OutcomeVerifier,
} from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import { VISITOR_COOKIE_NAME } from "@blast/server/modules/launchpad-telemetry/route.ts";
import { testClient } from "../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

const { launchId, digests, senders } = OUTCOME_FIXTURE;
const COMPLETED_AT = new Date(OUTCOME_FIXTURE.timestampMs).toISOString();

function verifierOn(node = createOutcomeFixtureNode(), options: Parameters<typeof createOutcomeVerifier>[1] = {}) {
  return createOutcomeVerifier(async () => ({ client: node.client, manifest: NON_PRODUCTION_MANIFEST }), options);
}

test("a completed launch's creation digest verifies to its LaunchShared, with the event's sender, position and time", async () => {
  const verify = verifierOn();
  assert.deepEqual(await verify({ kind: "launch", launchId, txDigest: digests.launch }), {
    status: "verified",
    senderWallet: senders.creator,
    completion: {
      status: "completed",
      checkpoint: OUTCOME_FIXTURE.checkpoint,
      txDigest: digests.launch,
      eventSeq: 1,
      completedAt: COMPLETED_AT,
    },
  });
});

test("a completed Bought verifies as a buy; the opening round's settlement buy never does", async () => {
  const verify = verifierOn();
  assert.deepEqual(await verify({ kind: "buy", launchId, txDigest: digests.buy }), {
    status: "verified",
    senderWallet: senders.buyer,
    completion: { status: "completed", checkpoint: OUTCOME_FIXTURE.checkpoint, txDigest: digests.buy, eventSeq: 0, completedAt: COMPLETED_AT },
  });
  assert.deepEqual(await verify({ kind: "buy", launchId, txDigest: digests.settlement }), { status: "refused", reason: "settlement-buy" });
  // A bidder's own buy after the settlement in the same transaction counts; the pot's does not.
  const after = await verify({ kind: "buy", launchId, txDigest: digests.settlementThenBuy });
  assert.equal(after.status, "verified");
  assert.equal(after.status === "verified" && after.completion.eventSeq, 2);
});

test("a Sold, a failed, unknown, uncheckpointed, foreign-lineage or other launch's transaction is refused with a bounded reason", async () => {
  const verify = verifierOn();
  const refusals = {
    sold: ["buy", digests.sold, "not-a-buy"],
    failed: ["buy", digests.failed, "failed"],
    unknown: ["buy", digests.unknown, "unknown-transaction"],
    uncheckpointed: ["buy", digests.uncheckpointed, "not-checkpointed"],
    foreignBuy: ["buy", digests.foreign, "foreign-lineage"],
    foreignLaunch: ["launch", digests.foreign, "foreign-lineage"],
    otherBuy: ["buy", digests.otherLaunch, "other-launch"],
    otherLaunch: ["launch", digests.otherLaunch, "other-launch"],
    buyAsLaunch: ["launch", digests.buy, "not-a-launch"],
    launchAsBuy: ["buy", digests.launch, "not-a-buy"],
  } as const;
  for (const [label, [kind, txDigest, reason]] of Object.entries(refusals)) {
    assert.deepEqual(await verify({ kind, launchId, txDigest }), { status: "refused", reason }, label);
  }
});

test("node reads are bounded: unconfigured, wrong-chain, unreachable, slow and saturated nodes answer retry-later", async () => {
  const report = { kind: "buy", launchId, txDigest: digests.buy } as const;
  assert.deepEqual(await createOutcomeVerifier(async () => null)(report), { status: "unavailable", reason: "node-unconfigured" });
  assert.deepEqual(await verifierOn(createOutcomeFixtureNode({ chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD" }))(report), {
    status: "unavailable",
    reason: "wrong-network",
  });
  assert.deepEqual(await verifierOn(createOutcomeFixtureNode({ reads: "down" }))(report), { status: "unavailable", reason: "node-unavailable" });

  const slow = createOutcomeFixtureNode({ reads: "hang" });
  const started = performance.now();
  assert.deepEqual(await verifierOn(slow, { timeoutMs: 50 })(report), { status: "unavailable", reason: "node-unavailable" });
  assert.ok(performance.now() - started < 1_000, "a stalled node is abandoned at the read budget");

  // Reads past the concurrency bound are refused at once, never queued.
  const busy = createOutcomeFixtureNode({ reads: "hang" });
  const verify = verifierOn(busy, { timeoutMs: 200, maxConcurrent: 2 });
  const inFlight = [verify(report), verify(report)];
  assert.deepEqual(await verify(report), { status: "unavailable", reason: "node-busy" });
  await Promise.all(inFlight);
  busy.state.reads = "available";
  assert.equal((await verify(report)).status, "verified", "a slot frees when its read ends");
});

const ORIGIN = "https://blast.fun";
const VISITOR = "3f0c8f5e-2a47-4c1b-9d7e-5b8a1c2d3e4f";
const WALLET = `0x${"c0".repeat(32)}`;
const SAME_ORIGIN = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", Cookie: `${VISITOR_COOKIE_NAME}=${VISITOR}` };

function metrics(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  return lines;
}

function report(body: unknown, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(`${ORIGIN}/api/launchpad/outcomes`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/**
 * An outcome store that keeps one outcome per completed event, as the table's
 * key does, and writes a visitor link only onto an outcome that has none.
 */
function memoryStore(overrides: Partial<LaunchpadTelemetrySink> = {}) {
  const outcomes = new Map<string, CompletedOutcome>();
  const commitments = new Map<string, { visitorId: string; kind: string; launchId: string }>();
  const receipts: Array<Date | undefined> = [];
  const calls = { admitted: 0, commitmentsAdmitted: 0 };
  const sink: LaunchpadTelemetrySink = {
    admitCoinView: async () => assert.fail("outcome reports have their own bucket"),
    admitOutcomeReport: async () => {
      calls.admitted += 1;
      return "allowed";
    },
    admitOutcomeCommitment: async () => {
      calls.commitmentsAdmitted += 1;
      return "allowed";
    },
    recordOutcomeCommitment: async (visitorId, input, receivedAt) => {
      const { kind, launchId, txDigest } = parseOutcomeReport(input);
      const key = `${txDigest}:${parseVisitorId(visitorId)}`;
      if (commitments.has(key)) return "duplicate";
      commitments.set(key, { visitorId: visitorId as string, kind, launchId });
      receipts.push(receivedAt);
      return "recorded";
    },
    recordCoinView: async () => assert.fail("no coin view here"),
    recordOutcome: async (input) => {
      const outcome = parseCompletedOutcome(input);
      const key = `${outcome.completion.txDigest}:${outcome.completion.eventSeq}`;
      const stored = outcomes.get(key);
      if (!stored) {
        outcomes.set(key, outcome);
        return "recorded";
      }
      if (stored.visitorId === null && outcome.visitorId !== null) {
        outcomes.set(key, { ...stored, visitorId: outcome.visitorId, visitorLink: outcome.visitorLink });
      }
      return "duplicate";
    },
    ...overrides,
  };
  return { outcomes, commitments, receipts, calls, emitter: createLaunchpadTelemetryEmitter(() => sink) };
}

function handlerWith(
  store: ReturnType<typeof memoryStore>,
  verify: OutcomeVerifier = verifierOn(),
  privy: Partial<Pick<LaunchpadOutcomeRouteDependencies, "verifyPrivySession" | "privyTimeoutMs">> = {},
) {
  return createLaunchpadOutcomeRouteHandler({ expectedOrigin: ORIGIN, emitter: store.emitter, verify, ...privy });
}

/** A fixture Privy verifier: each known token is a session whose embedded wallet is the one named. */
function privySessions(sessions: Readonly<Record<string, string | null>>) {
  const calls: string[] = [];
  const verifyPrivySession = async (accessToken: string) => {
    calls.push(accessToken);
    if (!Object.hasOwn(sessions, accessToken)) throw Object.assign(new Error(`invalid token ${accessToken}`), { code: "INVALID_ACCESS_TOKEN" });
    return { suiWalletAddress: sessions[accessToken]! };
  };
  return { calls, verifyPrivySession };
}

async function answer(response: Response) {
  const body = await response.json() as Record<string, unknown>;
  if (response.status >= 400) {
    assert.ok(response.headers.get("x-request-id"), "refusals have a support reference");
    assert.ok(body.error && typeof body.error === "object", "refusals have a structured safe error");
    delete body.error;
  }
  return { status: response.status, body, cache: response.headers.get("cache-control") };
}

test("a same-origin report of a completed launch records one launch outcome; a repeat is a duplicate", async (t) => {
  metrics(t);
  const store = memoryStore();
  const handler = handlerWith(store);
  const body = { kind: "launch", launchId, txDigest: digests.launch };
  assert.deepEqual(await answer(await handler(report(body), testClient())), { status: 201, body: { result: "recorded" }, cache: "no-store" });
  assert.deepEqual(await answer(await handler(report(body), testClient())), { status: 200, body: { result: "duplicate" }, cache: "no-store" });
  assert.deepEqual([...store.outcomes.values()], [
    {
      kind: "launch",
      launchId,
      senderWallet: senders.creator,
      visitorId: null,
      completion: { status: "completed", checkpoint: OUTCOME_FIXTURE.checkpoint, txDigest: digests.launch, eventSeq: 1, completedAt: COMPLETED_AT },
    },
  ]);
});

test("a report is attributed to its event's sender whoever reports it: no cookie, another visitor or a repeat never links the reporter", async (t) => {
  const lines = metrics(t);
  const store = memoryStore();
  const handler = handlerWith(store);
  const body = { kind: "buy", launchId, txDigest: digests.buy };
  const OTHER = "9d2c1b0a-8f7e-4d6c-ab5a-4f3e2d1c0b9a";
  // No visitor cookie at all: verified and recorded wallet-only, never refused.
  const cookieless = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
  assert.deepEqual(await answer(await handler(report(body, cookieless), testClient())), { status: 201, body: { result: "recorded" }, cache: "no-store" });
  // Another visitor, the sender's own visitor and a malformed cookie report it again: duplicates, nothing changes.
  for (const cookie of [OTHER, VISITOR, WALLET]) {
    const response = await answer(await handler(report(body, { ...cookieless, Cookie: `${VISITOR_COOKIE_NAME}=${cookie}` }), testClient()));
    assert.deepEqual(response, { status: 200, body: { result: "duplicate" }, cache: "no-store" }, cookie);
  }
  assert.deepEqual([...store.outcomes.values()], [
    {
      kind: "buy",
      launchId,
      senderWallet: senders.buyer,
      visitorId: null,
      completion: { status: "completed", checkpoint: OUTCOME_FIXTURE.checkpoint, txDigest: digests.buy, eventSeq: 0, completedAt: COMPLETED_AT },
    },
  ]);
  for (const line of lines) {
    for (const value of [launchId, VISITOR, OTHER, senders.buyer, digests.buy]) assert.ok(!line.includes(value), line);
  }
});

test("a completed Bought records one buy outcome; settlement, Sold, failed, unknown, foreign, other-launch and uncheckpointed reports record nothing", async (t) => {
  const lines = metrics(t);
  const store = memoryStore();
  const handler = handlerWith(store);
  assert.deepEqual(await answer(await handler(report({ kind: "buy", launchId, txDigest: digests.buy }), testClient())), {
    status: 201,
    body: { result: "recorded" },
    cache: "no-store",
  });
  const refused = {
    settlement: [digests.settlement, "settlement-buy"],
    sold: [digests.sold, "not-a-buy"],
    failed: [digests.failed, "failed"],
    unknown: [digests.unknown, "unknown-transaction"],
    foreign: [digests.foreign, "foreign-lineage"],
    other: [digests.otherLaunch, "other-launch"],
    uncheckpointed: [digests.uncheckpointed, "not-checkpointed"],
  } as const;
  for (const [label, [txDigest, reason]] of Object.entries(refused)) {
    const response = await answer(await handler(report({ kind: "buy", launchId, txDigest }), testClient()));
    assert.deepEqual(response, { status: 422, body: { reason }, cache: "no-store" }, label);
  }
  // A node on another network: retry-later, nothing recorded.
  const wrongNetwork = handlerWith(store, verifierOn(createOutcomeFixtureNode({ chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD" })));
  assert.deepEqual(await answer(await wrongNetwork(report({ kind: "buy", launchId, txDigest: digests.buy }), testClient())), {
    status: 503,
    body: { reason: "wrong-network" },
    cache: "no-store",
  });
  assert.deepEqual([...store.outcomes.values()].map((outcome) => [outcome.kind, outcome.completion.txDigest, outcome.completion.eventSeq]), [
    ["buy", digests.buy, 0],
  ]);
  // Metrics carry the event, result, reason and kind only: no digest, launch, visitor or wallet.
  for (const line of lines) {
    for (const value of [launchId, VISITOR, WALLET, ...Object.values(digests)]) assert.ok(!line.includes(value), line);
  }
});

test("a verified Privy session for the sender links the reporting visitor; another wallet, a bad token, an outage or no cookie never does", async (t) => {
  const lines = metrics(t);
  const OTHER = "9d2c1b0a-8f7e-4d6c-ab5a-4f3e2d1c0b9a";
  const privy = privySessions({ "token-sender": senders.creator, "token-other": senders.buyer, "token-walletless": null });
  const store = memoryStore();
  const handler = handlerWith(store, verifierOn(), { verifyPrivySession: privy.verifyPrivySession });
  const body = { kind: "launch", launchId, txDigest: digests.launch };
  const stored = () => {
    const [outcome] = store.outcomes.values();
    return outcome && { visitorId: outcome.visitorId, visitorLink: outcome.visitorLink, senderWallet: outcome.senderWallet };
  };
  const as = (token: string | null, visitor: string | null, header = token === null ? null : `Bearer ${token}`) =>
    report(body, {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      ...(visitor ? { Cookie: `${VISITOR_COOKIE_NAME}=${visitor}` } : {}),
      ...(header === null ? {} : { Authorization: header }),
    });

  // A token for another wallet, a walletless session or an invalid token: recorded, not linked.
  assert.equal((await handler(as("token-other", VISITOR), testClient())).status, 201);
  assert.equal((await handler(as("token-walletless", VISITOR), testClient())).status, 200);
  assert.equal((await handler(as("token-forged", VISITOR), testClient())).status, 200);
  // The sender's own session without a visitor cookie has no visitor to link.
  assert.equal((await handler(as("token-sender", null), testClient())).status, 200);
  // Malformed credentials are ignored, never refused, and never reach Privy.
  for (const header of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer ", `Bearer ${"x".repeat(9_000)}`, "bearer token-sender"]) {
    assert.equal((await handler(as(null, VISITOR, header), testClient())).status, 200, header.slice(0, 20));
  }
  assert.deepEqual(stored(), { visitorId: null, visitorLink: undefined, senderWallet: senders.creator });
  assert.deepEqual(privy.calls, ["token-other", "token-walletless", "token-forged"], "Privy is asked only with a token and a visitor");

  // The sender's own Privy session from a browser with a visitor: that visitor is linked.
  assert.deepEqual(await answer(await handler(as("token-sender", VISITOR), testClient())), { status: 200, body: { result: "duplicate" }, cache: "no-store" });
  assert.deepEqual(stored(), { visitorId: VISITOR, visitorLink: "privy_session", senderWallet: senders.creator });
  // An existing link is never replaced, even by another of the sender's own sessions.
  assert.equal((await handler(as("token-sender", OTHER), testClient())).status, 200);
  assert.deepEqual(stored(), { visitorId: VISITOR, visitorLink: "privy_session", senderWallet: senders.creator });
  // Each Privy check that links no one is a bounded metric: another wallet, no wallet, or a failure.
  const privyMetrics = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((metric) => metric.event === "outcome_privy")
    .map(({ result, reason }) => `${result}:${reason}`);
  assert.deepEqual(privyMetrics, ["rejected:other-wallet", "rejected:no-wallet", "dropped:INVALID_ACCESS_TOKEN"]);
  // Tokens, wallets and visitors never reach a metric.
  for (const line of lines) {
    for (const value of ["token-", "Bearer", "dXNlcjpwYXNz", VISITOR, OTHER, senders.creator, digests.launch]) assert.ok(!line.includes(value), line);
  }
});

test("a Privy outage or a stalled Privy answer records the outcome wallet-only within the Privy budget", async (t) => {
  metrics(t);
  const body = { kind: "buy", launchId, txDigest: digests.buy };
  const down = memoryStore();
  const outage = handlerWith(down, verifierOn(), {
    verifyPrivySession: async () => Promise.reject(Object.assign(new Error("privy down"), { code: "PROVIDER_UNAVAILABLE" })),
  });
  assert.equal((await outage(report(body, { ...SAME_ORIGIN, Authorization: "Bearer token-sender" }), testClient())).status, 201);
  assert.equal([...down.outcomes.values()][0]?.visitorId, null);

  const stalled = memoryStore();
  const hanging = handlerWith(stalled, verifierOn(), { verifyPrivySession: () => new Promise(() => {}), privyTimeoutMs: 50 });
  const started = performance.now();
  assert.equal((await hanging(report(body, { ...SAME_ORIGIN, Authorization: "Bearer token-sender" }), testClient())).status, 201);
  assert.ok(performance.now() - started < 1_000, "a stalled Privy answer is abandoned at its budget");
  assert.equal([...stalled.outcomes.values()][0]?.visitorId, null);
});

test("guards refuse foreign, malformed, oversized, extra-field and rate-limited reports before any node read or write", async (t) => {
  const lines = metrics(t);
  let verified = 0;
  const counting: OutcomeVerifier = async (input) => {
    verified += 1;
    return verifierOn()(input);
  };
  let limited = false;
  const store = memoryStore({ admitOutcomeReport: async () => (limited ? "limited" : "allowed") });
  const handler = handlerWith(store, counting);
  const body = { kind: "buy", launchId, txDigest: digests.buy };
  const cases: Array<[string, Request, number, string]> = [
    ["cross-site", report(body, { ...SAME_ORIGIN, "Sec-Fetch-Site": "cross-site" }), 403, "origin"],
    ["sibling", report(body, { ...SAME_ORIGIN, "Sec-Fetch-Site": "same-site" }), 403, "origin"],
    ["foreign origin", report(body, { ...SAME_ORIGIN, Origin: "https://evil.example" }), 403, "origin"],
    ["text body", report(body, { ...SAME_ORIGIN, "Content-Type": "text/plain;charset=UTF-8" }), 415, "content-type"],
    ["not json", report("{not json"), 400, "malformed"],
    ["oversized", report({ ...body, pad: "x".repeat(2_048) }), 413, "too-large"],
    ["extra field", report({ ...body, wallet: WALLET }), 400, "shape"],
    ["client time", report({ ...body, completedAt: "2026-10-01T00:00:00.000Z" }), 400, "shape"],
    ["migration", report({ ...body, kind: "migration" }), 400, "event"],
    ["launch id", report({ ...body, launchId: WALLET.toUpperCase() }), 400, "launch-id"],
    ["digest", report({ ...body, txDigest: "did:privy:cm0abc" }), 400, "digest"],
  ];
  for (const [label, request, status, reason] of cases) {
    assert.deepEqual(await answer(await handler(request, testClient())), { status, body: { reason }, cache: "no-store" }, label);
  }
  assert.equal(store.calls.admitted, 0, "nothing refused so far reached the rate limiter");
  limited = true;
  assert.deepEqual(await answer(await handler(report(body), testClient())), { status: 429, body: { reason: "rate-limited" }, cache: "no-store" });
  assert.equal(verified, 0, "no refused report read the node");
  assert.equal(store.outcomes.size, 0);
  for (const line of lines) {
    for (const value of [launchId, VISITOR, WALLET, digests.buy, "did:privy", "evil.example"]) assert.ok(!line.includes(value), line);
  }
});

test("an unconfigured or unreachable node, a failing limiter and a storage outage answer retry-later without recording", async (t) => {
  metrics(t);
  const body = { kind: "launch", launchId, txDigest: digests.launch };
  const unconfigured = handlerWith(memoryStore(), createOutcomeVerifier(async () => null));
  assert.deepEqual(await answer(await unconfigured(report(body), testClient())), { status: 503, body: { reason: "node-unconfigured" }, cache: "no-store" });
  const down = handlerWith(memoryStore(), verifierOn(createOutcomeFixtureNode({ reads: "down" })));
  assert.deepEqual(await answer(await down(report(body), testClient())), { status: 503, body: { reason: "node-unavailable" }, cache: "no-store" });

  const limiterDown = memoryStore({ admitOutcomeReport: async () => Promise.reject(new Error("database down")) });
  assert.deepEqual(await answer(await handlerWith(limiterDown)(report(body), testClient())), {
    status: 503,
    body: { reason: "limiter-unavailable" },
    cache: "no-store",
  });

  const storageDown = memoryStore({ recordOutcome: async () => Promise.reject(Object.assign(new Error("gone"), { code: "57P01" })) });
  assert.deepEqual(await answer(await handlerWith(storageDown)(report(body), testClient())), {
    status: 503,
    body: { reason: "storage-unavailable" },
    cache: "no-store",
  });
  for (const store of [limiterDown, storageDown]) assert.equal(store.outcomes.size, 0);
});

test("the browser reporter sends one exact report per completed event, fire-and-forget, and never throws", async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const reporter = createVerifiedOutcomeReporter({
    fetch: (url, init) => {
      sent.push({ url, init });
      return Promise.reject(new Error("offline"));
    },
  });
  const launch = { kind: "launch", launchId, txDigest: digests.launch } as const;
  assert.equal(reporter.report(launch), undefined, "nothing to await");
  reporter.report(launch);
  reporter.report({ kind: "buy", launchId, txDigest: digests.buy });
  // Invalid input is never sent: no private value can leave through the reporter.
  reporter.report({ kind: "launch", launchId: WALLET.toUpperCase(), txDigest: digests.launch });
  reporter.report({ kind: "launch", launchId, txDigest: "did:privy:cm0abc" });
  reporter.report({ kind: "migration", launchId, txDigest: digests.launch } as never);
  assert.deepEqual(
    sent.map(({ url, init }) => [url, init.method, init.credentials, init.keepalive, (init.headers as Record<string, string>)["Content-Type"], init.body]),
    [
      [LAUNCHPAD_OUTCOMES_PATH, "POST", "same-origin", true, "application/json", JSON.stringify(launch)],
      [LAUNCHPAD_OUTCOMES_PATH, "POST", "same-origin", true, "application/json", JSON.stringify({ kind: "buy", launchId, txDigest: digests.buy })],
    ],
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const throwing = createVerifiedOutcomeReporter({
    fetch: () => {
      throw new Error("blocked");
    },
  });
  assert.doesNotThrow(() => throwing.report(launch));
  // On the server there is no browser to report from.
  assert.doesNotThrow(() => reportVerifiedOutcome(launch));
});

test("an injected fixture node verifies outcomes; production configuration never selects it", async (t) => {
  const fixture = await startCoinFixtureServer();
  t.after(() => fixture.close());
  const verify = createOutcomeVerifier(async () => ({client: fixtureOriginClient(fixture.origin), manifest: NON_PRODUCTION_MANIFEST}));
  assert.deepEqual(await verify({ kind: "launch", launchId, txDigest: digests.launch }), {
    status: "verified",
    senderWallet: senders.creator,
    completion: { status: "completed", checkpoint: OUTCOME_FIXTURE.checkpoint, txDigest: digests.launch, eventSeq: 1, completedAt: COMPLETED_AT },
  });
  assert.equal((await verify({ kind: "buy", launchId, txDigest: digests.buy })).status, "verified");
  assert.deepEqual(await verify({ kind: "buy", launchId, txDigest: digests.settlement }), { status: "refused", reason: "settlement-buy" });
  assert.deepEqual(await verify({ kind: "buy", launchId, txDigest: digests.unknown }), { status: "refused", reason: "unknown-transaction" });
  fixture.state.fresh = "down";
  assert.deepEqual(await verify({ kind: "buy", launchId, txDigest: digests.buy }), { status: "unavailable", reason: "node-unavailable" });
  fixture.state.fresh = "live";
  fixture.state.chain = "other";
  // A fresh verifier checks the node's chain again.
  assert.deepEqual(await createOutcomeVerifier(async () => ({client: fixtureOriginClient(fixture.origin), manifest: NON_PRODUCTION_MANIFEST}))({ kind: "buy", launchId, txDigest: digests.buy }), {
    status: "unavailable",
    reason: "wrong-network",
  });
  // Production configuration reads through the configured node, never the fixture: launchpad-coin.test.ts.
});

test("a development harness can land its own completed transaction on the dev fixture node for the server to verify", async (t) => {
  const fixture = await startCoinFixtureServer();
  t.after(() => fixture.close());
  const verify = createOutcomeVerifier(async () => ({client: fixtureOriginClient(fixture.origin), manifest: NON_PRODUCTION_MANIFEST}));
  const harnessDigest = "Hq2nWvZ8jYc7fT1pD4sXbR6mK9eL3gA5uN8wV2yQ7tBz";
  const transaction = { ...outcomeFixtureTransactions().get(digests.launch)!, digest: harnessDigest };
  assert.deepEqual(await verify({ kind: "launch", launchId, txDigest: harnessDigest }), { status: "refused", reason: "unknown-transaction" });
  const landed = await fetch(new URL("/__fixture/transactions", fixture.origin), {
    method: "POST",
    body: JSON.stringify(outcomeTransactionWire(transaction)),
  });
  assert.equal(landed.status, 204);
  const verdict = await verify({ kind: "launch", launchId, txDigest: harnessDigest });
  assert.equal(verdict.status === "verified" && verdict.completion.txDigest, harnessDigest);
  const refused = await fetch(new URL("/__fixture/transactions", fixture.origin), { method: "POST", body: "{" });
  assert.equal(refused.status, 400);
});

test("the node's chain is checked once per node and process, and again after it answered for another chain", async () => {
  const report = { kind: "buy", launchId, txDigest: digests.buy } as const;
  const node = createOutcomeFixtureNode({ chainIdentifier: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD" });
  const verify = verifierOn(node);
  assert.deepEqual(await verify(report), { status: "unavailable", reason: "wrong-network" });
  assert.deepEqual(await verify(report), { status: "unavailable", reason: "wrong-network" });
  assert.equal(node.chainReads(), 2, "a node on another chain is never cached");
  node.state.chainIdentifier = NON_PRODUCTION_MANIFEST.chainIdentifier;
  assert.equal((await verify(report)).status, "verified");
  assert.equal((await verify(report)).status, "verified");
  assert.equal(node.chainReads(), 3, "a matching node is checked once");
  assert.equal(node.reads(), 2);
});

test("a retry-later (503) answer is retried once after a jittered delay; any other answer never is", async () => {
  const flush = async () => {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  function harness(statuses: number[]) {
    const sent: number[] = [];
    const delays: number[] = [];
    const timers: Array<() => void> = [];
    const reporter = createVerifiedOutcomeReporter(
      {
        fetch: async () => {
          sent.push(sent.length);
          return new Response(null, { status: statuses[Math.min(sent.length - 1, statuses.length - 1)]! });
        },
      },
      {
        random: () => 0.5,
        setTimer: (run, ms) => {
          delays.push(ms);
          timers.push(run);
        },
      },
    );
    return { reporter, sent, delays, timers };
  }
  const report = { kind: "launch", launchId, txDigest: digests.launch } as const;

  const unavailable = harness([503, 503, 503]);
  unavailable.reporter.report(report);
  await flush();
  assert.equal(unavailable.sent.length, 1, "nothing is retried before the delay");
  assert.equal(unavailable.delays.length, 1);
  assert.ok(unavailable.delays[0]! >= OUTCOME_RETRY_DELAY_MS.min && unavailable.delays[0]! <= OUTCOME_RETRY_DELAY_MS.max);
  unavailable.timers.shift()!();
  await flush();
  assert.equal(unavailable.sent.length, 2, "one retry");
  assert.equal(unavailable.timers.length, 0, "a second 503 is not retried again");

  for (const status of [201, 200, 400, 422, 429]) {
    const settled = harness([status]);
    settled.reporter.report(report);
    await flush();
    assert.deepEqual([settled.sent.length, settled.delays.length], [1, 0], String(status));
  }

  // A throwing timer or a failing retry never reaches the caller.
  const broken = createVerifiedOutcomeReporter(
    { fetch: async () => new Response(null, { status: 503 }) },
    { setTimer: () => {
      throw new Error("no timers");
    } },
  );
  assert.doesNotThrow(() => broken.report(report));
  await flush();
});

test("a development server lands a harness transaction on its fixture node through a same-origin route", async (t) => {
  const fixture = await startCoinFixtureServer();
  t.after(() => fixture.close());
  const harnessDigest = "Hq2nWvZ8jYc7fT1pD4sXbR6mK9eL3gA5uN8wV2yQ7tBz";
  const wire = outcomeTransactionWire({ ...outcomeFixtureTransactions().get(digests.launch)!, digest: harnessDigest });
  const land = (body: unknown, headers: Record<string, string> = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }) =>
    new Request(`${ORIGIN}/dev/launchpad/launch/fixture-transactions`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...headers },
    });
  const handler = createFixtureLandingHandler({ fixtureOrigin: fixture.origin, expectedOrigin: ORIGIN });

  assert.deepEqual(await answer(await handler(land(wire, { Origin: "https://evil.example" }))), { status: 403, body: { reason: "origin" }, cache: "no-store" });
  assert.deepEqual(await answer(await handler(land("{"))), { status: 400, body: { reason: "malformed" }, cache: "no-store" });
  assert.deepEqual(await answer(await handler(land({ digest: harnessDigest }))), { status: 400, body: { reason: "malformed" }, cache: "no-store" });
  const unconfigured = createFixtureLandingHandler({ fixtureOrigin: null, expectedOrigin: ORIGIN });
  assert.deepEqual(await answer(await unconfigured(land(wire))), { status: 503, body: { reason: "no-fixture-node" }, cache: "no-store" });
  const unreachable = createFixtureLandingHandler({ fixtureOrigin: "http://127.0.0.1:1", expectedOrigin: ORIGIN });
  assert.deepEqual(await answer(await unreachable(land(wire))), { status: 502, body: { reason: "fixture-node-unavailable" }, cache: "no-store" });

  const verify = createOutcomeVerifier(async () => ({client: fixtureOriginClient(fixture.origin), manifest: NON_PRODUCTION_MANIFEST}));
  assert.deepEqual(await verify({ kind: "launch", launchId, txDigest: harnessDigest }), { status: "refused", reason: "unknown-transaction" });
  assert.deepEqual(await answer(await handler(land(wire))), { status: 200, body: { result: "landed" }, cache: "no-store" });
  assert.equal((await verify({ kind: "launch", launchId, txDigest: harnessDigest })).status, "verified");
});

function commitment(body: unknown, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(`${ORIGIN}/api/launchpad/outcomes/commitments`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("a visitor's digest commitment is stored once with no node read; without a visitor nothing is stored or minted", async (t) => {
  const lines = metrics(t);
  const store = memoryStore();
  const handler = createLaunchpadOutcomeCommitmentRouteHandler({ expectedOrigin: ORIGIN, emitter: store.emitter });
  const body = { kind: "launch", launchId, txDigest: digests.launch };
  assert.deepEqual(await answer(await handler(commitment(body), testClient())), { status: 201, body: { result: "recorded" }, cache: "no-store" });
  assert.deepEqual(await answer(await handler(commitment(body), testClient())), { status: 200, body: { result: "duplicate" }, cache: "no-store" });
  const cookieless = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" };
  for (const headers of [cookieless, { ...cookieless, Cookie: `${VISITOR_COOKIE_NAME}=${WALLET}` }]) {
    const response = await handler(commitment({ ...body, txDigest: digests.buy }, headers), testClient());
    assert.deepEqual(await answer(response), { status: 422, body: { reason: "no-visitor" }, cache: "no-store" });
    assert.equal(response.headers.get("set-cookie"), null, "a commitment never mints a visitor");
  }
  assert.deepEqual([...store.commitments.entries()], [[`${digests.launch}:${VISITOR}`, { visitorId: VISITOR, kind: "launch", launchId }]]);
  assert.equal(store.calls.commitmentsAdmitted, 2, "a cookieless commitment spends no rate bucket");
  assert.equal(store.outcomes.size, 0, "a commitment records no outcome");
  for (const line of lines) {
    for (const value of [launchId, VISITOR, WALLET, digests.launch, digests.buy]) assert.ok(!line.includes(value), line);
  }
});

test("commitment guards refuse foreign, malformed, oversized, extra-field and rate-limited requests, and outages store nothing", async (t) => {
  const lines = metrics(t);
  let limited = false;
  const store = memoryStore({ admitOutcomeCommitment: async () => (limited ? "limited" : "allowed") });
  const handler = createLaunchpadOutcomeCommitmentRouteHandler({ expectedOrigin: ORIGIN, emitter: store.emitter });
  const body = { kind: "buy", launchId, txDigest: digests.buy };
  const cases: Array<[string, Request, number, string]> = [
    ["cross-site", commitment(body, { ...SAME_ORIGIN, "Sec-Fetch-Site": "cross-site" }), 403, "origin"],
    ["foreign origin", commitment(body, { ...SAME_ORIGIN, Origin: "https://evil.example" }), 403, "origin"],
    ["text body", commitment(body, { ...SAME_ORIGIN, "Content-Type": "text/plain;charset=UTF-8" }), 415, "content-type"],
    ["not json", commitment("{not json"), 400, "malformed"],
    ["oversized", commitment({ ...body, pad: "x".repeat(2_048) }), 413, "too-large"],
    ["extra field", commitment({ ...body, wallet: WALLET }), 400, "shape"],
    ["client time", commitment({ ...body, committedAt: "2026-10-01T00:00:00.000Z" }), 400, "shape"],
    ["migration", commitment({ ...body, kind: "migration" }), 400, "event"],
    ["launch id", commitment({ ...body, launchId: WALLET.toUpperCase() }), 400, "launch-id"],
    ["digest", commitment({ ...body, txDigest: "did:privy:cm0abc" }), 400, "digest"],
  ];
  for (const [label, request, status, reason] of cases) {
    assert.deepEqual(await answer(await handler(request, testClient())), { status, body: { reason }, cache: "no-store" }, label);
  }
  limited = true;
  assert.deepEqual(await answer(await handler(commitment(body), testClient())), { status: 429, body: { reason: "rate-limited" }, cache: "no-store" });
  assert.equal(store.commitments.size, 0);

  const limiterDown = memoryStore({ admitOutcomeCommitment: async () => Promise.reject(new Error("database down")) });
  const storageDown = memoryStore({ recordOutcomeCommitment: async () => Promise.reject(Object.assign(new Error("gone"), { code: "57P01" })) });
  for (const [down, reason] of [[limiterDown, "limiter-unavailable"], [storageDown, "storage-unavailable"]] as const) {
    const route = createLaunchpadOutcomeCommitmentRouteHandler({ expectedOrigin: ORIGIN, emitter: down.emitter });
    assert.deepEqual(await answer(await route(commitment(body), testClient())), { status: 503, body: { reason }, cache: "no-store" });
    assert.equal(down.commitments.size, 0);
  }
  for (const line of lines) {
    for (const value of [launchId, VISITOR, WALLET, digests.buy, "did:privy", "evil.example"]) assert.ok(!line.includes(value), line);
  }
  assert.ok(lines.some((line) => line.includes('"event":"outcome_commitment"') && line.includes('"reason":"rate-limited"')));
});

test("the browser reporter sends a Privy token only as its Bearer header, never in the body, once per event and on its one retry", async () => {
  const flush = async () => {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const sent: RequestInit[] = [];
  const timers: Array<() => void> = [];
  const reporter = createVerifiedOutcomeReporter(
    {
      fetch: async (_url, init) => {
        sent.push(init);
        return new Response(null, { status: 503 });
      },
    },
    { random: () => 0, setTimer: (run) => void timers.push(run) },
  );
  const launch = { kind: "launch", launchId, txDigest: digests.launch } as const;
  reporter.report({ ...launch, privyToken: "eyJhbGciOiJFUzI1NiJ9.e30.c2ln" });
  reporter.report({ ...launch, privyToken: "another-token" });
  await flush();
  timers.shift()!();
  await flush();
  assert.equal(sent.length, 2, "one report and its one retry");
  for (const init of sent) {
    assert.equal(init.body, JSON.stringify(launch));
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer eyJhbGciOiJFUzI1NiJ9.e30.c2ln");
  }
  // A token that is not one is never sent; the outcome still is.
  const plain: RequestInit[] = [];
  const untokened = createVerifiedOutcomeReporter({ fetch: async (_url, init) => void plain.push(init) });
  untokened.report({ kind: "buy", launchId, txDigest: digests.buy, privyToken: "bad token\r\nX-Injected: 1" });
  untokened.report({ kind: "buy", launchId, txDigest: digests.settlementThenBuy, privyToken: "x".repeat(9_000) });
  untokened.report({ kind: "buy", launchId, txDigest: digests.sold });
  await flush();
  assert.deepEqual(plain.map((init) => (init.headers as Record<string, string>).Authorization), [undefined, undefined, undefined]);
});

test("a commitment is sent once per signed digest, fire-and-forget, never retried and never throwing", async () => {
  const flush = async () => {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const committer = createOutcomeCommitter({
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response(null, { status: 503 });
    },
  });
  const launch = { kind: "launch", launchId, txDigest: digests.launch } as const;
  assert.equal(committer.commit(launch), undefined, "nothing to await");
  committer.commit(launch);
  committer.commit({ kind: "launch", launchId: WALLET.toUpperCase(), txDigest: digests.launch });
  committer.commit({ kind: "migration", launchId, txDigest: digests.buy } as never);
  await flush();
  assert.deepEqual(
    sent.map(({ url, init }) => [url, init.method, init.credentials, init.keepalive, (init.headers as Record<string, string>)["Content-Type"], init.body]),
    [[LAUNCHPAD_OUTCOME_COMMITMENTS_PATH, "POST", "same-origin", true, "application/json", JSON.stringify(launch)]],
  );
  const throwing = createOutcomeCommitter({
    fetch: () => {
      throw new Error("blocked");
    },
  });
  assert.doesNotThrow(() => throwing.commit(launch));
  const rejecting = createOutcomeCommitter({ fetch: () => Promise.reject(new Error("offline")) });
  assert.doesNotThrow(() => rejecting.commit(launch));
  await flush();
  // On the server there is no browser to commit from.
  assert.doesNotThrow(() => commitSignedOutcome(launch));
});

test("a commitment's receipt time is taken once its body has arrived, before the rate check", async () => {
  let admissionStarted = Number.NaN;
  const store = memoryStore({
    admitOutcomeCommitment: async () => {
      admissionStarted = Date.now();
      // A slow limiter round trip (a cold database) must not move the receipt time later.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "allowed";
    },
  });
  const handler = createLaunchpadOutcomeCommitmentRouteHandler({ expectedOrigin: ORIGIN, emitter: store.emitter });
  // A client that opens the request before it knows the digest and streams the body later cannot pre-date its receipt.
  const body = new TextEncoder().encode(JSON.stringify({ kind: "launch", launchId, txDigest: digests.launch }));
  let lastByteSent = Number.NaN;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      lastByteSent = Date.now();
      controller.enqueue(body);
      controller.close();
    },
  });
  const request = new Request(`${ORIGIN}/api/launchpad/outcomes/commitments`, {
    method: "POST",
    body: stream,
    headers: { "Content-Type": "application/json", ...SAME_ORIGIN },
    duplex: "half",
  } as RequestInit);
  assert.equal((await handler(request, testClient())).status, 201);
  const [receivedAt] = store.receipts;
  assert.ok(receivedAt instanceof Date, "the route passes its receipt time");
  assert.ok(
    receivedAt.getTime() >= lastByteSent && receivedAt.getTime() <= admissionStarted,
    `${receivedAt.toISOString()} is after the last byte and before the rate check`,
  );
});
