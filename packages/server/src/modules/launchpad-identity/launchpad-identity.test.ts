import assert from "node:assert/strict";
import test from "node:test";

import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { bcs as suiBcs } from "@mysten/sui/bcs";
import { getZkLoginSignature, toZkLoginPublicIdentifier } from "@mysten/sui/zklogin";
import type { Pool } from "pg";

import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { LAUNCHPAD_PROOF_ACTIONS, parseLaunchpadProofAction, parseWalletProof } from "@blast/server/modules/launchpad-identity/contracts.ts";
import { parseHttpsUrl } from "@blast/core/lib/https-url.ts";
import type { LaunchpadActor } from "@blast/server/modules/launchpad-identity/contracts.ts";
import { LaunchpadMutationError } from "@blast/server/modules/launchpad-identity/errors.ts";
import { buildLaunchpadProofMessage } from "@blast/server/modules/launchpad-identity/message.ts";
import { syntheticSlushSigner } from "../../../../core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";
import { createLaunchpadMutationHandler, type LaunchpadIdentity } from "@blast/server/modules/launchpad-identity/mutation.ts";
import { LaunchpadIdentityService, verifyLaunchpadSignature } from "@blast/server/modules/launchpad-identity/service.ts";
import { installRuntimeConfig } from "../../../test/fixtures/config/runtime-config.ts";
import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";

// The wallet verifier reads its node URL from runtime config when it is built.
installRuntimeConfig();

const ADDRESS = `0x${"ab".repeat(32)}`;
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000001";

test("proof actions are a closed list", () => {
  assert.ok(LAUNCHPAD_PROOF_ACTIONS.length > 0);
  for (const action of LAUNCHPAD_PROOF_ACTIONS) {
    assert.equal(parseLaunchpadProofAction(action), action);
  }
  for (const value of ["", "onboarding", "link_wallet", "SOCIAL_POST", 7, null, undefined]) {
    assert.throws(() => parseLaunchpadProofAction(value), TypeError, String(value));
  }
});

test("a wallet proof has exactly its four bounded fields and a canonical address", () => {
  const proof = {
    address: `0x${"AB".repeat(32)}`,
    challengeId: CHALLENGE_ID.toUpperCase(),
    message: "signed text",
    signature: "c2lnbmF0dXJl",
  };
  assert.deepEqual(parseWalletProof(proof), {
    address: ADDRESS,
    challengeId: CHALLENGE_ID,
    message: "signed text",
    signature: "c2lnbmF0dXJl",
  });
  assert.equal(parseWalletProof({ ...proof, address: "0x2" }).address, `0x${"0".repeat(63)}2`);

  for (const invalid of [
    { ...proof, extra: true },
    { address: proof.address, challengeId: proof.challengeId, message: proof.message },
    { ...proof, address: "0xnot-hex" },
    { ...proof, address: `0x${"a".repeat(65)}` },
    { ...proof, challengeId: "not-a-uuid" },
    { ...proof, message: "" },
    { ...proof, message: "m".repeat(2_049) },
    { ...proof, signature: "" },
    { ...proof, signature: "s".repeat(8_193) },
    { ...proof, signature: 42 },
    [],
    null,
    "proof",
  ]) {
    assert.throws(() => parseWalletProof(invalid), TypeError, JSON.stringify(invalid));
  }
});

test("URLs are normalized absolute https without credentials", () => {
  assert.equal(parseHttpsUrl("https://Example.COM/a b?x=1#frag", 2_048), "https://example.com/a%20b?x=1#frag");
  assert.equal(parseHttpsUrl("https://example.com", 2_048), "https://example.com/");
  for (const invalid of [
    "http://example.com/",
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://user:pass@example.com/",
    "//example.com/",
    "/relative",
    "",
    42,
    `https://example.com/${"a".repeat(100)}`,
  ]) {
    assert.throws(() => parseHttpsUrl(invalid, 64), TypeError, String(invalid));
  }
});

test("the proof message binds action, origin, address, nonce, and lifetime and says it is free", () => {
  assert.equal(
    buildLaunchpadProofMessage({
      action: "social_post",
      address: ADDRESS,
      expiresAt: "2026-09-30T12:05:00.000Z",
      issuedAt: "2026-09-30T12:00:00.000Z",
      nonce: "A".repeat(43),
      origin: "https://blast.fun",
    }),
    [
      "BLAST.FUN launchpad wallet proof",
      "",
      "Sign to prove you control this wallet. This is not a transaction and costs nothing.",
      "",
      "Action: social_post",
      `Address: ${ADDRESS}`,
      "Origin: https://blast.fun",
      `Nonce: ${"A".repeat(43)}`,
      "Issued at: 2026-09-30T12:00:00.000Z",
      "Expires at: 2026-09-30T12:05:00.000Z",
    ].join("\n"),
  );
});

// --- Protected mutation boundary (guard order, credential choice, redaction) ---

const ORIGIN = "https://blast.fun";
const CSRF = "c".repeat(43);
const PRIVY_TOKEN = "header.payload-secret-token.signature";
const PRIVY_DID = "did:privy:secret-subject";
const SIGNATURE = "U0lHTkFUVVJFLVNFQ1JFVA==";
const PROOF_MESSAGE = "BLAST.FUN launchpad wallet proof\nNonce: secret-nonce";

class GuardProbe {
  readonly touched: string[] = [];
  limiterAllows = true;
  limiterFails = false;
  privyError: LaunchpadMutationError | null = null;
  /** When set, the write definition gets this `prepare` step. */
  prepare: ((
    input: { body: string; link: string },
    context: Readonly<{ actor: LaunchpadActor }>,
  ) => Promise<{ body: string; link: string }>) | null = null;
  /** Lets the transaction run (BEGIN, the write, COMMIT) instead of refusing the pool. */
  poolWorks = false;
  /** Makes Wallet Proofs check out, so the transaction would consume them. */
  proofValid = false;
  written: { body: string; link: string } | null = null;

  readonly pool = {
    connect: async () => {
      this.touched.push("pool.connect");
      if (!this.poolWorks) throw new Error("the pool must not be used");
      return {
        query: async (sql: unknown) => {
          const command = String(typeof sql === "string" ? sql : (sql as { text?: string }).text).split(" ")[0];
          return { rows: [], rowCount: 0, command };
        },
        release: () => undefined,
        on: () => undefined,
        removeListener: () => undefined,
      };
    },
    query: async () => {
      this.touched.push("pool.query");
      throw new Error("the pool must not be used");
    },
  } as unknown as Pool;

  readonly limiter: RateLimitPort = {
    consume: async (bucket, subject) => {
      this.touched.push(`limiter:${bucket}:${JSON.stringify(subject)}`);
      if (this.limiterFails) throw new Error("rate-limit storage down");
      return {
        allowed: this.limiterAllows,
        bucket,
        policyVersion: 1,
        retryAfterSeconds: this.limiterAllows ? 0 : 42,
      };
    },
  };

  readonly identity: LaunchpadIdentity = {
    authenticatePrivy: async (token) => {
      this.touched.push(`privy:${token === PRIVY_TOKEN}`);
      if (this.privyError) throw this.privyError;
      return { method: "privy", subjectKey: "k".repeat(64), walletAddress: null };
    },
    checkWalletProof: async (proof) => {
      this.touched.push("identity.checkWalletProof");
      if (!this.proofValid) throw new LaunchpadMutationError("LAUNCHPAD_AUTH_INVALID");
      return { action: "social_post", address: proof.address, challengeId: proof.challengeId, messageHash: "h".repeat(64), origin: ORIGIN };
    },
    consumeWalletProof: async (_transaction, proof) => {
      this.touched.push("identity.consumeWalletProof");
      if (!this.proofValid) throw new Error("unreachable");
      return { method: "wallet_proof", walletAddress: proof.address };
    },
  };

  handler() {
    return createLaunchpadMutationHandler(
      {
        action: "social_post",
        fields: ["body", "link"],
        maxBodyBytes: 1_024,
        parse: (input) => {
          if (typeof input.body !== "string" || input.body.length === 0 || input.body.length > 280) {
            throw new TypeError("body");
          }
          return { body: input.body, link: parseHttpsUrl(input.link, 256) };
        },
        rateLimit: { bucket: "launchpad_telemetry", subject: ({ ip }) => ({ ip }) },
        ...(this.prepare
          ? {
              prepare: async (input: { body: string; link: string }, context: Readonly<{ actor: LaunchpadActor }>) => {
                this.touched.push("prepare");
                return this.prepare!(input, context);
              },
            }
          : {}),
        write: async ({ input }) => {
          this.touched.push("write");
          this.written = input;
          return { id: 1 };
        },
        present: (result) => ({ post: result }),
      },
      {
        expectedOrigin: ORIGIN,
        identity: this.identity,
        limiter: this.limiter,
        pool: this.pool,
        createRequestId: () => "request-fixture",
      },
    );
  }
}

function mutationRequest(
  options: {
    method?: string;
    origin?: string | null;
    csrf?: boolean;
    contentType?: string | null;
    authorization?: string;
    body?: string;
    contentLength?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  headers.set("sec-fetch-site", "same-origin");
  if (options.csrf !== false) {
    headers.set("cookie", `__Host-blast_csrf=${CSRF}`);
    headers.set("x-blast-csrf", CSRF);
  }
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "application/json");
  if (options.authorization) headers.set("authorization", options.authorization);
  if (options.contentLength) headers.set("content-length", options.contentLength);
  const method = options.method ?? "POST";
  return new Request(`${ORIGIN}/api/launchpad/fixture`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : options.body ?? JSON.stringify({ input: { body: "gm", link: "https://example.com/x" } }),
  });
}

const PROOF_BODY = JSON.stringify({
  input: { body: "gm", link: "https://example.com/x" },
  proof: {
    address: `0x${"ab".repeat(32)}`,
    challengeId: CHALLENGE_ID,
    message: PROOF_MESSAGE,
    signature: SIGNATURE,
  },
});

async function captureMetrics<Result>(operation: () => Promise<Result>): Promise<{ result: Result; lines: string[] }> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await operation(), lines };
  } finally {
    console.info = original;
  }
}

test("every request check runs before identity, rate limits, or repositories", async () => {
  const cases: Array<[string, Parameters<typeof mutationRequest>[0], number, string]> = [
    ["method", { method: "PUT" }, 405, "LAUNCHPAD_METHOD_NOT_ALLOWED"],
    ["foreign origin", { origin: "https://evil.example" }, 403, "ORIGIN_INVALID"],
    ["missing origin", { origin: null }, 403, "ORIGIN_INVALID"],
    ["missing CSRF", { csrf: false }, 403, "CSRF_INVALID"],
    ["content type", { contentType: "text/plain" }, 415, "LAUNCHPAD_CONTENT_TYPE_INVALID"],
    ["missing content type", { contentType: null }, 415, "LAUNCHPAD_CONTENT_TYPE_INVALID"],
    ["declared size", { contentLength: "4096" }, 413, "LAUNCHPAD_PAYLOAD_TOO_LARGE"],
    ["actual size", { body: JSON.stringify({ input: { body: "x".repeat(2_000), link: "https://e.x/" } }) }, 413, "LAUNCHPAD_PAYLOAD_TOO_LARGE"],
    ["not JSON", { body: "{not json" }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["envelope extra field", { body: JSON.stringify({ input: { body: "gm", link: "https://e.x/" }, actor: "me" }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["input extra field", { body: JSON.stringify({ input: { body: "gm", link: "https://e.x/", author: "me" } }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["input missing field", { body: JSON.stringify({ input: { body: "gm" } }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["input size", { body: JSON.stringify({ input: { body: "x".repeat(281), link: "https://e.x/" } }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["input URL", { body: JSON.stringify({ input: { body: "gm", link: "javascript:alert(1)" } }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["proof shape", { body: JSON.stringify({ input: { body: "gm", link: "https://e.x/" }, proof: { address: "0x1" } }) }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["no credential", {}, 401, "LAUNCHPAD_AUTH_REQUIRED"],
    ["two credentials", { authorization: `Bearer ${PRIVY_TOKEN}`, body: PROOF_BODY }, 400, "LAUNCHPAD_REQUEST_INVALID"],
    ["malformed authorization", { authorization: "Basic abc" }, 401, "LAUNCHPAD_AUTH_INVALID"],
  ];
  for (const [label, options, status, code] of cases) {
    const probe = new GuardProbe();
    const response = await probe.handler()(mutationRequest(options), testClient());
    assert.equal(response.status, status, label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
    const body = await response.json() as { requestId: string; error: { code: string } };
    assert.equal(body.error.code, code, label);
    assert.deepEqual(probe.touched, [], `${label}: nothing downstream ran`);
  }
});

test("rate limits run after validation and before authentication", async () => {
  const limited = new GuardProbe();
  limited.limiterAllows = false;
  const refused = await limited.handler()(mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}` }), testClient());
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("retry-after"), "42");
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "LAUNCHPAD_RATE_LIMITED");
  assert.deepEqual(limited.touched, ['limiter:launchpad_telemetry:{"ip":"203.0.113.7"}']);

  const down = new GuardProbe();
  down.limiterFails = true;
  const unavailable = await down.handler()(mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}` }), testClient());
  assert.equal(unavailable.status, 503);
  assert.equal(((await unavailable.json()) as { error: { code: string } }).error.code, "LAUNCHPAD_UNAVAILABLE");
  assert.equal(down.touched.length, 1);
});

test("a refused credential never reaches authorization or the write", async () => {
  for (const [code, status] of [
    ["LAUNCHPAD_AUTH_INVALID", 401],
    ["LAUNCHPAD_AUTH_UNAVAILABLE", 503],
  ] as const) {
    const probe = new GuardProbe();
    probe.privyError = new LaunchpadMutationError(code);
    const response = await probe.handler()(mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}` }), testClient());
    assert.equal(response.status, status);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, code);
    assert.deepEqual(probe.touched, ['limiter:launchpad_telemetry:{"ip":"203.0.113.7"}', "privy:true"]);
  }

  const wallet = new GuardProbe();
  const response = await wallet.handler()(mutationRequest({ body: PROOF_BODY }), testClient());
  assert.equal(response.status, 401);
  assert.deepEqual(wallet.touched, ['limiter:launchpad_telemetry:{"ip":"203.0.113.7"}', "identity.checkWalletProof"]);
});

test("responses and metrics never carry tokens, signatures, challenges, or Privy subjects", async () => {
  const secrets = [PRIVY_TOKEN, PRIVY_DID, SIGNATURE, PROOF_MESSAGE, "secret-nonce", CSRF];
  const { lines, result } = await captureMetrics(async () => {
    const texts: string[] = [];
    for (const request of [
      mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}`, body: PROOF_BODY }),
      mutationRequest({ body: PROOF_BODY }),
      mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}` }),
      mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}`, body: "{\"input\":" }),
    ]) {
      const probe = new GuardProbe();
      probe.privyError = new LaunchpadMutationError("LAUNCHPAD_AUTH_UNAVAILABLE");
      const response = await probe.handler()(request, testClient());
      texts.push(JSON.stringify([...response.headers]), await response.text());
    }
    return texts;
  });
  assert.ok(lines.length > 0, "the boundary reports metrics");
  for (const text of [...result, ...lines]) {
    for (const secret of secrets) {
      assert.ok(!text.includes(secret), `leaked ${secret} in ${text}`);
    }
  }
  const metrics = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const mutations = metrics.filter((metric) => metric.metric === "launchpad.mutation");
  const refusals = metrics.filter((metric) => metric.metric === "http.error");
  assert.equal(mutations.length, 4, "each request retains the mutation outcome");
  assert.equal(refusals.length, 4, "every refused write has an unsampled error log");
  for (const metric of metrics) {
    assert.ok(metric.metric === "launchpad.mutation" || metric.metric === "http.error");
    const allowed = metric.metric === "http.error"
      ? ["level", "metric", "at", "requestId", "route", "code", "status"]
      : ["level", "metric", "at", "requestId", "action", "code", "credential", "outcome", "status"];
    assert.equal(metric.level, 30, "Pino retains the info envelope");
    assert.deepEqual(Object.keys(metric).filter((key) => !allowed.includes(key)), []);
  }
  for (const refusal of refusals) {
    const mutation = mutations.find((metric) => metric.requestId === refusal.requestId && metric.code === refusal.code && metric.status === refusal.status);
    assert.ok(mutation, "the public error log correlates with its mutation outcome");
    assert.equal(refusal.code, mutation.code);
    assert.equal(refusal.status, mutation.status);
    assert.ok(result.some((text) => text.includes(String(refusal.requestId))), "the same reference reaches the response");
  }
});

// --- Signature classification and service configuration ---

const SIGNED = new TextEncoder().encode("BLAST.FUN launchpad wallet proof\nNonce: fixture");

async function zkLoginSignature(): Promise<string> {
  const user = (await syntheticSlushSigner.signPersonalMessage(SIGNED)).signature;
  return getZkLoginSignature({
    inputs: {
      addressSeed: "1",
      headerBase64: "aGVhZGVy",
      issBase64Details: { indexMod4: 0, value: Buffer.from('"iss":"https://accounts.google.com",').toString("base64url") },
      proofPoints: { a: ["1", "2", "3"], b: [["1", "2"], ["3", "4"], ["5", "6"]], c: ["1", "2", "3"] },
    },
    maxEpoch: 10,
    userSignature: user,
  });
}

test("malformed signatures are invalid, never a verifier outage", async () => {
  const address = syntheticSlushSigner.toSuiAddress();
  const good = (await syntheticSlushSigner.signPersonalMessage(SIGNED)).signature;
  const bytes = Buffer.from(good, "base64");
  assert.equal(bytes.length, 97);
  assert.equal(await verifyLaunchpadSignature(SIGNED, good, address), true);
  for (const [label, signature] of [
    ["96 bytes", bytes.subarray(0, 96).toString("base64")],
    ["98 bytes", Buffer.concat([bytes, Buffer.from([0])]).toString("base64")],
    ["tail swapped", `${good.slice(0, -4)}AAAA`],
    ["not base64", "!!!!"],
    ["empty scheme payload", Buffer.from([0]).toString("base64")],
    ["unknown scheme flag", Buffer.concat([Buffer.from([0x7f]), bytes.subarray(1)]).toString("base64")],
    ["zkLogin flag, junk", Buffer.concat([Buffer.from([5]), Buffer.alloc(40, 1)]).toString("base64")],
  ] as const) {
    assert.equal(await verifyLaunchpadSignature(SIGNED, signature, address), false, label);
  }
});

/** A gRPC status error as the Sui gRPC client raises it (`RpcError`). */
function rpcError(code: string): Error {
  return Object.assign(new Error(`${code}: fixture`), { name: "RpcError", code });
}

function throwing(error: unknown) {
  return async (): Promise<boolean> => {
    throw error;
  };
}

/** A one-member multisig whose only member is zkLogin, with junk proof inputs. */
async function zkLoginMemberMultisig(): Promise<{ signature: string; address: string }> {
  const multisig = MultiSigPublicKey.fromPublicKeys({
    threshold: 1,
    publicKeys: [{
      publicKey: toZkLoginPublicIdentifier(1n, "https://accounts.google.com", { legacyAddress: false }),
      weight: 1,
    }],
  });
  return {
    signature: multisig.combinePartialSignatures([await zkLoginSignature()]),
    address: multisig.toSuiAddress(),
  };
}

/** A one-member multisig whose zkLogin member is 40 junk bytes (R-003's probe). */
function junkZkLoginMemberMultisig(): string {
  const body = suiBcs.MultiSig.serialize({
    sigs: [{ ZkLogin: Array.from(Buffer.alloc(40, 7)) }],
    bitmap: 1,
    multisigPk: { pkMap: [{ pubKey: { ZkLogin: Array.from(Buffer.alloc(33, 2)) }, weight: 1 }], threshold: 1 },
  }).toBytes();
  return Buffer.concat([Buffer.from([3]), Buffer.from(body)]).toString("base64");
}

const INVALID_INPUT_STATUSES = ["INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE"];
const OUTAGE_STATUSES = ["UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED", "INTERNAL", "UNKNOWN", "CANCELLED", "ABORTED"];

test("a fullnode that rejects the signature's input makes it invalid, not an outage", async () => {
  const address = syntheticSlushSigner.toSuiAddress();
  const signature = await zkLoginSignature();
  for (const status of INVALID_INPUT_STATUSES) {
    assert.equal(await verifyLaunchpadSignature(SIGNED, signature, address, throwing(rpcError(status))), false, status);
  }
  assert.equal(await verifyLaunchpadSignature(SIGNED, signature, address, async () => false), false, "verified false");
});

test("only a fullnode outage or transport failure is reported as unavailable", async () => {
  const address = syntheticSlushSigner.toSuiAddress();
  const zkLogin = await zkLoginSignature();
  const failures: Array<[string, unknown]> = [
    ...OUTAGE_STATUSES.map((status): [string, unknown] => [status, rpcError(status)]),
    ["fetch failed", new TypeError("fetch failed")],
    ["socket reset", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["aborted", new DOMException("The operation was aborted.", "AbortError")],
  ];
  for (const [name, error] of failures) {
    await assert.rejects(
      verifyLaunchpadSignature(SIGNED, zkLogin, address, throwing(error)),
      (thrown) => thrown === error,
      name,
    );
  }

  // Signatures verified locally never need the network: any throw is a malformed signature.
  const ed25519 = (await syntheticSlushSigner.signPersonalMessage(SIGNED)).signature;
  assert.equal(await verifyLaunchpadSignature(SIGNED, ed25519, address, throwing(rpcError("UNAVAILABLE"))), false);
  assert.equal(await verifyLaunchpadSignature(SIGNED, ed25519, address, throwing(new TypeError("fetch failed"))), false);
});

test("launchpad reports a failed multisig with a zkLogin member as an invalid proof", async () => {
  const member = await zkLoginMemberMultisig();
  assert.equal(
    await verifyLaunchpadSignature(SIGNED, member.signature, member.address, async () => false),
    false,
    "fullnode rejected the proof",
  );
  assert.equal(
    await verifyLaunchpadSignature(SIGNED, junkZkLoginMemberMultisig(), member.address, async () => false),
    false,
    "40 junk bytes",
  );
  for (const error of [rpcError("UNAVAILABLE"), new TypeError("fetch failed")]) {
    assert.equal(await verifyLaunchpadSignature(SIGNED, member.signature, member.address, throwing(error)), false);
  }
});

test("the identity service refuses a short or missing subject pepper", () => {
  const dependencies = {
    limiter: new GuardProbe().limiter,
    verifyPrivySession: async () => ({ privyDid: PRIVY_DID, suiWalletAddress: null }),
  };
  for (const subjectPepper of ["", "p".repeat(31)]) {
    assert.throws(
      () => new LaunchpadIdentityService(new GuardProbe().pool, { ...dependencies, subjectPepper }),
      /at least 32 characters/,
    );
  }
  assert.ok(new LaunchpadIdentityService(new GuardProbe().pool, { ...dependencies, subjectPepper: "p".repeat(32) }));
});

test("prepare runs only after the credential, hands its input to the write, and a refusal opens no transaction", async () => {
  const refused = new GuardProbe();
  refused.prepare = async (input) => input;
  refused.privyError = new LaunchpadMutationError("LAUNCHPAD_AUTH_INVALID");
  const unauthenticated = await refused.handler()(mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}` }), testClient());
  assert.equal(unauthenticated.status, 401);
  assert.ok(!refused.touched.includes("prepare"), "a refused credential never reaches prepare");

  const prepared = new GuardProbe();
  prepared.poolWorks = true;
  prepared.prepare = async (input) => ({ ...input, body: `${input.body} (prepared)` });
  const accepted = await prepared.handler()(mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}` }), testClient());
  assert.equal(accepted.status, 201);
  assert.deepEqual(prepared.written, { body: "gm (prepared)", link: "https://example.com/x" });
  assert.ok(
    prepared.touched.indexOf("prepare") < prepared.touched.indexOf("pool.connect"),
    "prepare finishes before the transaction opens",
  );

  const throwing = new GuardProbe();
  throwing.poolWorks = true;
  throwing.proofValid = true;
  throwing.prepare = async () => {
    throw new LaunchpadMutationError("LAUNCHPAD_REQUEST_INVALID");
  };
  const invalid = await throwing.handler()(mutationRequest({ body: PROOF_BODY }), testClient());
  assert.equal(invalid.status, 400);
  assert.deepEqual(throwing.touched, [
    'limiter:launchpad_telemetry:{"ip":"203.0.113.7"}',
    "identity.checkWalletProof",
    "prepare",
  ], "no transaction opens and the proof is never consumed");
});

test("prepare learns who is writing: the Privy actor, or the checked proof's wallet before it is consumed", async () => {
  const seen: LaunchpadActor[] = [];
  const privy = new GuardProbe();
  privy.poolWorks = true;
  privy.prepare = async (input, { actor }) => {
    seen.push(actor);
    return input;
  };
  assert.equal((await privy.handler()(mutationRequest({ authorization: `Bearer ${PRIVY_TOKEN}` }), testClient())).status, 201);

  const proven = new GuardProbe();
  proven.proofValid = true;
  proven.prepare = async (input, { actor }) => {
    seen.push(actor);
    throw new LaunchpadMutationError("LAUNCHPAD_FORBIDDEN");
  };
  const refused = await proven.handler()(mutationRequest({ body: PROOF_BODY }), testClient());
  assert.equal(refused.status, 403);
  assert.ok(!proven.touched.includes("identity.consumeWalletProof"), "a refusal in prepare spends no proof");
  assert.deepEqual(seen, [
    { method: "privy", subjectKey: "k".repeat(64), walletAddress: null },
    { method: "wallet_proof", walletAddress: ADDRESS },
  ]);
});
