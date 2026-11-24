import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import { creationPolicyBcs, verifyAllowlistProof } from "@interest-protocol/blast-sdk/presale";
import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate, presaleFixtureObjectId, readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleApiKeyVerifier } from "../api-keys/repository.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { creationPolicyQuotes } from "./policy.ts";
import { createAllowlistRoutes } from "./routes.ts";
import { cardHolderWallets } from "./card-holders.ts";

/**
 * T-013 (AC-049..AC-054, AC-062, AC-063): `POST /api/presale/allowlists` and
 * `GET /api/presale/allowlists/{allowlist_id}` as Request -> Response through
 * the real route kit, a fixture Privy verifier (local key pair), the real API
 * key verifier and rate limiter over disposable Postgres, and the SDK's
 * `PresaleClient` reading a fixture creation policy.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const ORIGIN = "https://blast.fun";
const APP_ID = "presale-allowlist-app";
const NOW = Math.floor(Date.now() / 1_000);
const LIMITER_NOW = new Date("2026-10-02T12:30:00.000Z");
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createPresaleValidator();

const USDC = `0x${"d".repeat(64)}::usdc::USDC`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const MEME = `0x${"e".repeat(64)}::meme::MEME`;
const OPERATOR_TOKEN = "presale-operator-fixture-token-0123456789";

function privyToken(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const newDid = () => `did:privy:allowlist-${randomUUID().slice(0, 8)}`;

/**
 * A Core API client whose only object is the fixture identity's CreationPolicy,
 * allowing `allowed`. With `via`, each read first makes a real HTTP round trip
 * to that URL, so it completes only when the event loop polls the socket.
 */
function policyNode(allowed: readonly string[], via?: string): ClientWithCoreApi & { reads: number } {
  const objectId = presaleFixtureObjectId("creation-policy");
  const content = creationPolicyBcs
    .serialize({
      id: { id: { bytes: objectId } },
      allowed_quotes: [...allowed],
      venues: { parent: objectId, key: null, members: [], delay_ms: 172_800_000n, admissions: [], pending_delay: null },
      partners: { parent: objectId, acceptance_ends_at_ms: { id: presaleFixtureObjectId("creation-policy"), size: 0n } },
    })
    .toBytes();
  const node = {
    reads: 0,
    core: {
      async getObject() {
        node.reads += 1;
        if (via) await (await fetch(via)).text();
        return {
          object: {
            objectId,
            owner: { $kind: "Shared", Shared: { initialSharedVersion: "7" } },
            type: `${presaleFixtureObjectId("presale-package")}::creation_policy::CreationPolicy`,
            content,
          },
        };
      },
    },
  };
  return node as unknown as ClientWithCoreApi & { reads: number };
}

const IDENTITY = readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) });

function routes(pool: Pool, policy: Parameters<typeof creationPolicyQuotes>[0] = { state: IDENTITY, client: () => policyNode([USDC]) }) {
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
    verifyApiKey: createPresaleApiKeyVerifier(() => pool),
    limiter: new PostgresRateLimitEnforcer({ pool, subjectPepper: "allowlist-fixture-pepper-0123456789", clock: () => LIMITER_NOW }),
    deployment: createPresaleDeploymentGate({ environment: {}, node: async () => null }),
  });
  return createAllowlistRoutes({ kit, pool: () => pool, allowedQuotes: creationPolicyQuotes(policy) });
}

type Credentials = Readonly<{ did?: string; apiKey?: string; origin?: string }>;

function headers(credentials: Credentials): Record<string, string> {
  return {
    ...(credentials.did ? { authorization: `Bearer ${privyToken(credentials.did)}` } : {}),
    ...(credentials.apiKey ? { "x-blast-api-key": credentials.apiKey } : {}),
    ...(credentials.origin ? { origin: credentials.origin } : {}),
  };
}

function csvRequest(csv: string, credentials: Credentials, quote = USDC, includeHolders = false): Request {
  const form = new FormData();
  form.set("file", new Blob([csv], { type: "text/csv" }), "allowlist.csv");
  form.set("quote", quote);
  form.set("include_blast_holders", String(includeHolders));
  return new Request(`${ORIGIN}/api/presale/allowlists`, { method: "POST", body: form, headers: headers(credentials) });
}

function jsonRequest(body: unknown, credentials: Credentials): Request {
  return new Request(`${ORIGIN}/api/presale/allowlists`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...headers(credentials), "content-type": "application/json" },
  });
}

function readRequest(id: string, credentials: Credentials): Request {
  return new Request(`${ORIGIN}/api/presale/allowlists/${id}`, { headers: headers(credentials) });
}

const wallet = (index: number) => `0x${(index + 1).toString(16).padStart(64, "0")}`;

/** `count` rows, row i (0-based) with wallet i and cap i + 1. */
function csvRows(count: number, walletOf = wallet): string {
  return ["wallet,cap", ...Array.from({ length: count }, (_, index) => `${walletOf(index)},${index + 1}`)].join("\n") + "\n";
}

async function created(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 201, JSON.stringify(body).slice(0, 400));
  assert.deepEqual(validator.validate("allowlist-response", body).errors, []);
  return body;
}

async function refused(response: Response, code: PresaleErrorCode): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, PRESALE_ERRORS[code].status, JSON.stringify(body).slice(0, 400));
  assert.equal(body.error.code, code, JSON.stringify(body).slice(0, 400));
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  return body.error;
}

async function count(pool: Pool, table: string): Promise<number> {
  return Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
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

test("a valid 10,000-row CSV returns the manifest summary, and every stored proof verifies", { skip }, async (t) => {
  const pool = await database();
  const did = newDid();
  const started = performance.now();
  const body = await created(await routes(pool).create(csvRequest(csvRows(10_000), { did }), testClient()));
  const elapsedMs = Math.round(performance.now() - started);
  t.diagnostic(`10,000-row create: ${elapsedMs} ms`);
  console.log(JSON.stringify({ measurement: "allowlist_create_10000_rows_ms", value: elapsedMs }));

  assert.match(String(body.root), /^[0-9a-f]{64}$/);
  const leafCount = 10_000;
  const totalCap = String(50_005_000);
  assert.equal(body.leaf_count, String(leafCount));
  assert.equal(body.entry_count, leafCount);
  assert.equal(body.total_cap, totalCap, "only the uploaded caps by default");
  assert.deepEqual(body.warnings, []);

  const manifest = await pool.query(
    "SELECT owner_kind, owner_id, quote, root, leaf_count, entry_count, total_cap::text FROM presale_allowlists WHERE id = $1",
    [body.allowlist_id],
  );
  assert.deepEqual(manifest.rows, [{
    owner_kind: "account",
    owner_id: did,
    quote: USDC,
    root: body.root,
    leaf_count: leafCount,
    entry_count: leafCount,
    total_cap: totalCap,
  }]);
  const entries = await pool.query<{ index: number; wallet: string; wallet_cap: string; proof: Buffer[] }>(
    "SELECT index, wallet, wallet_cap::text, proof FROM presale_allowlist_entries WHERE allowlist_id = $1 ORDER BY index",
    [body.allowlist_id],
  );
  assert.equal(entries.rows.length, leafCount);
  for (const entry of entries.rows) {
    assert.equal(entry.wallet, wallet(entry.index), "creator row order is retained");
    assert.equal(entry.wallet_cap, String(entry.index + 1));
    assert.equal(entry.proof.length, Math.ceil(Math.log2(leafCount)));
    const proof = { index: BigInt(entry.index), wallet: entry.wallet, walletCap: BigInt(entry.wallet_cap), proof: entry.proof.map((sibling) => sibling.toString("hex")) };
    assert.equal(verifyAllowlistProof(String(body.root), BigInt(leafCount), proof), true, `row ${entry.index + 1}`);
  }
});

test("the same rows in the same order give the same root; another order another root", { skip }, async () => {
  const pool = await database();
  const allowlists = routes(pool);
  const did = newDid();
  const first = await created(await allowlists.create(csvRequest(csvRows(5), { did }), testClient()));
  const again = await created(await allowlists.create(jsonRequest({
    quote: USDC,
    entries: Array.from({ length: 5 }, (_, index) => ({ wallet: wallet(index), cap: String(index + 1) })),
  }, { did }), testClient()));
  assert.equal(again.root, first.root, "CSV and JSON of the same rows agree");
  assert.notEqual(again.allowlist_id, first.allowlist_id, "each upload is its own manifest");
  const reversed = ["wallet,cap", ...Array.from({ length: 5 }, (_, i) => `${wallet(4 - i)},${5 - i}`)].join("\n");
  assert.notEqual((await created(await allowlists.create(csvRequest(reversed, { did }), testClient()))).root, first.root);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM presale_allowlists WHERE root = $1 AND leaf_count = $2", [first.root, 5])).rows[0].n,
    2,
  );
});

test("invalid rows return invalid_allowlist with row numbers and store nothing", { skip }, async () => {
  const pool = await database();
  const allowlists = routes(pool);
  const did = newDid();
  const before = [await count(pool, "presale_allowlists"), await count(pool, "presale_allowlist_entries")];
  const csv = ["wallet,cap", `${wallet(0)},1`, "0xnope,1", `${wallet(2)},0`, `${wallet(3)},12.5`, `${wallet(4)},18446744073709551616`, `${wallet(0)},3`].join("\n");
  const error = await refused(await allowlists.create(csvRequest(csv, { did }), testClient()), "invalid_allowlist");
  assert.deepEqual(error.rows, [
    { row: 2, reason: "invalid address" },
    { row: 3, reason: "cap must be at least 1" },
    { row: 4, reason: "cap must be a base-10 integer" },
    { row: 5, reason: "cap exceeds the u64 maximum" },
    { row: 6, reason: "duplicate wallet (first on row 1)" },
  ]);
  const many = await refused(await allowlists.create(csvRequest(csvRows(300, () => "0xzz"), { did }), testClient()), "invalid_allowlist");
  assert.equal((many.rows as unknown[]).length, 100);
  assert.deepEqual([await count(pool, "presale_allowlists"), await count(pool, "presale_allowlist_entries")], before);
});

test("over 65,536 rows or a body over 4 MiB returns allowlist_too_large", { skip }, async () => {
  const pool = await database();
  const allowlists = routes(pool);
  const did = newDid();
  const before = await count(pool, "presale_allowlists");
  const short = (index: number) => `0x${(index + 1).toString(16)}`;
  await refused(await allowlists.create(csvRequest(csvRows(65_537, short), { did }), testClient()), "allowlist_too_large");
  const padded = (size: number) => {
    const prefix = JSON.stringify({ quote: USDC, entries: [{ wallet: wallet(0), cap: "1" }] });
    return prefix + " ".repeat(size - prefix.length);
  };
  await refused(await allowlists.create(jsonRequest(padded(4 * 1_024 * 1_024 + 1), { did }), testClient()), "allowlist_too_large");
  assert.equal(await count(pool, "presale_allowlists"), before);
  await created(await allowlists.create(jsonRequest(padded(4 * 1_024 * 1_024), { did }), testClient()));
});

test("a Quote the creation policy does not allow gives quote_not_allowed and still creates the manifest", { skip }, async () => {
  const pool = await database();
  const did = newDid();
  const node = policyNode([USDC, SUI]);
  const allowlists = routes(pool, { state: IDENTITY, client: () => node });
  const disallowed = await created(await allowlists.create(csvRequest(`wallet,cap\n0xb0b,5\n`, { did }, MEME), testClient()));
  assert.deepEqual(disallowed.warnings, [
    { code: "quote_not_allowed", message: "The current creation policy does not allow this Quote; a sale with it cannot be created." },
    { code: "normalized_address", message: "Row 1's address was left-padded to 64 hex characters.", row: 1 },
  ]);
  assert.equal(node.reads, 1, "the policy is read through the SDK's PresaleClient");
  const stored = await pool.query("SELECT quote, warnings FROM presale_allowlists WHERE id = $1", [disallowed.allowlist_id]);
  assert.deepEqual(stored.rows[0], { quote: MEME, warnings: disallowed.warnings });
  // An allowed Quote has no warning, however its type is spelled.
  const allowed = await created(await allowlists.create(csvRequest(`wallet,cap\n${wallet(0)},5\n`, { did }, "0x2::sui::SUI"), testClient()));
  assert.deepEqual(allowed.warnings, []);
  assert.equal((await pool.query("SELECT quote FROM presale_allowlists WHERE id = $1", [allowed.allowlist_id])).rows[0].quote, SUI);
  // Without an identity, or when the policy cannot be read, the warning is skipped and creation works.
  const unconfigured = routes(pool, { state: readPresaleDeploymentIdentity({}), client: () => node });
  assert.deepEqual((await created(await unconfigured.create(csvRequest(`wallet,cap\n${wallet(0)},5\n`, { did }, MEME), testClient()))).warnings, []);
  assert.equal(node.reads, 2, "no identity, no read");
  const failing = routes(pool, {
    state: IDENTITY,
    client: () => ({ core: { getObject: async () => { throw new Error("node down"); } } }) as unknown as ClientWithCoreApi,
  });
  assert.deepEqual((await created(await failing.create(csvRequest(`wallet,cap\n${wallet(0)},5\n`, { did }, MEME), testClient()))).warnings, []);
});

test("at 65,536 rows the Quote warning survives a slow node and normalized_address warnings stay bounded", { skip }, async (t) => {
  const pool = await database();
  // A node that answers each read over a real socket after 200 ms.
  const server = createServer((_request, response) => setTimeout(() => response.end("ok"), 200));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const node = policyNode([USDC], url);
    const allowlists = routes(pool, { state: IDENTITY, client: () => node });
    const did = newDid();
    const short = (index: number) => `0x${(index + 1).toString(16)}`;
    const started = performance.now();
    const creatorCount = 65_536;
    const response = await allowlists.create(csvRequest(csvRows(creatorCount, short), { did }, MEME), testClient());
    const elapsedMs = Math.round(performance.now() - started);
    t.diagnostic(`65,536-row create: ${elapsedMs} ms`);
    console.log(JSON.stringify({ measurement: "allowlist_create_65536_rows_ms", value: elapsedMs }));
    const body = await created(response);
    assert.equal(body.leaf_count, "65536");
    assert.equal(body.entry_count, 65_536);
    assert.equal(node.reads, 1);
    const warnings = body.warnings as Record<string, unknown>[];
    assert.deepEqual(warnings[0], {
      code: "quote_not_allowed",
      message: "The current creation policy does not allow this Quote; a sale with it cannot be created.",
    }, "the build does not run down the policy read's timeout");
    assert.equal(warnings.length, 102, "quote_not_allowed, 100 rows, one summary");
    assert.deepEqual(warnings.slice(1, 101).map((warning) => warning.row), Array.from({ length: 100 }, (_, index) => index + 1));
    assert.deepEqual(warnings[101], { code: "normalized_address", message: `${creatorCount - 100} more rows normalized` });
    assert.ok(JSON.stringify(warnings).length < 16_384, `${JSON.stringify(warnings).length} bytes of warnings`);
    const stored = await pool.query<{ warnings: unknown; bytes: number }>(
      "SELECT warnings, octet_length(warnings::text) AS bytes FROM presale_allowlists WHERE id = $1",
      [body.allowlist_id],
    );
    assert.deepEqual(stored.rows[0].warnings, warnings);
    assert.ok(stored.rows[0].bytes < 16_384);
    assert.deepEqual(await (await allowlists.read(readRequest(String(body.allowlist_id), { did }), testClient())).json(), body);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM presale_allowlist_entries WHERE allowlist_id = $1", [body.allowlist_id])).rows[0].n,
      65_536,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("agent API keys create and read their own manifests without Privy; revoked and unknown keys are unauthorized", { skip }, async () => {
  const pool = await database();
  const allowlists = routes(pool);
  const issued = operatorCommand(["create", "research-agent"]);
  assert.equal(issued.status, 0, issued.stderr);
  const { apiKey } = JSON.parse(issued.stdout) as { apiKey: { id: string; key: string; label: string } };
  assert.match(apiKey.key, /^blast_ak_[A-Za-z0-9_-]{43}$/);
  assert.equal(apiKey.label, "research-agent");
  assert.equal((apiKey as { issuedBy?: string }).issuedBy, "operator:presale-ops", "issuance names its operator");

  const logged: string[] = [];
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    console[name] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }
  let agentManifest: Record<string, unknown>;
  let accountManifest: Record<string, unknown>;
  const did = newDid();
  try {
    // From another origin, with no Authorization: the key alone.
    agentManifest = await created(await allowlists.create(csvRequest(csvRows(3), { apiKey: apiKey.key, origin: "https://agent.example" }), testClient()));
    const read = await allowlists.read(readRequest(String(agentManifest.allowlist_id), { apiKey: apiKey.key }), testClient());
    assert.equal(read.status, 200);
    const readBody = await read.json();
    assert.deepEqual(validator.validate("allowlist-response", readBody).errors, []);
    assert.deepEqual(readBody, agentManifest);
    const owner = await pool.query("SELECT owner_kind, owner_id FROM presale_allowlists WHERE id = $1", [agentManifest.allowlist_id]);
    assert.deepEqual(owner.rows, [{ owner_kind: "api_key", owner_id: apiKey.id }]);

    // Owners only: another caller gets not_found, each way round.
    accountManifest = await created(await allowlists.create(csvRequest(csvRows(2), { did }), testClient()));
    assert.deepEqual(await (await allowlists.read(readRequest(String(accountManifest.allowlist_id), { did }), testClient())).json(), accountManifest);
    await refused(await allowlists.read(readRequest(String(agentManifest.allowlist_id), { did }), testClient()), "not_found");
    await refused(await allowlists.read(readRequest(String(accountManifest.allowlist_id), { apiKey: apiKey.key }), testClient()), "not_found");
    await refused(await allowlists.read(readRequest(randomUUID(), { did }), testClient()), "not_found");
    await refused(await allowlists.read(readRequest("not-a-uuid", { did }), testClient()), "invalid_parameter");
    await refused(await allowlists.read(readRequest(String(accountManifest.allowlist_id), {}), testClient()), "unauthorized");

    // Unknown and malformed keys never fall back to Privy.
    await refused(await allowlists.create(csvRequest(csvRows(1), { apiKey: `blast_ak_${"A".repeat(43)}`, did }), testClient()), "unauthorized");
    await refused(await allowlists.create(csvRequest(csvRows(1), { apiKey: "not-a-key" }), testClient()), "unauthorized");
  } finally {
    Object.assign(console, originals);
  }

  const revoked = operatorCommand(["revoke", apiKey.id]);
  assert.equal(revoked.status, 0, revoked.stderr);
  const revokedKey = (JSON.parse(revoked.stdout) as { apiKey: { revokedAt: string | null; revokedBy: string | null } }).apiKey;
  assert.equal(revokedKey.revokedAt !== null, true);
  assert.equal(revokedKey.revokedBy, "operator:presale-ops", "revocation names its operator");
  const audit = await pool.query("SELECT issued_by, revoked_by, revoked_at IS NOT NULL AS revoked FROM presale_api_keys WHERE id = $1", [apiKey.id]);
  assert.deepEqual(audit.rows, [{ issued_by: "operator:presale-ops", revoked_by: "operator:presale-ops", revoked: true }]);
  await refused(await allowlists.create(csvRequest(csvRows(1), { apiKey: apiKey.key }), testClient()), "unauthorized");
  await refused(await allowlists.read(readRequest(String(agentManifest.allowlist_id), { apiKey: apiKey.key }), testClient()), "unauthorized");

  const listed = operatorCommand(["list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.includes(apiKey.key), false, "list never prints a key");
  assert.ok((JSON.parse(listed.stdout) as { apiKeys: { id: string }[] }).apiKeys.some((key) => key.id === apiKey.id));

  // The raw key is in no row of any table and in no log line: only its SHA-256 is stored.
  const stored = await pool.query<{ key_hash: Buffer }>("SELECT key_hash FROM presale_api_keys WHERE id = $1", [apiKey.id]);
  assert.deepEqual(stored.rows[0].key_hash, createHash("sha256").update(apiKey.key).digest());
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  for (const { table_name: table } of tables.rows) {
    const hit = await pool.query(`SELECT 1 FROM "${table}" AS row WHERE row::text LIKE $1 LIMIT 1`, [`%${apiKey.key}%`]);
    assert.equal(hit.rowCount, 0, `${table} holds the raw key`);
  }
  assert.ok(logged.length > 0, "the routes logged their metrics");
  assert.equal(logged.some((line) => line.includes(apiKey.key)), false, "no log line holds the raw key");
  assert.equal(revoked.stderr.includes(apiKey.key) || listed.stderr.includes(apiKey.key) || issued.stderr.includes(apiKey.key), false);
});

test("the operator command refuses a missing operator token and an unknown key id", { skip }, async () => {
  await database();
  const unknown = operatorCommand(["revoke", randomUUID()]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /OPERATOR_TARGET_NOT_FOUND/);
  const unauthenticated = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", new URL("../../../../scripts/presale-api-keys.ts", import.meta.url).pathname, "list"], {
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: databaseUrl },
  });
  assert.equal(unauthenticated.status, 1);
  assert.match(unauthenticated.stderr, /OPERATOR_AUTH_FAILED/);
});

test("creates count in presale_allowlist: 20 per hour per account or API key", { skip }, async () => {
  const pool = await database();
  const allowlists = routes(pool);
  const did = newDid();
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    await created(await allowlists.create(csvRequest(csvRows(1), { did }), testClient()));
  }
  const limited = await allowlists.create(csvRequest(csvRows(1), { did }), testClient());
  await refused(limited, "rate_limited");
  assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
  // Reads do not spend the create budget.
  const other = newDid();
  const own = await created(await allowlists.create(csvRequest(csvRows(1), { did: other }), testClient()));
  for (let attempt = 1; attempt <= 25; attempt += 1) {
    assert.equal((await allowlists.read(readRequest(String(own.allowlist_id), { did: other }), testClient())).status, 200);
  }
});

async function seedCompletedProfile(
  pool: Pool,
  input: {
    index: number;
    privyDid: string;
    address: string;
    walletKind: "embedded" | "slush";
  },
) {
  const suffix = String(input.index).padStart(12, "0");
  const profileId = `10000000-0000-4000-8000-${suffix}`;
  const membershipId = `20000000-0000-4000-8000-${suffix}`;
  const allocationId = `30000000-0000-4000-8000-${suffix}`;
  const cardId = `40000000-0000-4000-8000-${suffix}`;
  await pool.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address,
       provider_wallet_reference, callsign, disclosure_version,
       disclosure_accepted_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'season-zero-v1', $7, $7)`,
    [
      profileId,
      input.privyDid,
      `x-crew-access-${input.index}`,
      input.address,
      `wallet-crew-access-${input.index}`,
      `recovery_${input.index}`,
      new Date("2026-10-20T00:00:00Z"),
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_account_identities (
       profile_id, provider, provider_subject, verified_at
     ) VALUES ($1, 'x', $2, $4), ($1, 'privy', $3, $4)`,
    [profileId, `x-crew-access-${input.index}`, input.privyDid, new Date("2026-10-20T00:00:00Z")],
  );
  await pool.query(
    `INSERT INTO mission_control_account_wallets (
       wallet_id, profile_id, wallet_kind, sui_address,
       provider_wallet_reference, is_primary, verified_at
     ) VALUES ($1, $1, $2, $3, $4, TRUE, $5)`,
    [
      profileId,
      input.walletKind,
      input.address,
      `wallet-crew-access-${input.index}`,
      new Date("2026-10-20T00:00:00Z"),
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_season_memberships (
       membership_id, allocation_id, card_id, season_id, profile_id,
       crew_number, fleet, foundry_launch_method, owner_title,
       zero_fleet, gold, created_at
     ) VALUES ($1, $2, $3, 'season-zero', $4, $5, 'Recon', NULL,
       'Zero Fleet Commando', TRUE, TRUE, $6)`,
    [membershipId, allocationId, cardId, profileId, input.index, new Date("2026-10-20T00:00:00Z")],
  );
  await pool.query(
    `INSERT INTO mission_control_invitation_allocations (
       allocation_id, profile_id, membership_id, policy_version,
       code_count, created_at
     ) VALUES ($1, $2, $3, 'season-zero-v3', 0, $4)`,
    [allocationId, profileId, membershipId, new Date("2026-10-20T00:00:00Z")],
  );
  await pool.query(
    `INSERT INTO mission_control_cards (
       card_id, profile_id, membership_id, record_schema, record_version,
       card_record, render_status, created_at
     ) VALUES ($1, $2, $3, 'blast.season-zero-card', 3, '{}', 'pending', $4)`,
    [cardId, profileId, membershipId, new Date("2026-10-20T00:00:00Z")],
  );
  return profileId;
}

test("optional holders prefer Privy, fall back to Slush, preserve caps, and owner reads stay private", { skip }, async () => {
  const pool = await database();
  const first = await seedCompletedProfile(pool, { index: 31, privyDid: newDid(), address: wallet(70000), walletKind: "embedded" });
  await seedCompletedProfile(pool, { index: 32, privyDid: newDid(), address: wallet(70002), walletKind: "slush" });
  await pool.query(`INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, is_primary, verified_at) VALUES ($1, $2, 'slush', $3, 'slush:holder', FALSE, NOW())`, [randomUUID(), first, wallet(70001)]);
  assert.deepEqual(new Set(await cardHolderWallets(pool)), new Set([wallet(70000), wallet(70002)]));
  const did = newDid();
  const api = routes(pool);
  const csv = `wallet,cap\n${wallet(70000)},1\n${wallet(70003)},8\n`;
  const body = await created(await api.create(csvRequest(csv, { did }, USDC, true), testClient()));
  assert.equal(body.entry_count, 3);
  assert.equal(body.total_cap, "13");
  const request = (owner: string) => new Request(`${ORIGIN}/api/presale/allowlists/${body.allowlist_id}/entries`, { headers: headers({ did: owner }) });
  const response = await api.entries(request(did), testClient());
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.deepEqual(validator.validate("allowlist-entries-response", saved).errors, []);
  assert.deepEqual(saved.entries, [{ wallet: wallet(70000), cap: "1" }, { wallet: wallet(70003), cap: "8" }, { wallet: wallet(70002), cap: "4" }]);
  assert.deepEqual(saved.source, { file_name: "allowlist.csv", uploaded_count: 2, include_blast_holders: true, added_count: 1, holder_cap: "4" });
  await refused(await api.entries(request(newDid()), testClient()), "not_found");
  const without = await created(await api.create(csvRequest(csv, { did }), testClient()));
  assert.equal(without.entry_count, 2);
});
