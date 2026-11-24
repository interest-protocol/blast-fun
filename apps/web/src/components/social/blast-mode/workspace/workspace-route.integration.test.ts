import { testClient } from "../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test, { after, before } from "node:test";

import { readFile } from "node:fs/promises";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { liveWalletSession, walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { urlAs } from "../../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { emptyWorkspace } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { createSocialWorkspaceRoute } from "@blast/server/modules/social/workspace/route.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "workspace-fixture";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const POOL_SETTINGS = { connectionTimeoutMs: 3000, idleInTransactionMs: 3000, idleTimeoutMs: 1000, lockTimeoutMs: 1000, max: 4, statementTimeoutMs: 3000 };
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const did = (n: number) => `did:privy:workspace-${n}`;
const LINKED_WALLET = `0x${"07".repeat(32)}`;
const WALLET_SESSION = "w".repeat(43);
const RATE_NOW = new Date();
const admin = databaseUrl ? createPool(databaseUrl) : null;
const web = databaseUrl ? createRuntimePool(urlAs(databaseUrl, "blast_web"), POOL_SETTINGS) : null;
const kit = web ? createSocialRouteKit({
  tradingVisible: () => true,
  expectedOrigin: ORIGIN,
  verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
  limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: "workspace-fixture-pepper-0123456789", clock: () => RATE_NOW }),
  accounts: new PostgresSocialAccounts(() => web),
  walletSessions: { live: (token) => liveWalletSession(web, token, new Date()) },
  primary: () => web,
  metricSampleRate: 1,
}) : null;
const validator = createSocialValidator();
const route = kit && web ? createSocialWorkspaceRoute({ kit, database: () => autocommitReader(web, "social") }) : null;

function token(account: number, expired = false) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ aud: APP_ID, exp: now + (expired ? -1 : 3600), iat: now - 60, iss: "privy.io", sid: "workspace-session", sub: did(account) })}`;
  return `${payload}.${sign("sha256", Buffer.from(payload), { dsaEncoding: "ieee-p1363", key: keys.privateKey }).toString("base64url")}`;
}
function request(account: number, body?: unknown, query = "") {
  return new Request(`${ORIGIN}/api/social/me/blast-workspace${query}`, {
    method: body === undefined ? "GET" : "PUT",
    headers: { authorization: `Bearer ${token(account)}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
function write(writer_id = "device-a", sequence = 1, initialize_if_absent = false) {
  return { writer_id, sequence, initialize_if_absent, workspace: emptyWorkspace() };
}
async function success(response: Response) {
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  assert.deepEqual(validator.validate("workspace" in body ? "blast-workspace-response" : "blast-workspace-acknowledgement", body).errors, []);
  return body;
}

before(async () => {
  if (!admin) return;
  const existingSchema = (await admin.query("SELECT to_regclass('social_accounts') AS table_name")).rows[0].table_name;
  const existingData = existingSchema ? await preservedData() : null;
  await migrateDatabase(admin);
  if (existingData) assert.deepEqual(await preservedData(), existingData);
  // Reset only this disposable fixture's test state so focused retries reuse it.
  await admin.query("TRUNCATE social_blast_workspace_writers, social_blast_workspaces, mission_control_rate_limit_windows");
  for (let n = 1; n <= 13; n++) {
    await admin.query("INSERT INTO social_accounts (account_id, privy_did, callsign, sound, privacy, explorer) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING", [id(n), did(n), `workspace_${n}`, n === 13 ? true : null, n === 13 ? "private" : "public", n === 13 ? "suivision" : "suiscan"]);
  }
});
after(async () => { await web?.end(); await admin?.end(); });

test("T-012 AC-021/023: account restores saved empty distinctly from no saved workspace", { skip }, async () => {
  assert.ok(route);
  assert.deepEqual(await success(await route.GET(request(1), testClient())), { account_id: id(1), revision: "0", saved_at_ms: null, workspace: null });
  const ack = await success(await route.PUT(request(1, write("first", 1, true)), testClient()));
  assert.equal(ack.account_id, id(1));
  assert.equal(ack.revision, "1");
  assert.equal(ack.sequence, 1);
  assert.ok(ack.saved_at_ms > 0);
  assert.deepEqual(await success(await route.GET(request(1), testClient())), { account_id: id(1), revision: "1", saved_at_ms: ack.saved_at_ms, workspace: emptyWorkspace() });
  assert.deepEqual(await success(await route.GET(request(2), testClient())), { account_id: id(2), revision: "0", saved_at_ms: null, workspace: null });
});

async function refusal(response: Response, status: number, code: string) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  if (status === 429 || status === 503) assert.ok(Number(response.headers.get("retry-after")) > 0);
  return body;
}

test("T-012 AC-022/023: successful initialization replay survives another writer, with mismatch and high-water refusals", { skip }, async () => {
  assert.ok(route);
  const initial = write("lost-response", 10, true);
  const first = await success(await route.PUT(request(3, initial), testClient()));
  const newer = write("other-device", 1);
  newer.workspace = { ...emptyWorkspace(), data: { ...emptyWorkspace().data, collapsed: true } };
  const second = await success(await route.PUT(request(3, newer), testClient()));
  assert.equal(second.revision, "2");
  assert.deepEqual(await success(await route.PUT(request(3, initial), testClient())), first);
  assert.equal((await success(await route.GET(request(3), testClient()))).revision, "2");
  await refusal(await route.PUT(request(3, { ...initial, initialize_if_absent: false }), testClient()), 409, "workspace_write_mismatch");
  await refusal(await route.PUT(request(3, { ...initial, sequence: 9 }), testClient()), 409, "workspace_write_outdated");
  await refusal(await route.PUT(request(3, write("fresh-init", 1, true)), testClient()), 409, "workspace_exists");
  assert.deepEqual((await success(await route.GET(request(3), testClient()))).workspace, newer.workspace);
  const third = await success(await route.PUT(request(3, write("lost-response", 11)), testClient()));
  assert.equal(third.revision, "3");
  assert.deepEqual((await success(await route.GET(request(3), testClient()))).workspace, emptyWorkspace());
});

test("T-012 AC-022/023: concurrent initializers have one winner and parallel writes have unique ordered revisions", { skip }, async () => {
  assert.ok(route);
  const starts = await Promise.all([route.PUT(request(4, write("init-a", 1, true)), testClient()), route.PUT(request(4, write("init-b", 1, true)), testClient())]);
  assert.deepEqual(starts.map(response => response.status).sort(), [200, 409]);
  const winner = starts.find(response => response.status === 200)!;
  assert.equal((await success(winner)).revision, "1");
  await refusal(starts.find(response => response.status === 409)!, 409, "workspace_exists");
  const replacements = await Promise.all(Array.from({ length: 8 }, (_, n) => route.PUT(request(4, write(`writer-${n}`, 1)), testClient()).then(success)));
  assert.deepEqual(replacements.map(body => Number(body.revision)).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal((await success(await route.GET(request(4), testClient()))).revision, "9");
  const duplicate = write("simultaneous", 1);
  const replayed = await Promise.all([route.PUT(request(4, duplicate), testClient()).then(success), route.PUT(request(4, duplicate), testClient()).then(success)]);
  assert.deepEqual(replayed[0], replayed[1]);
  assert.equal(replayed[0].revision, "10");
  const racing = await Promise.all([route.PUT(request(4, write("simultaneous", 2)), testClient()), route.PUT(request(4, write("simultaneous", 3)), testClient())]);
  assert.equal(racing[1].status, 200);
  const highest = await success(racing[1]);
  if (racing[0].status === 200) await success(racing[0]);
  else await refusal(racing[0], 409, "workspace_write_outdated");
  assert.equal((await success(await route.GET(request(4), testClient()))).revision, highest.revision);
});

test("T-012 AC-021/024: auth, origin and selectors cannot change another account's setup", { skip }, async () => {
  assert.ok(route);
  const initial = await success(await route.GET(request(2), testClient()));
  await refusal(await route.GET(request(2, undefined, `?account_id=${id(1)}`), testClient()), 400, "invalid_request");
  await refusal(await route.PUT(request(2, { ...write(), account_id: id(1) }), testClient()), 400, "invalid_request");
  await refusal(await route.PUT(request(2, { ...write(), workspace: { ...emptyWorkspace(), account_id: id(1) } }), testClient()), 400, "invalid_request");
  await refusal(await route.GET(new Request(`${ORIGIN}/api/social/me/blast-workspace`), testClient()), 401, "unauthorized");
  await refusal(await route.PUT(new Request(`${ORIGIN}/api/social/me/blast-workspace`, { method: "PUT", headers: { authorization: `Bearer ${token(2, true)}`, "content-type": "application/json" }, body: JSON.stringify(write()) }), testClient()), 401, "unauthorized");
  await refusal(await route.GET(request(99), testClient()), 409, "account_required");
  const hostile = request(2, write());
  hostile.headers.set("origin", "https://attacker.invalid");
  await refusal(await route.PUT(hostile, testClient()), 403, "origin_invalid");
  assert.deepEqual(await success(await route.GET(request(2), testClient())), initial);
});

test("T-012 AC-024/025: malformed, future, UTF-8, nesting and streamed byte failures preserve snapshot and replay", { skip }, async () => {
  assert.ok(route);
  const accepted = write("safe", 1);
  const ack = await success(await route.PUT(request(5, accepted), testClient()));
  const initial = await success(await route.GET(request(5), testClient()));
  let deep: unknown = null;
  for (let n = 0; n < 18; n++) deep = { child: deep };
  for (const body of ["{", "[]", "null", { ...accepted, sequence: 0 }, { ...accepted, extra: deep }, { ...accepted, workspace: { ...emptyWorkspace(), panels: { missing: {} } } }]) {
    await refusal(await route.PUT(request(5, body), testClient()), 400, "invalid_request");
  }
  await refusal(await route.PUT(request(5, { ...accepted, workspace: { ...emptyWorkspace(), schema_version: 2 } }), testClient()), 409, "workspace_schema_unsupported");
  const invalidUtf8 = new Request(`${ORIGIN}/api/social/me/blast-workspace`, { method: "PUT", headers: { authorization: `Bearer ${token(5)}`, "content-type": "application/json" }, body: new Uint8Array([0xc3, 0x28]) });
  await refusal(await route.PUT(invalidUtf8, testClient()), 400, "invalid_request");
  const oversized = request(5, write());
  oversized.headers.set("content-length", String(1024 * 1024 + 1));
  await refusal(await route.PUT(oversized, testClient()), 413, "body_too_large");
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; } });
  const streamed = new Request(`${ORIGIN}/api/social/me/blast-workspace`, { method: "PUT", headers: { authorization: `Bearer ${token(5)}`, "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
  await refusal(await route.PUT(streamed, testClient()), 413, "body_too_large");
  assert.equal(cancelled, true);
  assert.deepEqual(await success(await route.GET(request(5), testClient())), initial);
  assert.deepEqual(await success(await route.PUT(request(5, accepted), testClient())), ack);
});

test("T-012 AC-024/025: more than 24 retained records and a full 1MiB UTF-8 envelope round-trip without trimming", { skip }, async () => {
  assert.ok(route);
  const { createWorkspaceStore } = await import("./model.ts");
  const store = createWorkspaceStore();
  for (let n = 1; n <= 30; n++) store.add({ panel_id: `panel-${n}`, chain: "sui", network: "mainnet", coin_type: `0x${n.toString(16)}::coin::COIN`, presale_id: null });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.retained_order.length, 26);
  const value = { ...write("large", 1), workspace: snapshot };
  await success(await route.PUT(request(6, value), testClient()));
  assert.deepEqual((await success(await route.GET(request(6), testClient()))).workspace, snapshot);
  const panelId = snapshot.visible_order[0]!;
  const panel = snapshot.panels[panelId]!;
  const raw = structuredClone(value);
  const base = Buffer.byteLength(JSON.stringify(raw));
  const remaining = 1024 * 1024 - base;
  const typed = "€".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  const filled = { ...raw, sequence: 2, workspace: { ...snapshot, panels: { ...snapshot.panels, [panelId]: { ...panel, coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed, mode: "typed" } } } } } } };
  const bytes = JSON.stringify(filled);
  assert.equal(Buffer.byteLength(bytes), 1024 * 1024);
  await success(await route.PUT(request(6, bytes), testClient()));
  const restored = await success(await route.GET(request(6), testClient()));
  assert.equal(restored.workspace.retained_order.length, 26);
  assert.equal(restored.workspace.panels[panelId].coin.trade.buy.typed, typed);
  await refusal(await route.PUT(request(6, bytes + " "), testClient()), 413, "body_too_large");
  assert.equal((await success(await route.GET(request(6), testClient()))).revision, "2");
});

test("T-012 AC-024: linked sign-ins share the account workspace 60/min budget independently of other accounts and Settings", { skip }, async () => {
  assert.ok(route && kit && admin);
  await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now()) ON CONFLICT DO NOTHING", [LINKED_WALLET, id(7)]);
  await admin.query(`INSERT INTO social_wallet_sessions (session_id, token_hash, wallet_address, challenge_id, created_at, expires_at, last_used_at)
    VALUES ($1, $2, $3, $4, now(), now() + interval '1 day', now()) ON CONFLICT DO NOTHING`, [id(70), walletSessionTokenHash(WALLET_SESSION), LINKED_WALLET, id(71)]);
  const linkedRequest = () => new Request(`${ORIGIN}/api/social/me/blast-workspace`, {
    method: "PUT",
    headers: { cookie: `__Host-blast_wallet=${WALLET_SESSION}`, origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(write("limited", 1)),
  });
  const accepted = write("limited", 1);
  const first = await success(await route.PUT(request(7, accepted), testClient()));
  // Prove the real session and primary wallet resolver reach the same workspace before exhausting it.
  assert.deepEqual(await success(await route.PUT(linkedRequest(), testClient())), first);
  await admin.query("DELETE FROM mission_control_rate_limit_windows WHERE policy_name = 'social_workspace_save'");
  for (let n = 0; n < 60; n++) assert.deepEqual(await success(await route.PUT(request(7, accepted), testClient())), first);
  await refusal(await route.PUT(linkedRequest(), testClient()), 429, "rate_limited");
  await refusal(await route.PUT(request(7, { ...accepted, sequence: 2 }), testClient()), 429, "rate_limited");
  assert.equal((await success(await route.GET(request(7), testClient()))).revision, "1");
  assert.equal((await success(await route.PUT(request(2, write("independent-budget", 1)), testClient()))).account_id, id(2));
  const { createSocialSettingsRoute } = await import("@blast/server/modules/social/accounts/settings-route.ts");
  const settings = createSocialSettingsRoute({ kit });
  const settingsRequest = () => new Request(`${ORIGIN}/api/social/me/settings`, { method: "PUT", headers: { authorization: `Bearer ${token(7)}`, "content-type": "application/json" }, body: JSON.stringify({ sound: true }) });
  for (let n = 0; n < 30; n++) {
    const response = await settings.PUT(settingsRequest(), testClient());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sound, true);
  }
  await refusal(await settings.PUT(settingsRequest(), testClient()), 429, "rate_limited");
});

test("T-012 AC-024: writer failure, deferred commit failure and deadline all roll back snapshot and replay", { skip }, async () => {
  assert.ok(route && admin && web);
  const accepted = write("atomic", 1);
  const ack = await success(await route.PUT(request(8, accepted), testClient()));
  const initial = await success(await route.GET(request(8), testClient()));
  const next = { ...write("atomic", 2), workspace: { ...emptyWorkspace(), data: { ...emptyWorkspace().data, collapsed: true } } };
  for (const deferred of [false, true]) {
    await admin.query(`CREATE FUNCTION workspace_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic writer failure' USING ERRCODE = '23514'; END $$`);
    await admin.query(deferred
      ? "CREATE CONSTRAINT TRIGGER workspace_fixture_failure AFTER INSERT OR UPDATE ON social_blast_workspace_writers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workspace_fixture_fail()"
      : "CREATE TRIGGER workspace_fixture_failure BEFORE INSERT OR UPDATE ON social_blast_workspace_writers FOR EACH ROW EXECUTE FUNCTION workspace_fixture_fail()");
    try { await refusal(await route.PUT(request(8, next), testClient()), 503, "service_unavailable"); }
    finally { await admin.query("DROP TRIGGER workspace_fixture_failure ON social_blast_workspace_writers"); await admin.query("DROP FUNCTION workspace_fixture_fail()"); }
    assert.deepEqual(await success(await route.GET(request(8), testClient())), initial);
    assert.deepEqual(await success(await route.PUT(request(8, accepted), testClient())), ack);
  }
  const blocker = await admin.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT account_id FROM social_accounts WHERE account_id = $1 FOR UPDATE", [id(8)]);
    await refusal(await route.PUT(request(8, next), testClient()), 503, "service_unavailable");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  assert.deepEqual(await success(await route.GET(request(8), testClient())), initial);
  assert.equal((await success(await route.PUT(request(8, next), testClient()))).revision, "2");
});

test("T-012 AC-032: future stored schema refuses downgrade inside serialized write without changing replay", { skip }, async () => {
  assert.ok(route && admin);
  const accepted = write("future", 1);
  const ack = await success(await route.PUT(request(9, accepted), testClient()));
  await admin.query("UPDATE social_blast_workspaces SET schema_version = 2, workspace = jsonb_set(workspace, '{schema_version}', '2'::jsonb) WHERE account_id = $1", [id(9)]);
  await refusal(await route.PUT(request(9, { ...accepted, sequence: 2 }), testClient()), 409, "workspace_schema_unsupported");
  await refusal(await route.GET(request(9), testClient()), 409, "workspace_schema_unsupported");
  assert.deepEqual(await success(await route.PUT(request(9, accepted), testClient())), ack);
  assert.equal((await admin.query("SELECT sequence::text FROM social_blast_workspace_writers WHERE account_id = $1", [id(9)])).rows[0].sequence, "1");
});

test("T-012 AC-022: queued writers follow server commit order regardless of other device sequence or clock labels", { skip }, async () => {
  assert.ok(route && admin);
  const blocker = await admin.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT account_id FROM social_accounts WHERE account_id = $1 FOR UPDATE", [id(10)]);
    const first = route.PUT(request(10, write("clock-2100", 9999)), testClient());
    await waitForBlockedWriters(1);
    const secondWrite = { ...write("clock-1970", 1), workspace: { ...emptyWorkspace(), data: { ...emptyWorkspace().data, collapsed: true } } };
    const second = route.PUT(request(10, secondWrite), testClient());
    await waitForBlockedWriters(2);
    await blocker.query("COMMIT");
    assert.equal((await success(await first)).revision, "1");
    const ack = await success(await second);
    assert.equal(ack.revision, "2");
    const restored = await success(await route.GET(request(10), testClient()));
    assert.equal(restored.saved_at_ms, ack.saved_at_ms);
    assert.deepEqual(restored.workspace, secondWrite.workspace);
    await refusal(await route.PUT(request(10, { ...write(), saved_at_ms: 9999999999999 }), testClient()), 400, "invalid_request");
  } finally { await blocker.query("ROLLBACK"); blocker.release(); }
});

async function waitForBlockedWriters(count: number) {
  assert.ok(admin);
  const until = Date.now() + 800;
  while (Date.now() < until) {
    const result = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT account_id FROM social_accounts%FOR UPDATE'");
    if (result.rows[0].n >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${count} blocked workspace writes`);
}

test("T-012 AC-021/032: private runtime grants, migration rollback and account cascade preserve unrelated data", { skip }, async () => {
  assert.ok(route && admin && databaseUrl);
  const initialAccount = (await admin.query("SELECT sound, privacy, explorer FROM social_accounts WHERE account_id = $1", [id(13)])).rows[0];
  assert.deepEqual(initialAccount, { sound: true, privacy: "private", explorer: "suivision" });
  assert.equal((await success(await route.GET(request(13), testClient()))).workspace, null);
  await admin.query("INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id(13), `0x${"a".repeat(64)}`]);
  await admin.query("INSERT INTO social_transactions (tx_id, account_id, kind, idempotency_key) VALUES ($1, $2, 'deposit', 'workspace-sentinel') ON CONFLICT DO NOTHING", [id(130), id(13)]);
  const before = await preservedData();
  for (const role of ["blast_indexer", "blast_social", "blast_replica", "blast_watcher"] as const) {
    const pool = createRuntimePool(urlAs(databaseUrl, role), POOL_SETTINGS);
    try {
      for (const table of ["social_blast_workspaces", "social_blast_workspace_writers"]) {
        await assert.rejects(pool.query(`SELECT * FROM ${table}`), { code: "42501" });
      }
    } finally { await pool.end(); }
  }
  const webPool = createRuntimePool(urlAs(databaseUrl, "blast_web"), POOL_SETTINGS);
  try { await assert.rejects(webPool.query("DELETE FROM social_blast_workspace_writers"), { code: "42501" }); }
  finally { await webPool.end(); }
  const accepted = write("rollback", 1);
  const ack = await success(await route.PUT(request(11, accepted), testClient()));
  const row = await success(await route.GET(request(11), testClient()));
  const migrationRoot = "../../../../../../../packages/core/src/modules/database/migrations/";
  await admin.query(await readFile(new URL(`${migrationRoot}0122_social_blast_workspace.down.sql`, import.meta.url), "utf8"));
  await refusal(await route.GET(request(11), testClient()), 503, "service_unavailable");
  await refusal(await route.PUT(request(11, { ...accepted, sequence: 2 }), testClient()), 503, "service_unavailable");
  await admin.query(await readFile(new URL(`${migrationRoot}0122_social_blast_workspace.up.sql`, import.meta.url), "utf8"));
  assert.deepEqual(await success(await route.GET(request(11), testClient())), row);
  assert.deepEqual(await success(await route.PUT(request(11, accepted), testClient())), ack);
  assert.deepEqual(await preservedData(), before);
  await success(await route.PUT(request(12, write("deleted-account", 1)), testClient()));
  await admin.query("DELETE FROM social_accounts WHERE account_id = $1", [id(12)]);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_blast_workspaces WHERE account_id = $1", [id(12)])).rows[0].n, 0);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_blast_workspace_writers WHERE account_id = $1", [id(12)])).rows[0].n, 0);
});

async function preservedData() {
  assert.ok(admin);
  return (await admin.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY account_id) FROM social_accounts a WHERE account_id = $1) AS account,
    (SELECT jsonb_agg(to_jsonb(w) ORDER BY presale_id) FROM social_watchlist w WHERE account_id = $1) AS watchlist,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY tx_id) FROM social_transactions t WHERE account_id = $1) AS transactions`, [id(13)])).rows[0];
}

test("T-012 REQ-024: route metrics carry bounded result/bytes labels without drafts, identities or credentials", { skip }, async () => {
  assert.ok(route);
  const { createWorkspaceStore } = await import("./model.ts");
  const store = createWorkspaceStore();
  store.add({ panel_id: "sensitive-panel", chain: "sui", network: "mainnet", coin_type: "0x2::sui::SUI", presale_id: null });
  const panel = store.getSnapshot().panels["sensitive-panel"]!;
  store.patchPanel("sensitive-panel", { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed: "PRIVATE_DRAFT_MARKER", mode: "typed" } } } });
  const logs: string[] = [];
  const original = console.info;
  console.info = (line: string) => { logs.push(line); };
  try { await success(await route.PUT(request(2, { ...write("PRIVATE_WRITER_MARKER", 1), workspace: store.getSnapshot() }), testClient())); }
  finally { console.info = original; }
  const all = logs.join("\n");
  for (const secret of ["PRIVATE_DRAFT_MARKER", "PRIVATE_WRITER_MARKER", "sensitive-panel", did(2), token(2), id(2), "0x2::sui::SUI"]) assert.equal(all.includes(secret), false);
  assert.ok(logs.some(line => JSON.parse(line).metric === "social.workspace.bytes"));
  assert.ok(logs.some(line => JSON.parse(line).metric === "social.route" && JSON.parse(line).status === 200));
});

test("T-012 AC-032: rollback drops only when both tables are empty and keeps unrelated rows intact", { skip }, async () => {
  assert.ok(admin);
  const before = await preservedData();
  const client = await admin.connect();
  const root = new URL("../../../../../../../packages/core/src/modules/database/migrations/", import.meta.url);
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE social_blast_workspace_writers, social_blast_workspaces");
    await client.query(await readFile(new URL("0122_social_blast_workspace.down.sql", root), "utf8"));
    assert.deepEqual((await client.query("SELECT to_regclass('social_blast_workspaces') AS snapshot, to_regclass('social_blast_workspace_writers') AS writers")).rows[0], { snapshot: null, writers: null });
    await client.query(await readFile(new URL("0122_social_blast_workspace.up.sql", root), "utf8"));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM social_blast_workspaces")).rows[0].n, 0);
    await client.query("ROLLBACK");
    assert.deepEqual(await preservedData(), before);
    for (const emptyTable of ["social_blast_workspace_writers", "social_blast_workspaces"]) {
      await client.query("BEGIN");
      await client.query(`TRUNCATE ${emptyTable}`);
      const counts = (await client.query("SELECT (SELECT count(*)::int FROM social_blast_workspaces) AS snapshots, (SELECT count(*)::int FROM social_blast_workspace_writers) AS writers")).rows[0];
      assert.ok(counts.snapshots > 0 || counts.writers > 0);
      await client.query(await readFile(new URL("0122_social_blast_workspace.down.sql", root), "utf8"));
      assert.deepEqual((await client.query("SELECT (SELECT count(*)::int FROM social_blast_workspaces) AS snapshots, (SELECT count(*)::int FROM social_blast_workspace_writers) AS writers")).rows[0], counts);
      assert.equal((await client.query("SELECT has_table_privilege('blast_web', 'social_blast_workspaces', 'SELECT') AS allowed")).rows[0].allowed, false);
      await client.query(await readFile(new URL("0122_social_blast_workspace.up.sql", root), "utf8"));
      assert.equal((await client.query("SELECT has_table_privilege('blast_web', 'social_blast_workspaces', 'SELECT') AS allowed")).rows[0].allowed, true);
      await client.query("ROLLBACK");
    }
    assert.deepEqual(await preservedData(), before);
  } finally { await client.query("ROLLBACK"); client.release(); }
});

test("T-012 AC-032: rollback waits for an in-flight save before deciding whether the installation is empty", { skip }, async () => {
  assert.ok(admin && route);
  const root = new URL("../../../../../../../packages/core/src/modules/database/migrations/", import.meta.url);
  const down = await readFile(new URL("0122_social_blast_workspace.down.sql", root), "utf8");
  const up = await readFile(new URL("0122_social_blast_workspace.up.sql", root), "utf8");
  await admin.query("TRUNCATE social_blast_workspace_writers, social_blast_workspaces");
  const writer = await admin.connect();
  const rollback = await admin.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("INSERT INTO social_blast_workspaces (account_id, schema_version, workspace, revision, saved_at_ms) VALUES ($1, 1, $2::jsonb, 1, 1800000000000)", [id(1), JSON.stringify(emptyWorkspace())]);
    const pid = (await rollback.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    pending = rollback.query(down);
    const until = Date.now() + 800;
    let waiting = false;
    while (Date.now() < until) {
      waiting = (await admin.query("SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.waiting === true;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "rollback must wait for the concurrent save");
    await writer.query("COMMIT");
    await pending;
    const retained = (await admin.query("SELECT to_regclass('social_blast_workspaces') IS NOT NULL AS present")).rows[0].present;
    await admin.query(up);
    assert.equal(retained, true, "a save committed during rollback must survive");
    assert.deepEqual(await success(await route.GET(request(1), testClient())), { account_id: id(1), revision: "1", saved_at_ms: 1800000000000, workspace: emptyWorkspace() });
  } finally {
    await writer.query("ROLLBACK");
    await pending;
    writer.release();
    rollback.release();
  }
});
