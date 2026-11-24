import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type {
  RateBucket,
  RateLimitDecision,
  RateLimitPort,
  RateLimitSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import {
  PRESALE_ERRORS,
  type PresaleErrorCode,
} from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import {
  fixtureChainNode,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  SUI_TESTNET_CHAIN_IDENTIFIER,
  presaleIdentityFixture,
} from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate, readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { VISITOR_COOKIE_NAME } from "@blast/server/modules/launchpad-telemetry/http.ts";
import {
  createPresaleOutcomeFixtureNode,
  landedPresaleTransaction,
  PRESALE_OUTCOME_FIXTURE,
} from "../../../../test/fixtures/modules/presale/outcomes/fixtures.ts";
import type {
  PresaleOutcomeStore,
  PresaleCommitment,
  PresaleOutcomeRecord,
} from "./store.ts";
import { createPresaleOutcomeRecorder } from "./recorder.ts";
import { createPresaleOutcomeRoutes, parsePresaleOutcomeRequest } from "./routes.ts";
import { createPresaleVisitorRouteHandler } from "./visitor.ts";
import { createLaunchpadTelemetryRouteHandler } from "@blast/server/modules/launchpad-telemetry/route.ts";
import type { LaunchpadTelemetryEmitter } from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import {
  createPresaleOutcomeVerifier,
  presaleOutcomeSource,
} from "./verifier.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

/**
 * T-017 (AC-132, AC-133, AC-135): presale outcome registration. The verifier
 * reads the launchpad's outcome fixture node, extended with presale
 * `Committed` transactions; routes are exercised as Request -> Response
 * handlers through the real presale route kit.
 */

const { presaleId, digests, senders, checkpoint, timestampMs } =
  PRESALE_OUTCOME_FIXTURE;

test("the verifier attributes a presale Committed event to its sender with the chain's position and time", async () => {
  const node = createPresaleOutcomeFixtureNode();
  const verify = createPresaleOutcomeVerifier(async () => node.source);
  assert.deepEqual(await verify({ presaleId, txDigest: digests.commit }), {
    status: "verified",
    senderWallet: senders.committer,
    completion: {
      status: "completed",
      checkpoint,
      txDigest: digests.commit,
      eventSeq: 1,
      completedAt: new Date(timestampMs).toISOString(),
    },
  });
  assert.equal(
    (await verify({ presaleId, txDigest: digests.sponsored })).status,
    "verified",
  );
});

test("a digest without the sale's Committed event is refused with a bounded reason, and a pending one at once", async () => {
  const node = createPresaleOutcomeFixtureNode();
  const verify = createPresaleOutcomeVerifier(async () => node.source);
  const refusals: Record<string, unknown> = {};
  for (const [label, txDigest] of Object.entries(digests)) {
    const verdict = await verify({ presaleId, txDigest });
    if (verdict.status !== "verified") refusals[label] = verdict.reason;
  }
  assert.deepEqual(refusals, {
    otherPresale: "other-presale",
    foreign: "foreign-lineage",
    notACommit: "not-a-commit",
    failed: "failed",
    pending: "not-checkpointed",
    unknown: "unknown-transaction",
  });
});

test("the verifier never waits on the node: unconfigured, wrong chain, down and hung nodes are unavailable within the bound", async () => {
  const report = { presaleId, txDigest: digests.commit };
  assert.deepEqual(
    await createPresaleOutcomeVerifier(async () => null)(report),
    { status: "unavailable", reason: "node-unconfigured" },
  );
  const wrong = createPresaleOutcomeFixtureNode({
    chainIdentifier: SUI_TESTNET_CHAIN_IDENTIFIER,
  });
  assert.deepEqual(
    await createPresaleOutcomeVerifier(async () => ({
      ...wrong.source,
      chainIdentifier: PRESALE_OUTCOME_FIXTURE.chainIdentifier,
    }))(report),
    { status: "unavailable", reason: "wrong-network" },
  );
  const down = createPresaleOutcomeFixtureNode({ reads: "down" });
  assert.deepEqual(
    await createPresaleOutcomeVerifier(async () => down.source)(report),
    { status: "unavailable", reason: "node-unavailable" },
  );
  const hung = createPresaleOutcomeFixtureNode({ reads: "hang" });
  const started = performance.now();
  assert.deepEqual(
    await createPresaleOutcomeVerifier(async () => hung.source, {
      timeoutMs: 50,
    })(report),
    { status: "unavailable", reason: "node-unavailable" },
  );
  assert.ok(performance.now() - started < 1_000);
});

// --- Routes -----------------------------------------------------------------

const ORIGIN = "https://blast.fun";
const APP_ID = "presale-outcomes-app";
const NOW = Math.floor(Date.now() / 1_000);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const validator = createPresaleValidator();
const VISITOR = "11111111-1111-4111-8111-111111111111";

function privyToken(did: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({
    aud: APP_ID,
    exp: NOW + 3_600,
    iat: NOW - 60,
    iss: "privy.io",
    sid: "s-1",
    sub: did,
  });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    dsaEncoding: "ieee-p1363",
    key: keys.privateKey,
  });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

class MemoryLimiter implements RateLimitPort {
  readonly calls: { bucket: RateBucket; subject: RateLimitSubject }[] = [];
  refuse: RateBucket | null = null;
  async consume(
    bucket: RateBucket,
    subject: RateLimitSubject,
  ): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    const refused = this.refuse === bucket;
    return {
      allowed: !refused,
      bucket,
      policyVersion: 1,
      retryAfterSeconds: refused ? 42 : 0,
    };
  }
}

/** An in-memory store: one commitment per digest and visitor, one outcome per event. Link rules are the database's (integration suite). */
class MemoryStore implements PresaleOutcomeStore {
  readonly commitments: PresaleCommitment[] = [];
  readonly outcomes: PresaleOutcomeRecord[] = [];
  async recordCommitment(commitment: PresaleCommitment) {
    if (
      this.commitments.some(
        (entry) =>
          entry.txDigest === commitment.txDigest &&
          entry.visitorId === commitment.visitorId,
      )
    )
      return "duplicate" as const;
    this.commitments.push(commitment);
    return "recorded" as const;
  }
  async recordOutcome(outcome: PresaleOutcomeRecord) {
    const key = (entry: PresaleOutcomeRecord) =>
      `${entry.completion.txDigest}:${entry.completion.eventSeq}`;
    const duplicate = this.outcomes.some(
      (entry) => key(entry) === key(outcome),
    );
    this.outcomes.push(outcome);
    return {
      result: duplicate ? ("duplicate" as const) : ("recorded" as const),
      late: 0,
    };
  }
}

type RouteOptions = Partial<
  Omit<Parameters<typeof createPresaleOutcomeRoutes>[0], "recorder">
> &
  Partial<Omit<Parameters<typeof createPresaleOutcomeRecorder>[0], "store">>;

function routes(overrides: RouteOptions = {}) {
  const limiter = new MemoryLimiter();
  const store = new MemoryStore();
  const node = createPresaleOutcomeFixtureNode();
  const recorder = createPresaleOutcomeRecorder({
    store,
    verify:
      overrides.verify ?? createPresaleOutcomeVerifier(async () => node.source),
    embeddedWallet: overrides.embeddedWallet ?? (async () => null),
    identityTimeoutMs: overrides.identityTimeoutMs,
  });
  let id = 0;
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({
      appId: APP_ID,
      verificationKey,
    }),
    limiter,
    deployment: createPresaleDeploymentGate({
      environment: {
        PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()),
      },
      node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER),
    }),
    createRequestId: () => `req-${++id}`,
  });
  const handlers = createPresaleOutcomeRoutes({
    kit,
    expectedOrigin: ORIGIN,
    store,
    recorder,
    clock: overrides.clock,
  });
  return { ...handlers, limiter, store, node, recorder };
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "203.0.113.9",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const withVisitor = (visitor = VISITOR) => ({
  cookie: `theme=dark; ${VISITOR_COOKIE_NAME}=${visitor}`,
});

async function assertOk(
  response: Response,
  status: 200 | 201,
  value: "recorded" | "duplicate",
): Promise<void> {
  const body = await response.json();
  assert.equal(response.status, status);
  assert.deepEqual(body, { status: value });
  assert.deepEqual(validator.validate("outcome-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

async function assertError(
  response: Response,
  code: PresaleErrorCode,
): Promise<void> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const retryAfter = response.headers.get("retry-after");
  if (PRESALE_ERRORS[code].retryAfter)
    assert.match(retryAfter ?? "", /^[1-9][0-9]*$/);
  else assert.equal(retryAfter, null);
}

const COMMITMENTS = "/api/presale/outcomes/commitments";

test("AC-132: a same-origin commitment with the visitor cookie is recorded once, a repeat is a duplicate, and none without a cookie", async () => {
  const received = new Date(timestampMs - 2_000);
  const { commitments, store, limiter, node } = routes({
    clock: () => received,
  });
  // A pending digest: the browser commits before submission, so no node has it yet.
  const body = { presale_id: presaleId, tx_digest: digests.pending };
  assert.deepEqual(validator.validate("outcome-request", body).errors, []);
  await assertOk(
    await commitments(post(COMMITMENTS, body, withVisitor()), testClient("203.0.113.9")),
    201,
    "recorded",
  );
  await assertOk(
    await commitments(post(COMMITMENTS, body, withVisitor()), testClient("203.0.113.9")),
    200,
    "duplicate",
  );
  await assertError(await commitments(post(COMMITMENTS, body), testClient("203.0.113.9")), "no_visitor");
  await assertError(
    await commitments(
      post(COMMITMENTS, body, {
        cookie: `${VISITOR_COOKIE_NAME}=not-a-visitor`,
      }), testClient("203.0.113.9")
    ),
    "no_visitor",
  );
  assert.deepEqual(store.commitments, [
    {
      presaleId,
      txDigest: digests.pending,
      visitorId: VISITOR,
      committedAt: received,
    },
  ]);
  assert.equal(node.reads(), 0, "a commitment reads no node");
  assert.deepEqual(
    limiter.calls.map((call) => call.bucket),
    ["presale_outcome_commit", "presale_outcome_commit"],
  );
  assert.deepEqual(limiter.calls[0]?.subject, { ip: "203.0.113.9" });
});

test("the commitment route refuses another origin, a malformed body and a full bucket before storing anything", async () => {
  const { commitments, store, limiter } = routes();
  const body = { presale_id: presaleId, tx_digest: digests.commit };
  await assertError(
    await commitments(
      post(COMMITMENTS, body, {
        ...withVisitor(),
        origin: "https://evil.example",
      }), testClient("203.0.113.9")
    ),
    "origin_invalid",
  );
  await assertError(
    await commitments(
      post(COMMITMENTS, body, {
        ...withVisitor(),
        "sec-fetch-site": "cross-site",
      }), testClient("203.0.113.9")
    ),
    "origin_invalid",
  );
  for (const bad of [
    "{not json",
    { presale_id: presaleId },
    { ...body, wallet: senders.committer },
    { ...body, presale_id: presaleId.toUpperCase().replace("0X", "0x") },
    { ...body, tx_digest: "0OIl" },
  ]) {
    await assertError(
      await commitments(post(COMMITMENTS, bad, withVisitor()), testClient("203.0.113.9")),
      "invalid_request",
    );
  }
  await assertError(
    await commitments(
      post(COMMITMENTS, { ...body, padding: "x".repeat(2_048) }, withVisitor()), testClient("203.0.113.9")
    ),
    "body_too_large",
  );
  limiter.refuse = "presale_outcome_commit";
  await assertError(
    await commitments(post(COMMITMENTS, body, withVisitor()), testClient("203.0.113.9")),
    "rate_limited",
  );
  assert.deepEqual(store.commitments, []);
});

const OUTCOMES = "/api/presale/outcomes";
const DID_COMMITTER = "did:privy:presale-committer";
const DID_OTHER = "did:privy:presale-other";
const bearer = (did: string) => ({
  authorization: `Bearer ${privyToken(did)}`,
});

test("AC-133: an outcome is recorded once for the event sender; only the sender's own Privy session links its account", async () => {
  const wallets: Record<string, string> = {
    [DID_COMMITTER]: senders.committer,
    [DID_OTHER]: senders.embedded,
  };
  const { outcomes, store, limiter } = routes({
    embeddedWallet: async (did) => wallets[did] ?? null,
  });
  const body = { presale_id: presaleId, tx_digest: digests.commit };
  // Another visitor's session reports first: attribution stays the sender's, and nobody is linked.
  await assertOk(
    await outcomes(
      post(OUTCOMES, body, {
        ...withVisitor("22222222-2222-4222-8222-222222222222"),
        ...bearer(DID_OTHER),
      }), testClient("203.0.113.9")
    ),
    201,
    "recorded",
  );
  // The sender's own session (embedded wallet = sender) links its account and its visitor.
  await assertOk(
    await outcomes(
      post(OUTCOMES, body, { ...withVisitor(), ...bearer(DID_COMMITTER) }), testClient("203.0.113.9")
    ),
    200,
    "duplicate",
  );
  // A session without a cookie still links the account.
  await assertOk(
    await outcomes(
      post(
        OUTCOMES,
        { presale_id: presaleId, tx_digest: digests.secondCommit },
        bearer(DID_COMMITTER),
      ), testClient("203.0.113.9")
    ),
    201,
    "recorded",
  );
  const chain = {
    checkpoint,
    completedAt: new Date(timestampMs).toISOString(),
    status: "completed",
  };
  assert.deepEqual(store.outcomes, [
    {
      presaleId,
      senderWallet: senders.committer,
      completion: { ...chain, txDigest: digests.commit, eventSeq: 1 },
      privyDid: null,
      sessionVisitorId: null,
    },
    {
      presaleId,
      senderWallet: senders.committer,
      completion: { ...chain, txDigest: digests.commit, eventSeq: 1 },
      privyDid: DID_COMMITTER,
      sessionVisitorId: VISITOR,
    },
    {
      presaleId,
      senderWallet: senders.committer,
      completion: { ...chain, txDigest: digests.secondCommit, eventSeq: 0 },
      privyDid: DID_COMMITTER,
      sessionVisitorId: null,
    },
  ]);
  assert.deepEqual(
    new Set(limiter.calls.map((call) => call.bucket)),
    new Set(["presale_outcome"]),
  );
});

test("CL-22: a missing, invalid or expired bearer token, or an identity outage, never refuses or links a report", async () => {
  const { outcomes, store } = routes({
    embeddedWallet: async (did) => {
      if (did === DID_OTHER) return new Promise<never>(() => undefined);
      throw new Error("privy down");
    },
    identityTimeoutMs: 50,
  });
  const body = { presale_id: presaleId, tx_digest: digests.commit };
  await assertOk(
    await outcomes(
      post(OUTCOMES, body, { authorization: "Bearer not-a-token" }), testClient("203.0.113.9")
    ),
    201,
    "recorded",
  );
  await assertOk(
    await outcomes(post(OUTCOMES, body, { authorization: "Basic abc" }), testClient("203.0.113.9")),
    200,
    "duplicate",
  );
  await assertOk(
    await outcomes(
      post(OUTCOMES, body, { ...withVisitor(), ...bearer(DID_COMMITTER) }), testClient("203.0.113.9")
    ),
    200,
    "duplicate",
  );
  const started = performance.now();
  await assertOk(
    await outcomes(
      post(OUTCOMES, body, { ...withVisitor(), ...bearer(DID_OTHER) }), testClient("203.0.113.9")
    ),
    200,
    "duplicate",
  );
  assert.ok(
    performance.now() - started < 1_000,
    "a hung identity lookup is abandoned",
  );
  assert.ok(
    store.outcomes.every(
      (outcome) =>
        outcome.privyDid === null && outcome.sessionVisitorId === null,
    ),
  );
});

test("AC-133, AC-135: a digest without the sale's Committed event is not_found at once, pending ones included; a node outage is service_unavailable", async () => {
  const { outcomes, store, node } = routes();
  for (const txDigest of [
    digests.pending,
    digests.unknown,
    digests.otherPresale,
    digests.foreign,
    digests.notACommit,
    digests.failed,
  ]) {
    const started = performance.now();
    await assertError(
      await outcomes(
        post(
          OUTCOMES,
          { presale_id: presaleId, tx_digest: txDigest },
          withVisitor(),
        ), testClient("203.0.113.9")
      ),
      "not_found",
    );
    assert.ok(
      performance.now() - started < 500,
      "answered without waiting for confirmation",
    );
  }
  await assertError(
    await outcomes(
      post(OUTCOMES, {
        presale_id: PRESALE_OUTCOME_FIXTURE.otherPresaleId,
        tx_digest: digests.commit,
      }), testClient("203.0.113.9")
    ),
    "not_found",
  );
  node.state.reads = "down";
  await assertError(
    await outcomes(
      post(OUTCOMES, { presale_id: presaleId, tx_digest: digests.commit }), testClient("203.0.113.9")
    ),
    "service_unavailable",
  );
  node.state.reads = "hang";
  const started = performance.now();
  await assertError(
    await routes({
      verify: createPresaleOutcomeVerifier(async () => node.source, {
        timeoutMs: 50,
      }),
    }).outcomes(
      post(OUTCOMES, { presale_id: presaleId, tx_digest: digests.commit }), testClient("203.0.113.9")
    ),
    "service_unavailable",
  );
  assert.ok(performance.now() - started < 1_000);
  assert.deepEqual(store.outcomes, []);
});

test("AC-135: the outcome route refuses another origin, a malformed body and a full presale_outcome bucket before reading the node", async () => {
  const { outcomes, store, limiter, node } = routes();
  const body = { presale_id: presaleId, tx_digest: digests.commit };
  await assertError(
    await outcomes(post(OUTCOMES, body, { origin: "https://evil.example" }), testClient("203.0.113.9")),
    "origin_invalid",
  );
  await assertError(
    await outcomes(post(OUTCOMES, body, { "sec-fetch-site": "same-site" }), testClient("203.0.113.9")),
    "origin_invalid",
  );
  await assertError(
    await outcomes(post(OUTCOMES, { ...body, sender: senders.embedded }), testClient("203.0.113.9")),
    "invalid_request",
  );
  await assertError(
    await outcomes(post(OUTCOMES, body, { "content-type": "text/plain" }), testClient("203.0.113.9")),
    "invalid_request",
  );
  limiter.refuse = "presale_outcome";
  await assertError(
    await outcomes(post(OUTCOMES, body, bearer(DID_COMMITTER)), testClient("203.0.113.9")),
    "rate_limited",
  );
  assert.equal(node.reads(), 0);
  assert.deepEqual(store.outcomes, []);
  assert.deepEqual(limiter.calls.at(-1)?.subject, {
    accountId: DID_COMMITTER,
    ip: "203.0.113.9",
  });
});

const VISITOR_ROUTE = "/api/presale/outcomes/visitor";
const MINTED = "33333333-3333-4333-8333-333333333333";

/** The cookie the launchpad telemetry route mints for `visitor` (a first view of a tradable coin). */
async function launchpadCookie(visitor: string): Promise<string> {
  const emitter = {
    admitCoinView: async () => "allowed",
    recordCoinView: async () => "recorded",
  } as unknown as LaunchpadTelemetryEmitter;
  const handler = createLaunchpadTelemetryRouteHandler({
    emitter,
    verifyTradable: async () => "tradable",
    expectedOrigin: ORIGIN,
    createVisitorId: () => visitor,
  });
  const response = await handler(
    post("/api/launchpad/telemetry", {
      event: "launchpad.coin_view.v1",
      launchId: `0x${"5a".repeat(32)}`,
      surface: "coin-page",
    }), testClient(),
  );
  assert.equal(response.status, 204);
  return response.headers.get("set-cookie") ?? "";
}

function visitorRoute(limiter: RateLimitPort = new MemoryLimiter()) {
  return createPresaleVisitorRouteHandler({
    expectedOrigin: ORIGIN,
    limiter,
    createVisitorId: () => MINTED,
    createRequestId: () => "req-visitor",
  });
}

function visitorRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${VISITOR_ROUTE}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
}

test("AC-132: the visitor route mints __Host-blast_vid exactly as the launchpad telemetry route does, with the launchpad off", async () => {
  const launchpadFlag = process.env.BLAST_LAUNCHPAD_ENABLED;
  delete process.env.BLAST_LAUNCHPAD_ENABLED;
  try {
    const limiter = new MemoryLimiter();
    const response = await visitorRoute(limiter)(visitorRequest(), testClient());
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const cookie = response.headers.get("set-cookie");
    assert.equal(cookie, await launchpadCookie(MINTED));
    assert.match(
      cookie ?? "",
      /^__Host-blast_vid=33333333-3333-4333-8333-333333333333; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/,
    );
    assert.deepEqual(limiter.calls, [
      { bucket: "presale_outcome_commit", subject: { ip: "203.0.113.7" } },
    ]);
  } finally {
    if (launchpadFlag !== undefined)
      process.env.BLAST_LAUNCHPAD_ENABLED = launchpadFlag;
  }
});

test("the visitor route keeps a valid cookie without counting it, and replaces an invalid one", async () => {
  const limiter = new MemoryLimiter();
  const kept = await visitorRoute(limiter)(visitorRequest(withVisitor()), testClient());
  assert.equal(kept.status, 204);
  assert.equal(kept.headers.get("set-cookie"), null);
  assert.deepEqual(
    limiter.calls,
    [],
    "a page load with a visitor never spends the commitment bucket",
  );
  const replaced = await visitorRoute(limiter)(
    visitorRequest({ cookie: `${VISITOR_COOKIE_NAME}=forged` }), testClient(),
  );
  assert.equal(replaced.status, 204);
  assert.match(
    replaced.headers.get("set-cookie") ?? "",
    new RegExp(`^${VISITOR_COOKIE_NAME}=${MINTED};`),
  );
});

test("the visitor route refuses another origin, a full presale_outcome_commit bucket and a limiter outage without minting", async () => {
  await assertError(
    await visitorRoute()(visitorRequest({ origin: "https://evil.example" }), testClient()),
    "origin_invalid",
  );
  await assertError(
    await visitorRoute()(visitorRequest({ "sec-fetch-site": "cross-site" }), testClient()),
    "origin_invalid",
  );
  const full = new MemoryLimiter();
  full.refuse = "presale_outcome_commit";
  const limited = await visitorRoute(full)(visitorRequest(), testClient());
  assert.equal(limited.headers.get("set-cookie"), null);
  assert.equal(limited.headers.get("retry-after"), "42");
  await assertError(limited, "rate_limited");
  const down = await visitorRoute({
    consume: async () => {
      throw new Error("database down");
    },
  })(visitorRequest(), testClient());
  assert.equal(down.headers.get("set-cookie"), null);
  await assertError(down, "service_unavailable");
});

const DID_EMBEDDED = "did:privy:presale-embedded";

test("AC-4: the recorder links a sponsored commit's Privy account to its outcome without a browser call", async () => {
  const store = new MemoryStore();
  const node = createPresaleOutcomeFixtureNode();
  const recorder = createPresaleOutcomeRecorder({
    store,
    verify: createPresaleOutcomeVerifier(async () => node.source),
    embeddedWallet: async (did) =>
      did === DID_EMBEDDED ? senders.embedded : null,
  });
  assert.deepEqual(
    await recorder.recordSponsoredCommit({
      presaleId,
      txDigest: digests.sponsored,
      privyDid: DID_EMBEDDED,
    }),
    { status: "recorded" },
  );
  assert.deepEqual(
    await recorder.recordSponsoredCommit({
      presaleId,
      txDigest: digests.sponsored,
      privyDid: DID_EMBEDDED,
    }),
    { status: "duplicate" },
  );
  // A DID whose embedded wallet is not the sender links nobody.
  assert.deepEqual(
    await recorder.recordSponsoredCommit({
      presaleId,
      txDigest: digests.commit,
      privyDid: DID_EMBEDDED,
    }),
    { status: "recorded" },
  );
  assert.deepEqual(
    store.outcomes.map(
      ({ completion, senderWallet, privyDid, sessionVisitorId }) => [
        completion.txDigest,
        senderWallet,
        privyDid,
        sessionVisitorId,
      ],
    ),
    [
      [digests.sponsored, senders.embedded, DID_EMBEDDED, null],
      [digests.sponsored, senders.embedded, DID_EMBEDDED, null],
      [digests.commit, senders.committer, null, null],
    ],
  );
});

test("the sponsored recorder waits out a pending transaction within its retries, and never throws", async () => {
  const store = new MemoryStore();
  const node = createPresaleOutcomeFixtureNode();
  const pending = node.transactions.get(digests.pending)!;
  const waits: number[] = [];
  const recorder = createPresaleOutcomeRecorder({
    store,
    verify: createPresaleOutcomeVerifier(async () => node.source),
    embeddedWallet: async () => senders.committer,
    sleep: async (ms) => {
      waits.push(ms);
      // The node checkpoints the transaction during the second wait.
      if (waits.length === 2)
        node.transactions.set(
          digests.pending,
          landedPresaleTransaction(digests.pending, pending.events),
        );
    },
  });
  assert.deepEqual(
    await recorder.recordSponsoredCommit({
      presaleId,
      txDigest: digests.pending,
      privyDid: DID_COMMITTER,
    }),
    { status: "recorded" },
  );
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(store.outcomes[0]?.privyDid, DID_COMMITTER);

  waits.length = 0;
  assert.deepEqual(
    await recorder.recordSponsoredCommit({
      presaleId,
      txDigest: digests.unknown,
      privyDid: DID_COMMITTER,
    }),
    { status: "not_found", reason: "unknown-transaction" },
  );
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
  waits.length = 0;
  assert.deepEqual(
    await recorder.recordSponsoredCommit({
      presaleId,
      txDigest: digests.otherPresale,
      privyDid: DID_COMMITTER,
    }),
    { status: "not_found", reason: "other-presale" },
  );
  assert.deepEqual(waits, [], "a definite refusal is not retried");

  const broken = createPresaleOutcomeRecorder({
    store: {
      recordCommitment: async () => "recorded",
      recordOutcome: async () => {
        throw new Error("database down");
      },
    },
    verify: createPresaleOutcomeVerifier(async () => node.source),
    embeddedWallet: async () => null,
    pendingRetryDelaysMs: [],
  });
  assert.deepEqual(
    await broken.recordSponsoredCommit({
      presaleId,
      txDigest: digests.commit,
      privyDid: DID_COMMITTER,
    }),
    { status: "unavailable", reason: "storage-unavailable" },
  );
});

// The node URL's https rule is a boot rule now (runtime-config.test.ts).
test("the verifier reads the presale identity's node and package, and has none without an identity", () => {
  const ready = readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) });
  assert.equal(presaleOutcomeSource(readPresaleDeploymentIdentity({}), "https://127.0.0.1:9000"), null);
  const source = presaleOutcomeSource(ready, "https://127.0.0.1:9000");
  assert.ok(source);
  assert.equal(source.chainIdentifier, SUI_MAINNET_CHAIN_IDENTIFIER);
  assert.equal(source.originalPackageId, PRESALE_OUTCOME_FIXTURE.packageId);
});

test("visible identity timeout keeps the actual lookup owned until settlement without linking late identity", async () => {
  const {
    createAfterResponseScheduler,
    createRequestWork,
    runWithRequestWork,
    trackRequestWork,
  } = await import("@blast/server/lib/request-work.ts");
  const scheduler = createAfterResponseScheduler();
  const request = createRequestWork(scheduler);
  let resolve!: (wallet: string) => void;
  const provider = new Promise<string>((done) => {
    resolve = done;
  });
  const fixture = routes({
    embeddedWallet: () => trackRequestWork(provider),
    identityTimeoutMs: 5,
  });
  const verdict = await runWithRequestWork(request, () =>
    fixture.recorder.record({
      presaleId,
      txDigest: digests.commit,
      visitorId: VISITOR,
      privyDid: DID_EMBEDDED,
    }),
  );
  assert.equal(verdict.status, "recorded");
  assert.equal(fixture.store.outcomes[0]!.privyDid, null);
  let completed = false;
  const completing = request.complete().then(() => {
    completed = true;
  });
  await new Promise((done) => setImmediate(done));
  assert.equal(completed, false);
  resolve(senders.committer);
  await completing;
  assert.equal(
    fixture.store.outcomes[0]!.privyDid,
    null,
    "late identity does not rewrite the visible decision",
  );
  await scheduler.drain();
});

test("the request boundary maps wire names and retains invalid_request for noncanonical or short identifiers", () => {
  assert.deepEqual(parsePresaleOutcomeRequest({ presale_id: presaleId, tx_digest: digests.commit }), {
    presaleId, txDigest: digests.commit,
  });
  for (const body of [
    { presale_id: `${presaleId}\n`, tx_digest: digests.commit },
    { presale_id: presaleId, tx_digest: "1".repeat(42) },
    { presale_id: presaleId, tx_digest: digests.commit, extra: true },
  ]) {
    assert.throws(() => parsePresaleOutcomeRequest(body), { code: "invalid_request" });
  }
});
