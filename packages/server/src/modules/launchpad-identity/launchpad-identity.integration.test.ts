import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { getZkLoginSignature, toZkLoginPublicIdentifier } from "@mysten/sui/zklogin";
import type { Pool } from "pg";

import { createPrivySessionVerifier } from "@blast/server/lib/privy-adapter/adapter.ts";
import {
  createSyntheticPrivyGateway,
  SYNTHETIC_PRIVY_DID,
  SYNTHETIC_SUI_ADDRESS,
  type SyntheticPrivyFixtureMode,
} from "../../../../core/test/fixtures/lib/privy-adapter/fixtures.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import type {
  RateBucket,
  RateLimitPort,
  RateLimitSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { createPool, migrateDatabase } from "@blast/core/modules/database/admin.ts";
import { createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { runCleanup } from "@blast/server/modules/mission-control/maintenance/service.ts";
import {
  syntheticEmbeddedSigner,
  syntheticSlushSigner,
} from "../../../../core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";
import type { LaunchpadActor, LaunchpadProofAction } from "@blast/server/modules/launchpad-identity/contracts.ts";
import { createLaunchpadMutationHandler, type LaunchpadMutationDefinition } from "@blast/server/modules/launchpad-identity/mutation.ts";
import { createLaunchpadWalletProofRoutes } from "@blast/server/modules/launchpad-identity/route.ts";
import {
  LaunchpadIdentityService,
  verifyLaunchpadSignature,
  type LaunchpadIdentityServiceDependencies,
} from "@blast/server/modules/launchpad-identity/service.ts";
import { installRuntimeConfig } from "../../../test/fixtures/config/runtime-config.ts";
import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";

// The default wallet verifier reads its node URL from the API runtime config.
installRuntimeConfig();

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const ORIGIN = "https://blast.fun";
const PRIVY_TOKEN = "synthetic-access-token";
const SUBJECT_PEPPER = "launchpad-identity-test-pepper-of-32-characters";
const PRIVY_NOW = 2_000_000_000;
const BASE_TIME = new Date("2026-09-30T12:00:00.000Z");
const MIGRATIONS = new URL("../../../../core/src/modules/database/migrations/", import.meta.url);

/** A canonical launch ID unique to one scenario, so each counts its own writes. */
function launchId(label: number): string {
  return `0x${label.toString(16).padStart(64, "0")}`;
}

class RecordingLimiter implements RateLimitPort {
  readonly calls: string[] = [];
  async consume(bucket: RateBucket, subject: RateLimitSubject) {
    this.calls.push(`${bucket}:${subject.operation ?? "-"}`);
    return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
  }
}

interface Harness {
  admin: Pool;
  web: Pool;
  now: Date;
  privyMode: SyntheticPrivyFixtureMode;
  verifierFails: boolean;
  identity: LaunchpadIdentityService;
  limiter: RateLimitPort;
  csrf: string;
}

async function withHarness(
  body: (harness: Harness) => Promise<void>,
  options: {
    limiter?: (web: Pool, clock: () => Date) => RateLimitPort;
    /** Use the service's own default signature verifier, with no fixture around it. */
    defaultVerifier?: boolean;
  } = {},
): Promise<void> {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 3 });
  await migrateDatabase(admin);
  await admin.query("DELETE FROM mission_control_launchpad_wallet_challenges");
  await admin.query("DELETE FROM mission_control_launchpad_coin_views");
  await admin.query("DELETE FROM mission_control_rate_limit_windows");
  // Every write runs as the web runtime role, as in production.
  const web = createRuntimePool(urlAs(databaseUrl, "blast_web"), {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    max: 4,
    statementTimeoutMs: 4_000,
  });
  let id = 1;
  let nonce = 1;
  const clock = () => new Date(harness.now);
  const limiter = options.limiter?.(web, clock) ?? new RecordingLimiter();
  const dependencies: LaunchpadIdentityServiceDependencies = {
    clock,
    createId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
    createNonce: () => Buffer.alloc(32, nonce++).toString("base64url"),
    limiter,
    subjectPepper: SUBJECT_PEPPER,
    verifyPrivySession: (token) =>
      createPrivySessionVerifier({
        appId: "synthetic-privy-app",
        gateway: createSyntheticPrivyGateway(harness.privyMode),
        now: () => PRIVY_NOW,
      }).verifySession(token),
  };
  const harness: Harness = {
    admin,
    web,
    now: new Date(BASE_TIME),
    privyMode: "success",
    verifierFails: false,
    identity: options.defaultVerifier ? new LaunchpadIdentityService(web, dependencies) : new LaunchpadIdentityService(web, {
      ...dependencies,
      // The production verifier (local for these Ed25519 and secp256k1
      // signers), with a fixture failure standing in for an unreachable fullnode.
      verifyPersonalMessage: async (message, signature, address) => {
        if (harness.verifierFails) throw new Error("fullnode unreachable");
        return verifyLaunchpadSignature(message, signature, address);
      },
    }),
    limiter,
    csrf: "",
  };
  try {
    const bootstrap = await routes(harness).csrf(new Request(`${ORIGIN}/api/launchpad/csrf`));
    assert.equal(bootstrap.status, 204);
    harness.csrf = /__Host-blast_csrf=([A-Za-z0-9_-]{43});/.exec(bootstrap.headers.get("set-cookie") ?? "")?.[1] ?? "";
    assert.ok(harness.csrf, "the CSRF bootstrap sets the double-submit cookie");
    await body(harness);
  } finally {
    await Promise.all([admin.end(), web.end()]);
  }
}

function routes(harness: Harness) {
  return createLaunchpadWalletProofRoutes({ expectedOrigin: ORIGIN, identity: harness.identity });
}

function headers(harness: Harness, extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    cookie: `__Host-blast_csrf=${harness.csrf}`,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-blast-csrf": harness.csrf,
    ...extra,
  });
}

type WriteFixture = LaunchpadMutationDefinition<{ launchId: string }, { launchId: string; method: string }>;

/** The fixture protected write: one launchpad row per authorized request. */
function fixtureWrite(overrides: Partial<WriteFixture> = {}): WriteFixture {
  return {
    action: "social_post",
    fields: ["launchId"],
    parse: (input) => {
      if (typeof input.launchId !== "string" || !/^0x[0-9a-f]{64}$/.test(input.launchId)) {
        throw new TypeError("launchId");
      }
      return { launchId: input.launchId };
    },
    rateLimit: { bucket: "launchpad_telemetry", subject: ({ ip }) => ({ ip }) },
    write: async ({ actor, input, transaction }) => {
      await transaction.forModule("launchpad-telemetry").write(
        "mission_control_launchpad_coin_views",
        `INSERT INTO mission_control_launchpad_coin_views (period_start, visitor_id, launch_id, surface, viewed_at)
         VALUES ('2026-09-30', gen_random_uuid(), $1, 'coin-page', NOW())`,
        [input.launchId],
      );
      return { launchId: input.launchId, method: actor.method };
    },
    present: (result) => ({ write: result }),
    ...overrides,
  };
}

function mutate(harness: Harness, definition: WriteFixture = fixtureWrite()) {
  return createLaunchpadMutationHandler(definition, {
    expectedOrigin: ORIGIN,
    identity: harness.identity,
    limiter: harness.limiter,
    pool: harness.web,
  });
}

async function issue(
  harness: Harness,
  action: LaunchpadProofAction = "social_post",
  signer: typeof syntheticSlushSigner | typeof syntheticEmbeddedSigner = syntheticSlushSigner,
) {
  const response = await routes(harness).issue(new Request(`${ORIGIN}/api/launchpad/wallet-proofs`, {
    method: "POST",
    headers: headers(harness),
    body: JSON.stringify({ action, address: signer.toSuiAddress() }),
  }), testClient());
  assert.equal(response.status, 201);
  const body = await response.json() as {
    challenge: { action: string; address: string; challengeId: string; expiresAt: string; message: string };
  };
  return body.challenge;
}

async function sign(message: string, signer: typeof syntheticSlushSigner | typeof syntheticEmbeddedSigner = syntheticSlushSigner) {
  return (await signer.signPersonalMessage(new TextEncoder().encode(message))).signature;
}

function proofRequest(harness: Harness, id: string, proof: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}/api/launchpad/fixture`, {
    method: "POST",
    headers: headers(harness),
    body: JSON.stringify({ input: { launchId: id }, proof }),
  });
}

function privyRequest(harness: Harness, id: string): Request {
  return new Request(`${ORIGIN}/api/launchpad/fixture`, {
    method: "POST",
    headers: headers(harness, { authorization: `Bearer ${PRIVY_TOKEN}` }),
    body: JSON.stringify({ input: { launchId: id } }),
  });
}

async function writes(harness: Harness, id: string): Promise<number> {
  const result = await harness.admin.query<{ count: string }>(
    "SELECT count(*) FROM mission_control_launchpad_coin_views WHERE launch_id = $1",
    [id],
  );
  return Number(result.rows[0]?.count);
}

async function consumed(harness: Harness, challengeId: string): Promise<boolean> {
  const result = await harness.admin.query<{ consumed: boolean }>(
    "SELECT consumed_at IS NOT NULL AS consumed FROM mission_control_launchpad_wallet_challenges WHERE challenge_id = $1",
    [challengeId],
  );
  return result.rows[0]?.consumed === true;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

test("a Wallet Proof is issued, verified, and authorizes exactly one protected write", { skip }, async () => {
  await withHarness(async (harness) => {
    const challenge = await issue(harness);
    assert.equal(challenge.action, "social_post");
    assert.equal(challenge.address, syntheticSlushSigner.toSuiAddress());
    assert.match(challenge.message, /^BLAST\.FUN launchpad wallet proof\n/);
    assert.match(challenge.message, /\nOrigin: https:\/\/blast\.fun\n/);
    assert.match(challenge.message, /This is not a transaction and costs nothing\./);
    assert.equal(challenge.expiresAt, "2026-09-30T12:05:00.000Z");

    const proof = {
      address: challenge.address,
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: await sign(challenge.message),
    };
    const id = launchId(1);
    const response = await mutate(harness)(proofRequest(harness, id, proof), testClient());
    assert.equal(response.status, 201);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body.write, { launchId: id, method: "wallet_proof" });
    assert.equal(await writes(harness, id), 1);
    assert.equal(await consumed(harness, challenge.challengeId), true);

    // Replaying the spent proof, for the same or another write, changes nothing.
    for (const target of [id, launchId(2)]) {
      const replay = await mutate(harness)(proofRequest(harness, target, proof), testClient());
      assert.equal(replay.status, 401);
      assert.equal(await errorCode(replay), "LAUNCHPAD_AUTH_INVALID");
    }
    assert.equal(await writes(harness, id), 1);
    assert.equal(await writes(harness, launchId(2)), 0);

    // Only hashes of the challenge are stored: no message, nonce, or signature.
    const stored = await harness.admin.query("SELECT * FROM mission_control_launchpad_wallet_challenges");
    const text = JSON.stringify(stored.rows);
    assert.ok(!text.includes(proof.signature));
    assert.ok(!text.includes(/Nonce: (\S+)/.exec(challenge.message)?.[1] ?? "missing"));
    assert.deepEqual(
      Object.keys(stored.rows[0] ?? {}).sort(),
      ["action", "challenge_id", "consumed_at", "expires_at", "issued_at", "message_hash", "nonce_hash", "origin", "wallet_address"],
    );
  });
});

test("every invalid proof fails without a write and leaves the challenge unspent", { skip }, async () => {
  await withHarness(async (harness) => {
    let label = 100;
    async function refused(
      proof: Record<string, unknown>,
      challengeId: string,
      status: number,
      code: string,
      definition?: WriteFixture,
    ) {
      const id = launchId(label++);
      const response = await mutate(harness, definition)(proofRequest(harness, id, proof), testClient());
      assert.equal(response.status, status, code);
      assert.equal(await errorCode(response), code);
      assert.equal(await writes(harness, id), 0, `${code}: no write`);
      assert.equal(await consumed(harness, challengeId), false, `${code}: challenge unspent`);
    }

    // Wrong action: a proof for another write.
    const other = await issue(harness, "launch_metadata");
    await refused(
      { address: other.address, challengeId: other.challengeId, message: other.message, signature: await sign(other.message) },
      other.challengeId, 401, "LAUNCHPAD_AUTH_INVALID",
    );

    // Wrong origin: issued for another deployment that shares the database.
    const preview = await harness.identity.issueChallenge(
      { action: "social_post", address: syntheticSlushSigner.toSuiAddress(), origin: "https://preview.blast.fun" },
      { ip: "203.0.113.50" },
    );
    await refused(
      { address: preview.address, challengeId: preview.challengeId, message: preview.message, signature: await sign(preview.message) },
      preview.challengeId, 401, "LAUNCHPAD_AUTH_INVALID",
    );

    const challenge = await issue(harness);
    const good = {
      address: challenge.address,
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: await sign(challenge.message),
    };

    // Wrong address: another wallet's address, signed by either wallet.
    const otherAddress = syntheticEmbeddedSigner.toSuiAddress();
    await refused({ ...good, address: otherAddress }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");
    await refused(
      { ...good, address: otherAddress, signature: await sign(challenge.message, syntheticEmbeddedSigner) },
      challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID",
    );

    // Altered message, validly signed by the right wallet.
    const altered = challenge.message.replace("costs nothing", "costs 1 SUI");
    await refused({ ...good, message: altered, signature: await sign(altered) }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");

    // Malformed signatures that decode but have the wrong length or a
    // damaged tail are invalid (401), not a verifier outage (503).
    const signatureBytes = Buffer.from(good.signature, "base64");
    await refused({ ...good, signature: signatureBytes.subarray(0, 96).toString("base64") }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");
    await refused({ ...good, signature: Buffer.concat([signatureBytes, Buffer.from([0])]).toString("base64") }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");
    await refused({ ...good, signature: `${good.signature.slice(0, -4)}AAAA` }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");

    // Invalid signatures: another wallet's, and garbage.
    await refused({ ...good, signature: await sign(challenge.message, syntheticEmbeddedSigner) }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");
    await refused({ ...good, signature: Buffer.alloc(97, 7).toString("base64") }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");

    // Unknown challenge.
    await refused({ ...good, challengeId: "00000000-0000-4000-8000-00000000ffff" }, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");

    // The signature verifier (a fullnode for zkLogin) fails: 503, nothing spent.
    harness.verifierFails = true;
    await refused(good, challenge.challengeId, 503, "LAUNCHPAD_AUTH_UNAVAILABLE");
    harness.verifierFails = false;

    // Authorization refuses: nothing commits, the proof stays unspent.
    await refused(good, challenge.challengeId, 403, "LAUNCHPAD_FORBIDDEN", fixtureWrite({ authorize: async () => false }));

    // The owning module's write fails after the proof was consumed: all rolled back.
    await refused(good, challenge.challengeId, 500, "LAUNCHPAD_INTERNAL_ERROR", fixtureWrite({
      write: async ({ transaction }) => {
        await transaction.read("SELECT 1");
        throw new Error("module write failed");
      },
    }));

    // Expired.
    harness.now = new Date(BASE_TIME.getTime() + 5 * 60 * 1_000);
    await refused(good, challenge.challengeId, 401, "LAUNCHPAD_AUTH_INVALID");

    // The same untouched proof still works once, before it expires.
    harness.now = new Date(BASE_TIME.getTime() + 60 * 1_000);
    const id = launchId(label++);
    const accepted = await mutate(harness)(proofRequest(harness, id, good), testClient());
    assert.equal(accepted.status, 201);
    assert.equal(await writes(harness, id), 1);
    assert.equal(await consumed(harness, challenge.challengeId), true);
  });
});

test("concurrent uses of one proof commit exactly one write", { skip }, async () => {
  await withHarness(async (harness) => {
    const challenge = await issue(harness);
    const proof = {
      address: challenge.address,
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: await sign(challenge.message),
    };
    const ids = [launchId(201), launchId(202), launchId(203), launchId(204)];
    const responses = await Promise.all(ids.map((id) => mutate(harness)(proofRequest(harness, id, proof), testClient())));
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 401, 401, 401]);
    const counts = await Promise.all(ids.map((id) => writes(harness, id)));
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
  });
});

test("the same write accepts a verified Privy session and refuses a bad one without writing", { skip }, async () => {
  await withHarness(async (harness) => {
    const id = launchId(301);
    const response = await mutate(harness)(privyRequest(harness, id), testClient());
    assert.equal(response.status, 201);
    assert.deepEqual((await response.json() as Record<string, unknown>).write, { launchId: id, method: "privy" });
    assert.equal(await writes(harness, id), 1);

    const actor = await harness.identity.authenticatePrivy(PRIVY_TOKEN);
    assert.equal(actor.method, "privy");
    assert.equal(actor.walletAddress, SYNTHETIC_SUI_ADDRESS);
    assert.match((actor as Extract<LaunchpadActor, { method: "privy" }>).subjectKey, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(actor).includes(SYNTHETIC_PRIVY_DID));
    assert.deepEqual(await harness.identity.authenticatePrivy(PRIVY_TOKEN), actor, "stable per subject");

    for (const [mode, status, code] of [
      ["malformed-token", 401, "LAUNCHPAD_AUTH_INVALID"],
      ["expired", 401, "LAUNCHPAD_AUTH_INVALID"],
      ["provider-timeout", 503, "LAUNCHPAD_AUTH_UNAVAILABLE"],
    ] as const) {
      harness.privyMode = mode;
      const refusedId = launchId(310 + status);
      const refused = await mutate(harness)(privyRequest(harness, refusedId), testClient());
      assert.equal(refused.status, status, mode);
      assert.equal(await errorCode(refused), code, mode);
      assert.equal(await writes(harness, refusedId), 0, mode);
    }
  });
});

function issueRequest(harness: Harness, address: string): Request {
  return new Request(`${ORIGIN}/api/launchpad/wallet-proofs`, {
    method: "POST",
    headers: headers(harness),
    body: JSON.stringify({ action: "social_post", address }),
  });
}

const realLimiter = {
  limiter: (web: Pool, clock: () => Date) =>
    new PostgresRateLimitEnforcer({ pool: web, subjectPepper: SUBJECT_PEPPER, clock }),
};

test("launchpad proof budgets are counted apart from Mission Control's wallet bucket", { skip }, async () => {
  await withHarness(async (harness) => {
    const address = syntheticSlushSigner.toSuiAddress();
    const ip = "203.0.113.50";

    // Mission Control spends its whole `wallet` budget for this IP and address.
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await harness.limiter.consume("wallet", { ip, address, operation: "issue" })).allowed, true);
    }
    assert.equal((await harness.limiter.consume("wallet", { ip, address, operation: "issue" })).allowed, false);

    // The launchpad still has its own full issuance budget, then refuses.
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await routes(harness).issue(issueRequest(harness, address), testClient(ip))).status, 201);
    }
    const limited = await routes(harness).issue(issueRequest(harness, address), testClient(ip));
    assert.equal(limited.status, 429);
    assert.equal(await errorCode(limited), "LAUNCHPAD_RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);

    // And the reverse: a spent launchpad budget leaves Mission Control's untouched.
    const other = syntheticEmbeddedSigner.toSuiAddress();
    assert.equal((await harness.limiter.consume("wallet", { ip, address: other, operation: "issue" })).allowed, true);

    const rows = await harness.admin.query<{ policy_name: string; request_count: number }>(
      `SELECT policy_name, sum(request_count)::int AS request_count
       FROM mission_control_rate_limit_windows GROUP BY policy_name ORDER BY policy_name`,
    );
    assert.deepEqual(rows.rows, [
      { policy_name: "launchpad_wallet_proof_issue", request_count: 6 },
      { policy_name: "wallet", request_count: 7 },
    ]);
  }, realLimiter);
});

test("one IP rotating wallet addresses shares one issuance budget", { skip }, async () => {
  await withHarness(async (harness) => {
    for (let index = 1; index <= 5; index += 1) {
      const response = await routes(harness).issue(issueRequest(harness, `0x${index.toString(16).padStart(64, "0")}`), testClient());
      assert.equal(response.status, 201, `address ${index}`);
    }
    const rotated = await routes(harness).issue(issueRequest(harness, `0x${"6".padStart(64, "0")}`), testClient());
    assert.equal(rotated.status, 429);
    assert.equal(await errorCode(rotated), "LAUNCHPAD_RATE_LIMITED");
    // Another client IP is unaffected.
    assert.equal((await routes(harness).issue(issueRequest(harness, `0x${"6".padStart(64, "0")}`), testClient("203.0.113.51"))).status, 201);
  }, realLimiter);
});

test("proof checks count in the launchpad proof bucket, keyed by IP and address", { skip }, async () => {
  await withHarness(async (harness) => {
    const challenge = await issue(harness);
    const proof = {
      address: challenge.address,
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: await sign(challenge.message, syntheticEmbeddedSigner),
    };
    // Five refused checks spend the proof budget for this IP and address.
    for (let index = 0; index < 5; index += 1) {
      const refused = await mutate(harness)(proofRequest(harness, launchId(600 + index), proof), testClient());
      assert.equal(refused.status, 401);
    }
    const good = { ...proof, signature: await sign(challenge.message) };
    const limited = await mutate(harness)(proofRequest(harness, launchId(610), good), testClient());
    assert.equal(limited.status, 429);
    assert.equal(await errorCode(limited), "LAUNCHPAD_RATE_LIMITED");
    assert.equal(await writes(harness, launchId(610)), 0);
    assert.equal(await consumed(harness, challenge.challengeId), false);
    const rows = await harness.admin.query<{ policy_name: string }>(
      "SELECT DISTINCT policy_name FROM mission_control_rate_limit_windows ORDER BY 1",
    );
    assert.deepEqual(rows.rows.map((row) => row.policy_name), [
      "launchpad_telemetry",
      "launchpad_wallet_proof",
      "launchpad_wallet_proof_issue",
    ], "the write's own bucket, the proof check and the issue; never `wallet`");
  }, realLimiter);
});

test("the challenge route checks its request before issuing anything", { skip }, async () => {
  await withHarness(async (harness) => {
    const address = syntheticSlushSigner.toSuiAddress();
    const cases: Array<[string, RequestInit, number, string]> = [
      ["method", { method: "PUT", headers: headers(harness), body: "{}" }, 405, "LAUNCHPAD_METHOD_NOT_ALLOWED"],
      ["origin", { method: "POST", headers: headers(harness, { origin: "https://evil.example" }), body: JSON.stringify({ action: "social_post", address }) }, 403, "ORIGIN_INVALID"],
      ["csrf", { method: "POST", headers: headers(harness, { "x-blast-csrf": "d".repeat(43) }), body: JSON.stringify({ action: "social_post", address }) }, 403, "CSRF_INVALID"],
      ["content type", { method: "POST", headers: headers(harness, { "content-type": "text/plain" }), body: JSON.stringify({ action: "social_post", address }) }, 415, "LAUNCHPAD_CONTENT_TYPE_INVALID"],
      ["size", { method: "POST", headers: headers(harness), body: JSON.stringify({ action: "social_post", address, pad: "x".repeat(2_000) }) }, 413, "LAUNCHPAD_PAYLOAD_TOO_LARGE"],
      ["extra field", { method: "POST", headers: headers(harness), body: JSON.stringify({ action: "social_post", address, origin: "https://evil.example" }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
      ["unknown action", { method: "POST", headers: headers(harness), body: JSON.stringify({ action: "onboarding", address }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
      ["address", { method: "POST", headers: headers(harness), body: JSON.stringify({ action: "social_post", address: "0xzz" }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ];
    for (const [label, init, status, code] of cases) {
      const response = await routes(harness).issue(new Request(`${ORIGIN}/api/launchpad/wallet-proofs`, init), testClient());
      assert.equal(response.status, status, label);
      assert.equal(await errorCode(response), code, label);
    }
    const stored = await harness.admin.query("SELECT count(*)::int AS count FROM mission_control_launchpad_wallet_challenges");
    assert.equal(stored.rows[0]?.count, 0);
    assert.deepEqual((harness.limiter as RecordingLimiter).calls, [], "nothing was rate-counted either");

    // An existing CSRF cookie is kept; a missing or malformed one is replaced.
    const kept = await routes(harness).csrf(new Request(`${ORIGIN}/api/launchpad/csrf`, {
      headers: { cookie: `__Host-blast_csrf=${harness.csrf}` },
    }));
    assert.equal(kept.status, 204);
    assert.equal(kept.headers.get("set-cookie"), null);
    assert.equal(kept.headers.get("cache-control"), "no-store");
  });
});

test("a multisig with a junk zkLogin member is an invalid proof with the default verifier", { skip }, async () => {
  const lines: string[] = [];
  const original = console.info;
  const saved = process.env.MISSION_CONTROL_METRICS;
  delete process.env.MISSION_CONTROL_METRICS;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await withHarness(async (harness) => {
      // One member, zkLogin, with junk proof inputs. This SDK verifies every
      // multisig locally and cannot verify a zkLogin member: no fullnode call.
      const member = toZkLoginPublicIdentifier(1n, "https://accounts.google.com", { legacyAddress: false });
      const multisig = MultiSigPublicKey.fromPublicKeys({ threshold: 1, publicKeys: [{ publicKey: member, weight: 1 }] });
      const userSignature = await sign("unused", syntheticSlushSigner);
      const challenge = await harness.identity.issueChallenge(
        { action: "social_post", address: multisig.toSuiAddress(), origin: ORIGIN },
        { ip: "203.0.113.50" },
      );
      const zkLogin = getZkLoginSignature({
        inputs: {
          addressSeed: "1",
          headerBase64: "aGVhZGVy",
          issBase64Details: { indexMod4: 0, value: Buffer.from('"iss":"https://accounts.google.com",').toString("base64url") },
          proofPoints: { a: ["1", "2", "3"], b: [["1", "2"], ["3", "4"], ["5", "6"]], c: ["1", "2", "3"] },
        },
        maxEpoch: 10,
        userSignature,
      });
      const id = launchId(700);
      const response = await mutate(harness)(proofRequest(harness, id, {
        address: challenge.address,
        challengeId: challenge.challengeId,
        message: challenge.message,
        signature: multisig.combinePartialSignatures([zkLogin]),
      }), testClient());
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("retry-after"), null);
      assert.equal(await errorCode(response), "LAUNCHPAD_AUTH_INVALID");
      assert.equal(await writes(harness, id), 0);
      assert.equal(await consumed(harness, challenge.challengeId), false);
    }, { defaultVerifier: true });
  } finally {
    console.info = original;
    if (saved === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = saved;
  }
  const metrics = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(metrics.some((metric) => metric.metric === "launchpad.mutation" && metric.status === 401));
  assert.deepEqual(
    metrics.filter((metric) => metric.metric === "launchpad.identity" || metric.outcome === "error"),
    [],
    "no outage metric",
  );
});

test("logs, metrics, and error bodies never carry proof or session secrets", { skip }, async () => {
  const lines: string[] = [];
  const original = console.info;
  const saved = process.env.MISSION_CONTROL_METRICS;
  delete process.env.MISSION_CONTROL_METRICS;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const bodies: string[] = [];
  const secrets: string[] = [PRIVY_TOKEN, SYNTHETIC_PRIVY_DID];
  try {
    await withHarness(async (harness) => {
      const challenge = await issue(harness);
      const signature = await sign(challenge.message);
      const nonce = /Nonce: (\S+)/.exec(challenge.message)?.[1] ?? "";
      secrets.push(signature, nonce, challenge.message);
      const proof = { address: challenge.address, challengeId: challenge.challengeId, message: challenge.message, signature };
      harness.verifierFails = true;
      bodies.push(await (await mutate(harness)(proofRequest(harness, launchId(401), proof), testClient())).text());
      harness.verifierFails = false;
      bodies.push(await (await mutate(harness)(proofRequest(harness, launchId(402), proof), testClient())).text());
      bodies.push(await (await mutate(harness)(proofRequest(harness, launchId(403), proof), testClient())).text());
      bodies.push(await (await mutate(harness)(privyRequest(harness, launchId(404)), testClient())).text());
      const actor = await harness.identity.authenticatePrivy(PRIVY_TOKEN);
      secrets.push((actor as Extract<LaunchpadActor, { method: "privy" }>).subjectKey);
      harness.privyMode = "provider-timeout";
      bodies.push(await (await mutate(harness)(privyRequest(harness, launchId(405)), testClient())).text());
    });
  } finally {
    console.info = original;
    if (saved === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = saved;
  }
  assert.ok(lines.some((line) => line.includes("launchpad.mutation")));
  for (const text of [...lines, ...bodies]) {
    for (const secret of secrets) {
      assert.ok(secret && !text.includes(secret), `a secret leaked into: ${text}`);
    }
  }
});

test("expired launchpad challenges are deleted by the maintenance cleanup", { skip }, async () => {
  await withHarness(async (harness) => {
    const challenge = await issue(harness);
    const cleanup = await runCleanup(harness.web, {
      clock: () => new Date(BASE_TIME.getTime() + 2 * 60 * 60 * 1_000),
    });
    assert.equal(cleanup.ok, true);
    assert.equal(cleanup.tables.mission_control_launchpad_wallet_challenges.deleted, 1);
    const left = await harness.admin.query(
      "SELECT 1 FROM mission_control_launchpad_wallet_challenges WHERE challenge_id = $1",
      [challenge.challengeId],
    );
    assert.equal(left.rowCount, 0);
  });
});

test("0032 rolls back and re-applies in either order with 0031, keeping web-only grants", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  try {
    await migrateDatabase(admin);
    async function down(name: string) {
      const sql = await readFile(new URL(`${name}.down.sql`, MIGRATIONS), "utf8");
      await admin.query(sql);
      await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = $1", [name]);
    }
    const all = [
      "mission_control_launchpad_coin_views",
      "mission_control_launchpad_outcomes",
      "mission_control_launchpad_wallet_challenges",
    ];
    // 0031's and 0032's tables; later launchpad migrations (0036) add others.
    async function tables(): Promise<string[]> {
      const result = await admin.query<{ table_name: string }>(
        `SELECT table_name::text FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)
         ORDER BY table_name`,
        [all],
      );
      return result.rows.map((row) => row.table_name);
    }
    assert.deepEqual(await tables(), all);

    // Newest first: 0032 down, then 0031 down; both re-apply in order.
    await down("0032_launchpad_identity");
    assert.deepEqual(await tables(), all.filter((name) => !name.endsWith("wallet_challenges")));
    await down("0031_launchpad_telemetry");
    assert.deepEqual(await tables(), []);
    assert.deepEqual(await migrateDatabase(admin), ["0031_launchpad_telemetry", "0032_launchpad_identity"]);
    assert.deepEqual(await tables(), all);

    // 0032 alone: down and up again on top of 0031.
    await down("0032_launchpad_identity");
    assert.deepEqual(await migrateDatabase(admin), ["0032_launchpad_identity"]);

    const grants = await admin.query<{ grantee: string; privileges: string }>(
      `SELECT grantee::text, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
       FROM information_schema.role_table_grants
       WHERE table_name = 'mission_control_launchpad_wallet_challenges'
         AND grantee LIKE 'blast\\_%'
       GROUP BY grantee`,
    );
    assert.deepEqual(grants.rows, [{ grantee: "blast_web", privileges: "DELETE,INSERT,SELECT,UPDATE" }]);
  } finally {
    await admin.end();
  }
});
