import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { allowlistedEligibility, openEligibility, verifyAllowlistProof } from "@interest-protocol/blast-sdk/presale";
import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { createPresaleApiKeyVerifier } from "../api-keys/repository.ts";
import { presaleIdentityFixture, SUI_TESTNET_CHAIN_IDENTIFIER } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate, readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import type { PresaleDeploymentState } from "@blast/core/modules/presale/deployment/contracts.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { presaleChainFixture, type PresaleChainFixture } from "../../../../../core/test/fixtures/modules/presale/allowlists/fixtures.ts";
import { createPartnerV1Read } from "../../partner-api/v1/route.ts";
import { createAllowlistBindingRoutes } from "./binding-routes.ts";
import { presaleEligibilityReader } from "./eligibility.ts";
import { createAllowlistRoutes } from "./routes.ts";

/**
 * T-014 (AC-055..AC-061, AC-004, AC-062, AC-064, AC-107):
 * `POST /api/presale/allowlists/{allowlist_id}/bind` and
 * `GET /api/presale/presales/{presale_id}/proof` as Request -> Response
 * through the real route kit, deployment gate, API key verifier and rate
 * limiter over disposable Postgres, with the SDK's `PresaleClient` reading
 * presales from a fixture node.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const ORIGIN = "https://blast.fun";
const APP_ID = "presale-binding-app";
const NOW = Math.floor(Date.now() / 1_000);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createPresaleValidator();
const USDC = `0x${"d".repeat(64)}::usdc::USDC`;
const OPERATOR_TOKEN = "presale-operator-fixture-token-0123456789";
const IDENTITY = readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) });
/**
 * A fixed limiter clock mid-window (20 s into the minute and the hour), so a
 * burst never straddles a window boundary. Every test counts against fresh
 * accounts, keys and IPs, so the shared windows do not interfere.
 */
const LIMITER_NOW = new Date("2026-10-02T12:00:20.000Z");

function privyToken(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const newDid = () => `did:privy:binding-${randomUUID().slice(0, 8)}`;
const randomWallet = () => `0x${randomBytes(32).toString("hex")}`;
const randomIp = () => `198.51.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;

type Setup = Readonly<{ node?: PresaleChainFixture; state?: PresaleDeploymentState; chainIdentifier?: string }>;

function routes(pool: Pool, setup: Setup = {}) {
  const node = setup.node ?? presaleChainFixture();
  const chain = setup.chainIdentifier ? presaleChainFixture(setup.chainIdentifier) : node;
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    verifyApiKey: createPresaleApiKeyVerifier(() => pool),
    limiter: new PostgresRateLimitEnforcer({ pool, subjectPepper: "binding-fixture-pepper-0123456789", clock: () => LIMITER_NOW }),
    deployment: createPresaleDeploymentGate({ state: setup.state ?? IDENTITY, node: async () => chain }),
  });
  return {
    node,
    allowlists: createAllowlistRoutes({ kit, pool: () => pool, allowedQuotes: async () => null }),
    bindings: createAllowlistBindingRoutes({ kit, pool: () => pool, eligibility: presaleEligibilityReader({ client: () => node }) }),
  };
}

type Credentials = Readonly<{ did?: string; apiKey?: string; origin?: string; ip?: string }>;

function headers(credentials: Credentials, ip: string): Record<string, string> {
  return {
    "x-forwarded-for": ip,
    ...(credentials.did ? { authorization: `Bearer ${privyToken(credentials.did)}` } : {}),
    ...(credentials.apiKey ? { "x-blast-api-key": credentials.apiKey } : {}),
    ...(credentials.origin ? { origin: credentials.origin } : {}),
  };
}

function createRequest(entries: readonly { wallet: string; cap: string }[], credentials: Credentials): readonly [Request, ReturnType<typeof testClient>] {
  const ip = credentials.ip ?? randomIp();
  const csv = ["wallet,cap", ...entries.map((entry) => `${entry.wallet},${entry.cap}`)].join("\n") + "\n";
  const form = new FormData();
  form.set("file", new Blob([csv], { type: "text/csv" }), "allowlist.csv");
  form.set("quote", USDC);
  return [new Request(`${ORIGIN}/api/presale/allowlists`, { method: "POST", body: form, headers: headers(credentials, ip) }), testClient(ip)] as const;
}

function bindRequest(allowlistId: string, body: unknown, credentials: Credentials): readonly [Request, ReturnType<typeof testClient>] {
  const ip = credentials.ip ?? randomIp();
  return [new Request(`${ORIGIN}/api/presale/allowlists/${allowlistId}/bind`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...headers(credentials, ip), "content-type": "application/json" },
  }), testClient(ip)] as const;
}

function proofRequest(presaleId: string, query: string, credentials: Credentials = {}): readonly [Request, ReturnType<typeof testClient>] {
  const ip = credentials.ip ?? randomIp();
  return [new Request(`${ORIGIN}/api/presale/presales/${presaleId}/proof?${query}`, { headers: headers(credentials, ip) }), testClient(ip)] as const;
}

async function ok(response: Response, schema: "allowlist-response" | "allowlist-bind-response" | "allowlist-proof-response", status = 200) {
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, status, JSON.stringify(body).slice(0, 400));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body;
}

async function refused(response: Response, code: PresaleErrorCode): Promise<Response> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, code, JSON.stringify(body).slice(0, 400));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.has("retry-after"), PRESALE_ERRORS[code].retryAfter, `${code} Retry-After`);
  return response;
}

type Manifest = Readonly<{ id: string; root: string; leafCount: bigint; entries: { wallet: string; cap: string }[] }>;

/** Uploads `count` fresh wallets (caps 1..count) as `credentials`. */
async function manifest(allowlists: ReturnType<typeof routes>["allowlists"], count: number, credentials: Credentials, entries?: Manifest["entries"]): Promise<Manifest> {
  const rows = entries ?? Array.from({ length: count }, (_, index) => ({ wallet: randomWallet(), cap: String(index + 1) }));
  const body = await ok(await allowlists.create(...createRequest(rows, credentials)), "allowlist-response", 201);
  return { id: String(body.allowlist_id), root: String(body.root), leafCount: BigInt(String(body.leaf_count)), entries: rows };
}

async function bindingRows(pool: Pool, presaleId: string) {
  return (await pool.query<{ allowlist_id: string; bound_by: string; bound_at: Date }>(
    "SELECT allowlist_id, bound_by, bound_at FROM presale_allowlist_bindings WHERE presale_id = $1",
    [presaleId],
  )).rows;
}

/** Runs the operator script against the test database; stdout is its one JSON line. */
function operatorCommand(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", new URL("../../../../scripts/presale-api-keys.ts", import.meta.url).pathname, ...args],
    {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        DATABASE_URL: databaseUrl,
        MISSION_CONTROL_OPERATOR_ALLOWED_ID: "presale-ops",
        MISSION_CONTROL_OPERATOR_TOKEN_SHA256: createHash("sha256").update(OPERATOR_TOKEN).digest("hex"),
        BLAST_OPERATOR_ID: "presale-ops",
        BLAST_OPERATOR_TOKEN: OPERATOR_TOKEN,
      },
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let shared: Pool | null = null;
async function database(): Promise<Pool> {
  assert.ok(databaseUrl);
  if (!shared) {
    shared = createPool(databaseUrl, { max: 8 });
    await migrateDatabase(shared);
  }
  return shared;
}
test.after(async () => {
  await shared?.end();
});

test("default uploads preserve individual caps and proofs without adding wallets", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  const did = newDid();
  const entries = [{ wallet: randomWallet(), cap: "1" }, { wallet: randomWallet(), cap: "999" }];
  const listed = await manifest(allowlists, 2, { did }, entries);
  assert.equal(listed.leafCount, 2n);
  const sale = node.createPresale(`uploaded-caps-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));
  await ok(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "allowlist-bind-response");
  for (const { wallet, cap } of entries) {
    const proof = await ok(await bindings.proof(...proofRequest(sale, `wallet=${wallet}`)), "allowlist-proof-response");
    assert.equal(proof.wallet_cap, cap);
    assert.equal(verifyAllowlistProof(listed.root, listed.leafCount, {
      index: BigInt(String(proof.index)), wallet, walletCap: BigInt(cap), proof: proof.proof as string[],
    }), true);
  }
});

test("T-014-AC-1: bind succeeds only for an allowlisted sale with the manifest's root and leaf count, owners only, idempotently", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  const did = newDid();
  const listed = await manifest(allowlists, 3, { did });
  const other = await manifest(allowlists, 4, { did });
  const sale = node.createPresale(`bind-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));
  const open = node.createPresale(`bind-open-${listed.id}`, openEligibility(10n, 5n, 1n));
  const wrongCount = node.createPresale(`bind-count-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount + 1n));
  const missing = `0x${randomBytes(32).toString("hex")}`;

  // A different root, an open sale, a different leaf count, no sale at all: root_mismatch, nothing stored.
  for (const [allowlistId, presaleId] of [[other.id, sale], [listed.id, open], [listed.id, wrongCount], [listed.id, missing]]) {
    await refused(await bindings.bind(...bindRequest(allowlistId, { presale_id: presaleId }, { did })), "root_mismatch");
    assert.deepEqual(await bindingRows(pool, presaleId), []);
  }

  // Someone else's manifest is not_found, whoever asks.
  await refused(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did: newDid() })), "not_found");
  await refused(await bindings.bind(...bindRequest(randomUUID(), { presale_id: sale }, { did })), "not_found");
  assert.deepEqual(await bindingRows(pool, sale), []);

  const expected = { allowlist_id: listed.id, presale_id: sale, root: listed.root, leaf_count: String(listed.leafCount) };
  const before = node.reads;
  assert.deepEqual(await ok(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "allowlist-bind-response"), expected);
  assert.equal(node.reads, before + 1, "the sale is read on chain through the SDK");
  const [first] = await bindingRows(pool, sale);
  assert.deepEqual({ allowlist_id: first.allowlist_id, bound_by: first.bound_by }, { allowlist_id: listed.id, bound_by: `account:${did}` });

  // A repeat bind is 200 and changes nothing.
  assert.deepEqual(await ok(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "allowlist-bind-response"), expected);
  assert.deepEqual(await bindingRows(pool, sale), [first]);

  // Another owner's manifest of the same rows binds (200) but the first binding stays.
  const otherDid = newDid();
  const twin = await manifest(allowlists, 0, { did: otherDid }, listed.entries);
  assert.equal(twin.root, listed.root);
  const twinBody = await ok(await bindings.bind(...bindRequest(twin.id, { presale_id: sale }, { did: otherDid })), "allowlist-bind-response");
  assert.deepEqual(twinBody, { ...expected, allowlist_id: twin.id });
  assert.deepEqual(await bindingRows(pool, sale), [first]);

  // Malformed input.
  await refused(await bindings.bind(...bindRequest("not-a-uuid", { presale_id: sale }, { did })), "invalid_parameter");
  for (const body of [{}, { presale_id: sale, extra: 1 }, { presale_id: sale.toUpperCase().replace("0X", "0x") }, { presale_id: "0x2" }, "not json"]) {
    await refused(await bindings.bind(...bindRequest(listed.id, body, { did })), "invalid_request");
  }
  await refused(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, {})), "unauthorized");

  // The body is at most 1 KiB: exactly 1,024 bytes binds, one more is body_too_large.
  const exact = JSON.stringify({ presale_id: sale });
  const padded = (size: number) => exact + " ".repeat(size - exact.length);
  assert.equal(Buffer.byteLength(padded(1_024)), 1_024);
  assert.deepEqual(await ok(await bindings.bind(...bindRequest(listed.id, padded(1_024), { did })), "allowlist-bind-response"), expected);
  await refused(await bindings.bind(...bindRequest(listed.id, padded(1_025), { did })), "body_too_large");
  assert.deepEqual(await bindingRows(pool, sale), [first]);
});

test("T-014-AC-2: a bound sale serves proofs that verify against the on-chain root; unlisted wallets and open sales are not_eligible", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  const did = newDid();
  const listed = await manifest(allowlists, 5, { did });
  const sale = node.createPresale(`proof-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));
  await ok(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "allowlist-bind-response");

  // The root and leaf count the chain holds, read independently of the routes.
  const onChain = (await import("@interest-protocol/blast-sdk/presale")).PresaleClient;
  assert.ok(IDENTITY.status === "ready");
  const eligibility = (await new onChain(node, IDENTITY.identity.presale).getPresale(sale)).eligibility;
  assert.equal(eligibility.kind, "allowlisted");

  const reads = node.reads;
  for (const [index, entry] of listed.entries.entries()) {
    const body = await ok(await bindings.proof(...proofRequest(sale, `wallet=${entry.wallet}`)), "allowlist-proof-response");
    assert.equal(body.index, String(index));
    assert.equal(body.wallet_cap, entry.cap);
    for (const node of body.proof as string[]) assert.match(node, /^[0-9a-f]{64}$/);
    assert.equal(
      verifyAllowlistProof(eligibility.root, eligibility.leafCount, {
        index: BigInt(String(body.index)),
        wallet: entry.wallet,
        walletCap: BigInt(String(body.wallet_cap)),
        proof: body.proof as string[],
      }),
      true,
      `entry ${index}`,
    );
  }
  assert.equal(node.reads, reads, "a bound sale is served from the binding");

  await refused(await bindings.proof(...proofRequest(sale, `wallet=${randomWallet()}`)), "not_eligible");
  const open = node.createPresale(`proof-open-${listed.id}`, openEligibility(10n, 5n, 1n));
  await refused(await bindings.proof(...proofRequest(open, `wallet=${listed.entries[0].wallet}`)), "not_eligible");
  await refused(await bindings.proof(...proofRequest(`0x${randomBytes(32).toString("hex")}`, `wallet=${listed.entries[0].wallet}`)), "not_eligible");
  assert.deepEqual(await bindingRows(pool, open), []);

  // Malformed path or query: invalid_parameter (CL-21).
  for (const [presaleId, query] of [
    [sale, ""],
    [sale, "wallet=0x2"],
    [sale, `wallet=${listed.entries[0].wallet.toUpperCase().replace("0X", "0x")}`],
    [sale, `wallet=${listed.entries[0].wallet}&wallet=${listed.entries[1].wallet}`],
    ["0x2", `wallet=${listed.entries[0].wallet}`],
    ["not-an-id", `wallet=${listed.entries[0].wallet}`],
  ]) {
    await refused(await bindings.proof(...proofRequest(presaleId, query)), "invalid_parameter");
  }
});

test("partner v1: a key's proof read serves the bound proof; an unlisted wallet is not_eligible", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  const did = newDid();
  const listed = await manifest(allowlists, 2, { did });
  const sale = node.createPresale(`partner-proof-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));
  await ok(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "allowlist-bind-response");
  const unexpected = async (): Promise<Response> => {
    throw new Error("Unexpected v1 read");
  };
  const read = createPartnerV1Read({
    defillama: unexpected, presales: unexpected, featured: unexpected, presale: unexpected, prices: unexpected,
    discovery: unexpected, wallet_launches: unexpected, search: unexpected, market: unexpected, coin_metadata: unexpected,
    presale_proof: bindings.proof,
  });
  const v1 = (wallet: string) => {
    const ip = randomIp();
    return read(new Request(`${ORIGIN}/api/v1/presales/${sale}/proof?wallet=${wallet}`, {
      headers: { "x-forwarded-for": ip, "x-blast-partner-key": "stripped-before-the-handler" },
    }), testClient(ip));
  };

  const { wallet, cap } = listed.entries[1];
  const served = await v1(wallet);
  const proof = (await served.json()) as Record<string, unknown>;
  assert.equal(served.status, 200, JSON.stringify(proof).slice(0, 400));
  assert.deepEqual(validator.validate("allowlist-proof-response", proof).errors, []);
  assert.equal(served.headers.get("cache-control"), "private, no-store");
  assert.equal(served.headers.get("x-blast-api-version"), "1");
  assert.equal(proof.wallet_cap, cap);
  assert.equal(verifyAllowlistProof(listed.root, listed.leafCount, {
    index: BigInt(String(proof.index)), wallet, walletCap: BigInt(cap), proof: proof.proof as string[],
  }), true);

  const unlisted = await v1(randomWallet());
  assert.equal(unlisted.status, 404);
  assert.equal(((await unlisted.json()) as { error: { code: string } }).error.code, "not_eligible");
});

test("T-014-AC-3: an unbound allowlisted sale auto-binds a stored manifest with its root and leaf count, else allowlist_unknown", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  const listed = await manifest(allowlists, 3, { did: newDid() });
  const sale = node.createPresale(`auto-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));
  assert.deepEqual(await bindingRows(pool, sale), []);

  const body = await ok(await bindings.proof(...proofRequest(sale, `wallet=${listed.entries[2].wallet}`)), "allowlist-proof-response");
  assert.equal(body.index, "2");
  assert.equal(verifyAllowlistProof(listed.root, listed.leafCount, {
    index: 2n,
    wallet: listed.entries[2].wallet,
    walletCap: 3n,
    proof: body.proof as string[],
  }), true);
  const [bound] = await bindingRows(pool, sale);
  assert.deepEqual({ allowlist_id: bound.allowlist_id, bound_by: bound.bound_by }, { allowlist_id: listed.id, bound_by: "proof_route" });
  const reads = node.reads;
  await ok(await bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`)), "allowlist-proof-response");
  assert.equal(node.reads, reads, "after the auto-bind the sale is served from the binding");
  await refused(await bindings.proof(...proofRequest(sale, `wallet=${randomWallet()}`)), "not_eligible");

  // An unbound allowlisted sale whose root no manifest has: allowlist_unknown, nothing bound.
  const unknown = node.createPresale(`unknown-${listed.id}`, allowlistedEligibility(randomBytes(32).toString("hex"), 3n));
  await refused(await bindings.proof(...proofRequest(unknown, `wallet=${listed.entries[0].wallet}`)), "allowlist_unknown");
  // The same root with another leaf count is another allowlist.
  const recounted = node.createPresale(`recount-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount + 1n));
  await refused(await bindings.proof(...proofRequest(recounted, `wallet=${listed.entries[0].wallet}`)), "allowlist_unknown");
  assert.deepEqual([...await bindingRows(pool, unknown), ...await bindingRows(pool, recounted)], []);
});

test("T-014-AC-4: without an identity, or on another chain, bind and proof answer 503 before anything else", { skip }, async () => {
  const pool = await database();
  const did = newDid();
  const configured = routes(pool);
  const listed = await manifest(configured.allowlists, 2, { did });
  const sale = configured.node.createPresale(`gate-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));

  const unconfigured = routes(pool, { node: configured.node, state: readPresaleDeploymentIdentity({}) });
  await refused(await unconfigured.bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "deployment_unavailable");
  await refused(await unconfigured.bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`)), "deployment_unavailable");

  const elsewhere = routes(pool, { node: configured.node, chainIdentifier: SUI_TESTNET_CHAIN_IDENTIFIER });
  await refused(await elsewhere.bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "deployment_mismatch");
  await refused(await elsewhere.bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`)), "deployment_mismatch");

  // A node that fails the presale read is deployment_unavailable too, and nothing is bound.
  configured.node.failing = true;
  await refused(await configured.bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "deployment_unavailable");
  await refused(await configured.bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`)), "deployment_unavailable");
  assert.deepEqual(await bindingRows(pool, sale), []);
});

test("AC-107: proofs count in presale_proof (120 a minute per IP); binds count in presale_allowlist", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  const did = newDid();
  const listed = await manifest(allowlists, 1, { did });
  const sale = node.createPresale(`limits-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));
  const ip = randomIp();
  // A default upload contains only its original CSV wallet.
  const single = await ok(await bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`, { ip })), "allowlist-proof-response");
  assert.equal(single.index, "0");
  assert.equal(single.wallet_cap, "1");
  assert.equal(verifyAllowlistProof(listed.root, listed.leafCount, { index: 0n, wallet: listed.entries[0].wallet, walletCap: 1n, proof: single.proof as string[] }), true);
  for (let attempt = 2; attempt <= 120; attempt += 1) {
    assert.equal((await bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`, { ip }))).status, 200);
  }
  const limited = await refused(await bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`, { ip })), "rate_limited");
  assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
  assert.equal((await bindings.proof(...proofRequest(sale, `wallet=${listed.entries[0].wallet}`, { ip: randomIp() }))).status, 200);

  // One create spent; 19 binds use up the account's hour.
  for (let attempt = 1; attempt <= 19; attempt += 1) {
    await ok(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "allowlist-bind-response");
  }
  await refused(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { did })), "rate_limited");
});

test("T-014-AC-5: following the agent skill with an API key ends with a bound manifest and a verifying proof", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  // Step 0: an operator issues the agent's key.
  const issued = operatorCommand(["create", "skill-walkthrough-agent"]);
  assert.equal(issued.status, 0, issued.stderr);
  const { apiKey } = JSON.parse(issued.stdout) as { apiKey: { id: string; key: string } };
  const agent = { apiKey: apiKey.key, origin: "https://agent.example" };

  // Step 1: the agent uploads its CSV with X-Blast-Api-Key.
  const listed = await manifest(allowlists, 4, agent);
  // Step 2: the creator makes the sale with allowlistedEligibility(root, leaf_count) from the create response.
  const sale = node.createPresale(`skill-${listed.id}`, allowlistedEligibility(listed.root, listed.leafCount));
  // Step 3: the agent binds with the same key.
  const bound = await ok(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, agent)), "allowlist-bind-response");
  assert.deepEqual(bound, { allowlist_id: listed.id, presale_id: sale, root: listed.root, leaf_count: String(listed.leafCount) });
  const [binding] = await bindingRows(pool, sale);
  assert.equal(binding.bound_by, `api_key:${apiKey.id}`);
  // Step 4: any wallet fetches its proof, publicly.
  const proof = await ok(await bindings.proof(...proofRequest(sale, `wallet=${listed.entries[1].wallet}`)), "allowlist-proof-response");
  assert.equal(verifyAllowlistProof(listed.root, listed.leafCount, {
    index: 1n,
    wallet: listed.entries[1].wallet,
    walletCap: 2n,
    proof: proof.proof as string[],
  }), true);

  // Another key cannot bind this manifest; a revoked key cannot bind at all.
  const second = operatorCommand(["create", "skill-other-agent"]);
  const otherKey = (JSON.parse(second.stdout) as { apiKey: { key: string } }).apiKey.key;
  await refused(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, { apiKey: otherKey })), "not_found");
  assert.equal(operatorCommand(["revoke", apiKey.id]).status, 0);
  await refused(await bindings.bind(...bindRequest(listed.id, { presale_id: sale }, agent)), "unauthorized");
});

/** Runs `work` with `console.info` captured, and returns the allowlist binding outcomes it recorded. */
async function bindingOutcomes<T>(work: () => Promise<T>): Promise<{ result: T; outcomes: string[] }> {
  const original = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await work();
    const outcomes = lines
      .map((line) => { try { return JSON.parse(line) as { metric?: string; outcome?: string }; } catch { return {}; } })
      .filter((entry) => entry.metric === "presale.allowlist" && ["bound", "auto_bound", "already_bound"].includes(entry.outcome ?? ""))
      .map((entry) => String(entry.outcome))
      .sort();
    return { result, outcomes };
  } finally {
    console.info = original;
  }
}

test("racing binds, and an auto-bind racing a bind, leave exactly one binding and every caller served", { skip }, async () => {
  const pool = await database();
  const { node, allowlists, bindings } = routes(pool);
  const alice = newDid();
  const bob = newDid();
  const first = await manifest(allowlists, 6, { did: alice });
  const twin = await manifest(allowlists, 0, { did: bob }, first.entries);
  assert.equal(twin.root, first.root);

  // Three binds of two same-root manifests by two owners, at once.
  const raced = node.createPresale(`race-binds-${first.id}`, allowlistedEligibility(first.root, first.leafCount));
  const binds = await bindingOutcomes(() => Promise.all([
    bindings.bind(...bindRequest(first.id, { presale_id: raced }, { did: alice })),
    bindings.bind(...bindRequest(twin.id, { presale_id: raced }, { did: bob })),
    bindings.bind(...bindRequest(first.id, { presale_id: raced }, { did: alice })),
  ]));
  const bodies = await Promise.all(binds.result.map((response) => ok(response, "allowlist-bind-response")));
  assert.deepEqual(bodies.map((body) => body.allowlist_id), [first.id, twin.id, first.id], "each caller hears its own manifest");
  const rows = await bindingRows(pool, raced);
  assert.equal(rows.length, 1);
  assert.ok([first.id, twin.id].includes(rows[0].allowlist_id));
  assert.deepEqual(binds.outcomes, ["already_bound", "already_bound", "bound"], "only the insert that won counts as bound");

  // An explicit bind against two proof-route auto-binds on an unbound sale.
  const unbound = node.createPresale(`race-auto-${first.id}`, allowlistedEligibility(first.root, first.leafCount));
  const mixed = await bindingOutcomes(() => Promise.all([
    bindings.bind(...bindRequest(twin.id, { presale_id: unbound }, { did: bob })),
    bindings.proof(...proofRequest(unbound, `wallet=${first.entries[3].wallet}`)),
    bindings.proof(...proofRequest(unbound, `wallet=${first.entries[5].wallet}`)),
  ]));
  const [bound, ...proofs] = mixed.result;
  assert.deepEqual(await ok(bound, "allowlist-bind-response"), {
    allowlist_id: twin.id,
    presale_id: unbound,
    root: first.root,
    leaf_count: String(first.leafCount),
  });
  for (const [position, response] of proofs.entries()) {
    const index = position === 0 ? 3 : 5;
    const body = await ok(response, "allowlist-proof-response");
    assert.equal(body.index, String(index));
    assert.equal(verifyAllowlistProof(first.root, first.leafCount, {
      index: BigInt(index),
      wallet: first.entries[index].wallet,
      walletCap: BigInt(first.entries[index].cap),
      proof: body.proof as string[],
    }), true);
  }
  const mixedRows = await bindingRows(pool, unbound);
  assert.equal(mixedRows.length, 1);
  assert.ok(["account:" + bob, "proof_route"].includes(mixedRows[0].bound_by));
  assert.equal(mixed.outcomes.filter((outcome) => outcome !== "already_bound").length, 1, "exactly one insert counts as a binding");
});
