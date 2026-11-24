import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import {
  freshTestDatabase,
  type TestDatabase,
} from "../../../../core/test/fixtures/modules/database/template.ts";
import {
  processSingleton,
  takeProcessSingleton,
} from "@blast/core/lib/process-singleton.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { parseRuntimeConfig } from "../../config/runtime-config.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../test/fixtures/config/runtime-config.ts";
import { parseRelayConfig } from "../../private/relay-config.ts";
import { privateRequest } from "../../../../../apps/backend-api/src/transport/private.ts";
import { createAccountActivityService } from "./activity.ts";
import { accountActivityConfig } from "./config.ts";

const localDatabase = new URL(
  process.env.MISSION_CONTROL_TEST_DATABASE_URL ?? "https://missing.invalid",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(localDatabase.hostname),
  "Disposable loopback PostgreSQL is required",
);

const origin = "https://blast.fun";
const appId = "analytics-local-fixture";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const accountId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const profileId = "33333333-3333-4333-8333-333333333333";
const did = "did:privy:analytics-fixture";
const wallet = "0x" + "1".repeat(64);
const sessionToken = "t".repeat(43);
// SHA256 of the fixed token, independently generated once with Python hashlib.
const tokenHash =
  "80383f974f22964fd6b7ae851b6ccc9180ed4e6fcb2e415bafcab6d822139238";
let database: TestDatabase;
let admin: Pool;
let warehouse: Pool;
let identity: Pool;
let ingress: Pool;
let outsider: Pool;
let warehouseOutsider: Pool;
let service: ReturnType<typeof createAccountActivityService>;
let env: Record<string, string>;
let warehouseName: string;

before(async () => {
  database = await freshTestDatabase();
  admin = new Pool({ connectionString: database.url, max: 2 });
  assert.deepEqual(await migrateDatabase(admin), []);
  assert.deepEqual(await migrateDatabase(admin), []);
  warehouseName = `analytics_activity_${process.pid}`;
  await admin.query(`CREATE DATABASE ${warehouseName}`);
  const warehouseUrl = new URL(database.url);
  warehouseUrl.pathname = `/${warehouseName}`;
  warehouse = new Pool({ connectionString: warehouseUrl.toString(), max: 2 });
  await warehouse.query(
    await readFile(
      new URL(
        "../../../../../apps/workers/src/modules/analytics/warehouse.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await warehouse.query(`INSERT INTO blast_analytics.facts(fact_id,checkpoint,timestamp_ms,kind,usd_value) VALUES('retained-fact',1,1,'trade',2);
    INSERT INTO blast_analytics.snapshots VALUES(TRUE,'2026-01-01T00:00:00Z','{"version":2,"accountActivity":null}');
    INSERT INTO blast_analytics.access_codes VALUES(repeat('a',64),'2030-01-01T00:00:00Z',NULL)`);
  await warehouse.query(
    await readFile(
      new URL(
        "../../../../../apps/workers/src/modules/analytics/migrations/0001_account_activity.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await admin.query(
    "CREATE ROLE activity_identity LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_identity TO activity_identity; CREATE ROLE activity_outsider LOGIN PASSWORD 'disposable-test'",
  );
  await warehouse.query(
    "CREATE ROLE activity_ingress LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_ingress TO activity_ingress",
  );
  const identityUrl = new URL(database.url);
  identityUrl.username = "activity_identity";
  identityUrl.password = "disposable-test";
  const ingressUrl = new URL(warehouseUrl);
  ingressUrl.username = "activity_ingress";
  ingressUrl.password = "disposable-test";
  const outsiderUrl = new URL(database.url);
  outsiderUrl.username = "activity_outsider";
  outsiderUrl.password = "disposable-test";
  identity = new Pool({ connectionString: identityUrl.toString(), max: 1 });
  ingress = new Pool({ connectionString: ingressUrl.toString(), max: 1 });
  outsider = new Pool({ connectionString: outsiderUrl.toString(), max: 1 });
  outsiderUrl.pathname = `/${warehouseName}`;
  warehouseOutsider = new Pool({
    connectionString: outsiderUrl.toString(),
    max: 1,
  });
  // Bare schema access keeps this assertion about EXECUTE, not schema visibility.
  await warehouse.query(
    "GRANT USAGE ON SCHEMA blast_analytics TO activity_outsider",
  );
  env = {
    ANALYTICS_ACCOUNT_ACTIVITY_ENABLED: "true",
    ANALYTICS_ACCOUNT_HASH_KEY: "analytics-fixture-key-never-production-32",
    ANALYTICS_ACCOUNT_SITE_ORIGIN: origin,
    ANALYTICS_IDENTITY_DATABASE_URL: identityUrl.toString(),
    ANALYTICS_INGRESS_DATABASE_URL: ingressUrl.toString(),
    PRIVY_APP_ID: appId,
    PRIVY_JWT_VERIFICATION_KEY: verificationKey,
  };
});

beforeEach(async () => {
  await service?.close();
  await admin.query(
    "TRUNCATE social_accounts CASCADE; TRUNCATE mission_control_profiles CASCADE; TRUNCATE presale_embedded_wallets,social_wallet_sessions",
  );
  await warehouse.query(
    "TRUNCATE blast_analytics.accounts CASCADE; UPDATE blast_analytics.account_collection SET scope=NULL,started_at=NULL",
  );
  service = createAccountActivityService(accountActivityConfig(env));
});

after(async () => {
  await service?.close();
  await Promise.all([
    identity?.end(),
    ingress?.end(),
    outsider?.end(),
    warehouseOutsider?.end(),
    warehouse?.end(),
    admin?.end(),
  ]);
  if (!database) return;

  const maintenanceUrl = new URL(database.url);
  const databaseName = maintenanceUrl.pathname.slice(1);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
  try {
    if (warehouseName) await dropClosedDatabase(maintenance, warehouseName);
    await dropClosedDatabase(maintenance, databaseName);
  } finally {
    await maintenance.end();
  }
});

async function dropClosedDatabase(pool: Pool, name: string): Promise<void> {
  // A pool can finish ending before PostgreSQL finishes closing its sessions.
  await waitUntil(async () => {
    const { rows } = await pool.query<{ disconnected: boolean }>(
      "SELECT NOT EXISTS (SELECT FROM pg_stat_activity WHERE datname = $1) AS disconnected",
      [name],
    );
    return rows[0].disconnected;
  });
  await pool.query(`DROP DATABASE IF EXISTS ${name}`);
}

test("resolves only existing accounts with member precedence and no creation", async () => {
  await newAccount();
  assert.equal(await resolve(did, null), accountId);
  assert.equal(await resolve("did:privy:missing", null), null);
  await memberProfile();
  await admin.query(
    "INSERT INTO mission_control_account_identities(profile_id,provider,provider_subject,verified_at) VALUES($1,'privy',$2,now())",
    [profileId, did],
  );
  assert.equal(await resolve(did, null), null);
  await admin.query(
    "INSERT INTO social_accounts(account_id,profile_id) VALUES($1,$2)",
    [otherId, profileId],
  );
  assert.equal(await resolve(did, null), otherId);
  assert.equal(
    (await admin.query("SELECT count(*)::text AS n FROM social_accounts"))
      .rows[0].n,
    "2",
  );
  assert.equal(await resolve(did, tokenHash), null);
  assert.equal(await resolve(null, null), null);
  assert.equal(await resolve("not-a-verified-subject", null), null);
});

test("keeps resolver ownership and raw identity tables outside the login capability", async () => {
  await newAccount();
  await assert.rejects(
    identity.query("SELECT account_id FROM public.social_accounts"),
    {
      code: "42501",
    },
  );
  await assert.rejects(
    identity.query(
      "UPDATE public.social_wallet_sessions SET last_used_at=now()",
    ),
    { code: "42501" },
  );
  await assert.rejects(
    outsider.query("SELECT public.analytics_account_id($1,NULL)", [did]),
    {
      code: "42501",
    },
  );
  assert.deepEqual(
    (
      await admin.query(`SELECT p.prosecdef,p.provolatile,r.rolname,p.proconfig FROM pg_proc p
    JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.analytics_account_id(text,text)'::regprocedure`)
    ).rows[0],
    {
      prosecdef: true,
      provolatile: "s",
      rolname: "blast_analytics_identity_owner",
      proconfig: ["search_path=pg_catalog, pg_temp"],
    },
  );
  assert.equal(
    (
      await admin.query(`SELECT count(*)::text AS n FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='public.analytics_account_id(text,text)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE'`)
    ).rows[0].n,
    "0",
  );
  await identity.query(
    "CREATE TEMP TABLE social_accounts(account_id uuid,privy_did text)",
  );
  assert.equal(await resolve(did, null), accountId);
});

test("records one domain-separated account hash across login methods and devices", async () => {
  await newAccount();
  await session();
  assert.equal(
    (await service.handle(request({ authorization: `Bearer ${jwt(did)}` })))
      .status,
    204,
  );
  const device = createAccountActivityService(accountActivityConfig(env));
  try {
    assert.equal(
      (
        await device.handle(
          request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
        )
      ).status,
      204,
    );
  } finally {
    await device.close();
  }
  assert.deepEqual(
    (await warehouse.query("SELECT account_hash FROM blast_analytics.accounts"))
      .rows,
    [
      {
        account_hash:
          "3f2d2d24ab9e020b7d31801d72fdf3f472079f978b4d3824f53423a1f21fb45b",
      },
    ],
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT count(*)::text AS n FROM blast_analytics.account_days",
      )
    ).rows[0].n,
    "1",
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT scope IS NOT NULL AND started_at IS NOT NULL AS started FROM blast_analytics.account_collection",
      )
    ).rows[0].started,
    true,
  );
  const stored = (
    await warehouse.query(`SELECT jsonb_build_object(
    'accounts',(SELECT jsonb_agg(a) FROM blast_analytics.accounts a),
    'days',(SELECT jsonb_agg(d) FROM blast_analytics.account_days d),
    'collection',(SELECT jsonb_agg(c) FROM blast_analytics.account_collection c)) AS stored`)
  ).rows[0].stored;
  assert.doesNotMatch(
    JSON.stringify(stored),
    /did:privy:|11111111-1111-4111|0x111111|tttttttt|@/,
  );
});

test("refuses conflicting wallet owners including unresolved member profiles", async () => {
  await newAccount();
  await session();
  await admin.query(
    "INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES($1,$2,now())",
    [wallet, accountId],
  );
  assert.equal(await resolve(null, tokenHash), accountId);
  await memberProfile();
  await admin.query(
    `INSERT INTO mission_control_account_wallets(wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,verified_at)
    VALUES($1,$2,'slush',$3,'fixture-linked',now())`,
    [randomUUID(), profileId, wallet],
  );
  assert.equal(await resolve(null, tokenHash), null);
  await admin.query(
    "INSERT INTO social_accounts(account_id,profile_id) VALUES($1,$2)",
    [otherId, profileId],
  );
  assert.equal(await resolve(null, tokenHash), null);
  await admin.query(
    "DELETE FROM mission_control_account_wallets; DELETE FROM social_account_wallets",
  );
  await admin.query(
    "UPDATE social_accounts SET sui_address=NULL WHERE account_id=$1",
    [accountId],
  );
  await admin.query(
    `INSERT INTO mission_control_account_wallets(wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,verified_at)
    VALUES($1,$2,'slush',$3,'fixture-linked',now())`,
    [randomUUID(), profileId, wallet],
  );
  assert.equal(await resolve(null, tokenHash), otherId);
});

test("uses the canonical direct-before-member embedded wallet owner", async () => {
  await newAccount();
  await session();
  await memberProfile();
  await admin.query(
    "INSERT INTO social_accounts(account_id,profile_id) VALUES($1,$2)",
    [otherId, profileId],
  );
  await admin.query(
    "INSERT INTO mission_control_account_identities(profile_id,provider,provider_subject,verified_at) VALUES($1,'privy',$2,now())",
    [profileId, did],
  );
  await admin.query(
    "INSERT INTO presale_embedded_wallets(privy_did,address) VALUES($1,$2)",
    [did, wallet],
  );
  assert.equal(await resolve(null, tokenHash), accountId);
  assert.equal(await resolve(did, null), otherId);
  await admin.query("DELETE FROM social_accounts WHERE account_id=$1", [
    accountId,
  ]);
  assert.equal(await resolve(null, tokenHash), otherId);
});

test("checks session expiry revocation and idle time without touching last use", async () => {
  await newAccount();
  await session();
  const previous = (
    await admin.query("SELECT last_used_at FROM social_wallet_sessions")
  ).rows[0];
  assert.equal(await resolve(null, tokenHash), accountId);
  assert.equal(await resolve(null, tokenHash), accountId);
  assert.deepEqual(
    (await admin.query("SELECT last_used_at FROM social_wallet_sessions"))
      .rows[0],
    previous,
  );
  await admin.query("UPDATE social_wallet_sessions SET revoked_at=now()");
  assert.equal(await resolve(null, tokenHash), null);
  await admin.query(
    "UPDATE social_wallet_sessions SET revoked_at=NULL,expires_at=now()",
  );
  assert.equal(await resolve(null, tokenHash), null);
  await admin.query(
    "UPDATE social_wallet_sessions SET created_at=now()-INTERVAL '8 days',expires_at=now()+INTERVAL '1 day',last_used_at=now()-INTERVAL '7 days'",
  );
  assert.equal(await resolve(null, tokenHash), null);
  assert.equal(await resolve(null, "invalid-hash"), null);
});

test("stops after unlink or deletion and treats a recreated account UUID as new", async () => {
  await newAccount();
  await session();
  assert.equal(
    (
      await service.handle(
        request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
      )
    ).status,
    204,
  );
  await admin.query(
    "UPDATE social_accounts SET sui_address=NULL WHERE account_id=$1",
    [accountId],
  );
  assert.equal(
    (
      await service.handle(
        request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
      )
    ).status,
    401,
  );
  await admin.query(
    "INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES($1,$2,now())",
    [wallet, accountId],
  );
  assert.equal(
    (
      await service.handle(
        request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT count(*)::text AS n FROM blast_analytics.accounts",
      )
    ).rows[0].n,
    "1",
  );
  await admin.query("DELETE FROM social_account_wallets");
  await admin.query("DELETE FROM social_accounts WHERE account_id=$1", [
    accountId,
  ]);
  assert.equal(
    (await service.handle(request({ authorization: `Bearer ${jwt(did)}` })))
      .status,
    401,
  );
  await admin.query(
    "INSERT INTO social_accounts(account_id,privy_did,callsign,sui_address) VALUES($1,$2,'analytics_recreated',$3)",
    [otherId, did, wallet],
  );
  assert.equal(
    (await service.handle(request({ authorization: `Bearer ${jwt(did)}` })))
      .status,
    204,
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT count(*)::text AS n FROM blast_analytics.accounts",
      )
    ).rows[0].n,
    "2",
  );
});

test("rejects invalid bearer proofs without falling back to a valid cookie", async () => {
  await newAccount();
  await session();
  const cookie = `__Host-blast_wallet=${sessionToken}`;
  assert.equal(
    (await service.handle(request({ cookie, authorization: "not-a-bearer" })))
      .status,
    401,
  );
  assert.equal(
    (
      await service.handle(
        request({
          cookie,
          authorization: `Bearer ${jwt(did, { iss: "forged.example" })}`,
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await service.handle(
        request({
          cookie,
          authorization: `Bearer ${jwt(did, { aud: "another-app" })}`,
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await service.handle(
        request({ cookie, authorization: `Bearer ${jwt(did, {}, "HS256")}` }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await service.handle(
        request({ cookie, authorization: `Bearer ${jwt(did, { exp: 1 })}` }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await service.handle(request({ cookie: `${cookie}; ${cookie}` }))).status,
    401,
  );
  assert.equal(
    (await service.handle(request({ cookie: "__Host-blast_wallet=malformed" })))
      .status,
    401,
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT count(*)::text AS n FROM blast_analytics.accounts",
      )
    ).rows[0].n,
    "0",
  );
});

test("refuses forged origin query and body inputs independently of user proof", async () => {
  await newAccount();
  const authorization = `Bearer ${jwt(did)}`;
  assert.equal(
    (
      await service.handle(
        request({ authorization, origin: "https://other.example" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await service.handle(
        request({ authorization, "sec-fetch-site": "cross-site" }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await service.handle(
        request({ authorization }, "/api/analytics/activity?account_id=forged"),
      )
    ).status,
    400,
  );
  assert.equal(
    (await service.handle(request({ authorization }, undefined, { body: "" })))
      .status,
    400,
  );
  assert.equal(
    (
      await service.handle(
        request({ authorization }, undefined, { body: '{"timestamp":1}' }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await service.handle(
        request({ authorization }, undefined, { method: "GET" }),
      )
    ).status,
    405,
  );
  assert.equal(
    (
      await service.handle(
        request({ "x-blast-private-signature": "transport-only" }),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT count(*)::text AS n FROM blast_analytics.accounts",
      )
    ).rows[0].n,
    "0",
  );
});

test("upgrades only the warehouse and preserves existing facts snapshots and codes", async () => {
  const upgrade = await readFile(
    new URL(
      "../../../../../apps/workers/src/modules/analytics/migrations/0001_account_activity.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const productConnection = await admin.connect();
  try {
    await assert.rejects(productConnection.query(upgrade), {
      message: "account activity requires the isolated analytics warehouse v1",
    });
  } finally {
    await productConnection.query("ROLLBACK");
    productConnection.release();
  }
  const warehouseConnection = await warehouse.connect();
  try {
    await assert.rejects(warehouseConnection.query(upgrade), {
      message: "unexpected analytics warehouse migration version",
    });
  } finally {
    await warehouseConnection.query("ROLLBACK");
    warehouseConnection.release();
  }
  assert.deepEqual(
    (
      await warehouse.query(
        "SELECT version,name FROM blast_analytics.schema_migrations ORDER BY version",
      )
    ).rows,
    [
      { version: 0, name: "warehouse-v1" },
      { version: 1, name: "account-activity-v1" },
    ],
  );
  assert.deepEqual(
    (
      await warehouse.query(
        "SELECT fact_id,usd_value::text FROM blast_analytics.facts",
      )
    ).rows,
    [{ fact_id: "retained-fact", usd_value: "2" }],
  );
  assert.deepEqual(
    (await warehouse.query("SELECT payload FROM blast_analytics.snapshots"))
      .rows,
    [{ payload: { version: 2, accountActivity: null } }],
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT count(*)::text AS n FROM blast_analytics.access_codes WHERE used_at IS NULL",
      )
    ).rows[0].n,
    "1",
  );
  assert.deepEqual(
    (
      await warehouse.query(
        "SELECT scope,started_at FROM blast_analytics.account_collection",
      )
    ).rows,
    [{ scope: null, started_at: null }],
  );
});

test("limits ingress to recording hashes under one scope with database UTC time", async () => {
  await assert.rejects(
    warehouseOutsider.query(
      "SELECT blast_analytics.record_activity(repeat('a',64),repeat('b',64))",
    ),
    { code: "42501" },
  );
  assert.deepEqual(
    (
      await warehouse.query(`SELECT p.prosecdef,r.rolname,r.rolcanlogin,p.proconfig FROM pg_proc p
      JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='blast_analytics.record_activity(text,text)'::regprocedure`)
    ).rows,
    [
      {
        prosecdef: true,
        rolname: "blast_analytics_activity_owner",
        rolcanlogin: false,
        proconfig: ["search_path=pg_catalog, pg_temp"],
      },
    ],
  );
  assert.equal(
    (
      await warehouse.query(`SELECT count(*)::text AS n FROM pg_proc p,
      LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid='blast_analytics.record_activity(text,text)'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE'`)
    ).rows[0].n,
    "0",
  );
  await assert.rejects(
    ingress.query("SELECT account_hash FROM blast_analytics.accounts"),
    {
      code: "42501",
    },
  );
  await assert.rejects(
    ingress.query("SELECT * FROM blast_analytics.snapshots"),
    { code: "42501" },
  );
  await assert.rejects(
    ingress.query("SELECT blast_analytics.redeem_access_code(repeat('a',64))"),
    {
      code: "42501",
    },
  );
  await assert.rejects(ingress.query("DELETE FROM blast_analytics.facts"), {
    code: "42501",
  });
  await assert.rejects(
    ingress.query(
      "SELECT blast_analytics.record_activity('raw-account',repeat('b',64))",
    ),
    { code: "22023" },
  );
  await ingress.query("SET TIMEZONE='Pacific/Kiritimati'");
  const observed = (
    await ingress.query(
      "SELECT blast_analytics.record_activity(repeat('a',64),repeat('b',64)) AS observed",
    )
  ).rows[0].observed as Date;
  assert.deepEqual(
    (
      await warehouse.query(
        "SELECT day::text FROM blast_analytics.account_days",
      )
    ).rows,
    [{ day: observed.toISOString().slice(0, 10) }],
  );
  await warehouse.query(
    "INSERT INTO blast_analytics.account_days VALUES(repeat('a',64),(now() AT TIME ZONE 'UTC')::date-1)",
  );
  await warehouse.query(
    "UPDATE blast_analytics.accounts SET last_seen=last_seen+INTERVAL '1 hour'",
  );
  const previous = (
    await warehouse.query("SELECT last_seen FROM blast_analytics.accounts")
  ).rows[0].last_seen;
  await ingress.query(
    "SELECT blast_analytics.record_activity(repeat('a',64),repeat('b',64))",
  );
  assert.equal(
    (
      await warehouse.query(
        "SELECT count(*)::text AS n FROM blast_analytics.account_days",
      )
    ).rows[0].n,
    "2",
  );
  assert.deepEqual(
    (await warehouse.query("SELECT last_seen FROM blast_analytics.accounts"))
      .rows[0].last_seen,
    previous,
  );
  await assert.rejects(
    ingress.query(
      "SELECT blast_analytics.record_activity(repeat('a',64),repeat('c',64))",
    ),
    { message: "account activity scope changed; reconciliation required" },
  );
});

test("suppresses only successful writes for fifteen minutes and retries failures", async (context) => {
  await newAccount();
  let monotonic = 1000;
  context.mock.method(performance, "now", () => monotonic);
  const authorization = `Bearer ${jwt(did)}`;
  await warehouse.query(
    "REVOKE EXECUTE ON FUNCTION blast_analytics.record_activity(TEXT,TEXT) FROM blast_analytics_ingress",
  );
  try {
    const refused = await service.handle(request({ authorization }));
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.equal(await refused.text(), "");
  } finally {
    await warehouse.query(
      "GRANT EXECUTE ON FUNCTION blast_analytics.record_activity(TEXT,TEXT) TO blast_analytics_ingress",
    );
  }
  assert.equal((await service.handle(request({ authorization }))).status, 204);
  const accounts = (
    await warehouse.query("SELECT last_seen FROM blast_analytics.accounts")
  ).rows;
  assert.equal(accounts.length, 1);
  const before = accounts[0].last_seen;
  assert.equal((await service.handle(request({ authorization }))).status, 204);
  assert.deepEqual(
    (await warehouse.query("SELECT last_seen FROM blast_analytics.accounts"))
      .rows[0].last_seen,
    before,
  );
  monotonic = 901001;
  assert.equal((await service.handle(request({ authorization }))).status, 204);
  assert.ok(
    (await warehouse.query("SELECT last_seen FROM blast_analytics.accounts"))
      .rows[0].last_seen > before,
  );
  const changed = createAccountActivityService(
    accountActivityConfig({
      ...env,
      ANALYTICS_ACCOUNT_HASH_KEY: "changed-fixture-key-never-production-32",
    }),
  );
  try {
    assert.equal(
      (await changed.handle(request({ authorization }))).status,
      503,
    );
  } finally {
    await changed.close();
  }
});

test("admits two in flight without a queue and recovers from bounded database waits", async () => {
  await newAccount();
  await session();
  const owner = await admin.connect();
  let first: Promise<Response> | undefined;
  let second: Promise<Response> | undefined;
  let third: Promise<Response> | undefined;
  try {
    await owner.query(
      "BEGIN; LOCK public.social_accounts IN ACCESS EXCLUSIVE MODE",
    );
    first = service.handle(
      request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
    );
    await waitUntil(
      async () =>
        (
          await admin.query(
            "SELECT EXISTS(SELECT FROM pg_stat_activity WHERE application_name='blast-analytics-identity' AND wait_event_type='Lock') AS waiting",
          )
        ).rows[0].waiting,
    );
    second = service.handle(
      request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
    );
    third = service.handle(
      request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
    );
    assert.equal(
      await Promise.race([
        first.then(() => "blocked"),
        third.then(() => "excess"),
      ]),
      "excess",
    );
    assert.equal((await third).status, 503);
    assert.equal((await first).status, 503);
    assert.equal((await second).status, 503);
  } finally {
    await owner.query("ROLLBACK");
    owner.release();
    await Promise.all([first, second, third]);
  }
  assert.equal(
    (
      await service.handle(
        request({ cookie: `__Host-blast_wallet=${sessionToken}` }),
      )
    ).status,
    204,
  );
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    (await service.handle(request({}, undefined, { signal: aborted.signal })))
      .status,
    503,
  );
});

test("logs only a fixed metric when an idle database connection fails", async (context) => {
  await newAccount();
  const output: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) =>
    output.push(values),
  );
  const authorization = `Bearer ${jwt(did)}`;
  assert.equal((await service.handle(request({ authorization }))).status, 204);
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='blast-analytics-identity' AND state='idle'",
  );
  await waitUntil(async () => output.length > 0);
  assert.deepEqual(output, [
    [
      JSON.stringify({
        metric: "analytics.account_activity_connection_failed",
      }),
    ],
  ]);
  assert.equal((await service.handle(request({ authorization }))).status, 204);
});

async function waitUntil(condition: () => Promise<boolean>) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail("Owned database wait did not become ready");
}

async function newAccount() {
  await admin.query(
    "INSERT INTO social_accounts(account_id,privy_did,callsign,sui_address) VALUES($1,$2,'analytics_fixture',$3)",
    [accountId, did, wallet],
  );
}

async function memberProfile() {
  await admin.query(
    `INSERT INTO mission_control_profiles(profile_id,privy_did,x_subject,sui_address,provider_wallet_reference,callsign,disclosure_version,disclosure_accepted_at)
    VALUES($1,'did:privy:profile','fixture-x','0x'||repeat('3',64),'fixture-wallet','analytics_member','fixture-v1',now())`,
    [profileId],
  );
}

async function session() {
  await admin.query(
    `INSERT INTO social_wallet_sessions(session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at)
    VALUES($1,$2,$3,$4,now()-INTERVAL '1 day',now()+INTERVAL '1 day',now()-INTERVAL '1 hour')`,
    [randomUUID(), tokenHash, wallet, randomUUID()],
  );
}

async function resolve(subject: string | null, hash: string | null) {
  return (
    await identity.query(
      "SELECT public.analytics_account_id($1,$2)::text AS account_id",
      [subject, hash],
    )
  ).rows[0].account_id;
}

function request(
  headers: Record<string, string> = {},
  path = "/api/analytics/activity",
  init: RequestInit = {},
) {
  return new Request(origin + path, {
    method: "POST",
    ...init,
    headers: { origin, "sec-fetch-site": "same-origin", ...headers },
  });
}

function jwt(
  subject: string,
  claims: Record<string, unknown> = {},
  algorithm = "ES256",
) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: algorithm, typ: "JWT" });
  const body = encode({
    aud: appId,
    iss: "privy.io",
    iat: now - 60,
    exp: now + 3600,
    sid: "fixture-session",
    sub: subject,
    ...claims,
  });
  return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

test("records through the generated relay and signed gateway without trusting transport as user auth", async (context) => {
  await newAccount();
  await session();
  const secret = "synthetic-analytics-transport-secret-32";
  const relayConfig = parseRelayConfig({
    BLAST_BACKEND_API_ORIGIN: "https://backend.test",
    BLAST_BACKEND_GATEWAY_SECRET: secret,
    NEXT_PUBLIC_SITE_URL: origin,
    BLAST_REDIS_NAMESPACE: "analytics-local-test",
    BLAST_DEPLOYMENT_TARGET: "preview",
    BLAST_DEPLOYMENT_BRANCH: "analytics-local-test",
    VERCEL: "1",
  });
  assert.ok(relayConfig.quotaNamespace);
  const { POST: relay } = await import(
    "../../../../../apps/web/src/app/api/analytics/activity/route.ts"
  );
  processSingleton("relayConfig", () => relayConfig);
  const { privateApi } = await import("../../private/api.ts");
  processSingleton("runtimeConfig", () =>
    parseRuntimeConfig({
      ...RUNTIME_TEST_ENVIRONMENT,
      ...env,
      NEXT_PUBLIC_SITE_URL: origin,
    }),
  );
  let transported: Request | undefined;
  const seen = new Set<string>();
  context.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(input, init);
      assert.equal(new URL(incoming.url).origin, "https://backend.test");
      transported = incoming.clone();
      const contract = privateRoute(
        incoming.method,
        new URL(incoming.url).pathname,
        "browser",
      );
      assert.ok(contract);
      assert.equal(contract.id, "analytics.account.activity");
      assert.equal(contract.maxBodyBytes, 0);
      return privateRequest(
        incoming,
        contract,
        {
          namespace: relayConfig.quotaNamespace!,
          gatewaySecret: secret,
          privateApi: { siteOrigin: origin, handle: privateApi },
          redis: {
            async execute(args) {
              assert.deepEqual(
                [args[0], ...args.slice(3)],
                ["SET", "NX", "EX", "30"],
              );
              if (seen.has(args[1]!)) return null;
              seen.add(args[1]!);
              return "OK";
            },
          },
        },
        incoming.signal,
      );
    },
  );
  try {
    const { createAccountActivity } = await import(
      "../../../../../apps/web/src/components/analytics/account-activity.ts"
    );
    let emitted:
      | { path: string; init: RequestInit; response: Response }
      | undefined;
    const activity = createAccountActivity({
      fetch: async (input, init) => {
        const headers = Object.fromEntries(new Headers(init?.headers));
        const response = await relay(
          request(
            {
              ...headers,
              cookie: `__Host-blast_wallet=${sessionToken}`,
              "x-vercel-forwarded-for": "192.0.2.1",
            },
            String(input),
            init,
          ),
        );
        emitted = { path: String(input), init: init!, response };
        return response;
      },
    });
    // The wrong local UUID cannot choose the canonical account written by the server.
    const stopActivity = activity.subscribe(
      { accountId: otherId, identity: "wallet", mode: "wallet" },
      Object.assign(new EventTarget(), { visibilityState: "visible" as const }),
    );
    try {
      await waitUntil(async () => emitted !== undefined);
      assert.ok(emitted);
      assert.equal(emitted.path, "/api/analytics/activity");
      assert.equal(emitted.init.method, "POST");
      assert.equal(emitted.init.body, undefined);
      assert.equal(emitted.response.status, 204);
      assert.equal(
        (
          await warehouse.query(
            "SELECT account_hash FROM blast_analytics.accounts",
          )
        ).rows[0]?.account_hash,
        "3f2d2d24ab9e020b7d31801d72fdf3f472079f978b4d3824f53423a1f21fb45b",
      );
    } finally {
      stopActivity();
    }
    const browser = request({
      cookie: `__Host-blast_wallet=${sessionToken}`,
      "x-vercel-forwarded-for": "192.0.2.1",
    });
    assert.equal((await relay(browser)).status, 204);
    const browserHeaders = {
      cookie: `__Host-blast_wallet=${sessionToken}`,
      "x-vercel-forwarded-for": "192.0.2.1",
    };
    // The relay normalizes an empty byte stream to no body; nonempty bytes are refused.
    assert.equal(
      (await relay(request(browserHeaders, undefined, { body: "" }))).status,
      204,
    );
    assert.equal(
      (
        await relay(
          request(browserHeaders, undefined, { body: '{"account":"raw"}' }),
        )
      ).status,
      413,
    );
    assert.deepEqual(
      (
        await warehouse.query(
          "SELECT account_hash FROM blast_analytics.accounts",
        )
      ).rows,
      [
        {
          account_hash:
            "3f2d2d24ab9e020b7d31801d72fdf3f472079f978b4d3824f53423a1f21fb45b",
        },
      ],
    );
    assert.ok(transported);
    assert.notEqual(transported.headers.get("x-blast-private-signature"), null);
    assert.equal(
      (await relay(request({ "x-vercel-forwarded-for": "192.0.2.1" }))).status,
      401,
    );
    assert.equal(
      (
        await relay(
          request({
            cookie: `__Host-blast_wallet=${sessionToken}`,
            origin: "https://attacker.test",
            "x-vercel-forwarded-for": "192.0.2.1",
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await relay(
          request(
            {
              cookie: `__Host-blast_wallet=${sessionToken}`,
              "x-vercel-forwarded-for": "192.0.2.1",
            },
            "/api/analytics/activity?account=raw",
          ),
        )
      ).status,
      400,
    );
  } finally {
    await takeProcessSingleton<ReturnType<typeof createAccountActivityService>>(
      "analytics.account-activity",
    )?.close();
    takeProcessSingleton("runtimeConfig");
    takeProcessSingleton("relayConfig");
  }
});

test("resumes a successful account write at the UTC boundary before fifteen minutes", async (context) => {
  await newAccount();
  let monotonic = 1000;
  context.mock.method(performance, "now", () => monotonic);
  const definition = (
    await warehouse.query(
      "SELECT pg_get_functiondef('blast_analytics.record_activity(text,text)'::regprocedure) AS definition",
    )
  ).rows[0].definition as string;
  assert.equal(definition.split("clock_timestamp()").length, 2);
  // Control only the warehouse observation clock in this disposable fixture.
  // The actual function, restricted caller, writes and live service cache remain in use.
  const observe = (timestamp: string) =>
    warehouse.query(
      definition.replace("clock_timestamp()", `'${timestamp}'::timestamptz`),
    );
  const authorization = `Bearer ${jwt(did)}`;
  try {
    await observe("2030-01-01T23:59:50Z");
    assert.equal(
      (await service.handle(request({ authorization }))).status,
      204,
    );
    assert.deepEqual(
      (
        await warehouse.query(
          "SELECT day::text FROM blast_analytics.account_days ORDER BY day",
        )
      ).rows,
      [{ day: "2030-01-01" }],
    );
    await observe("2030-01-02T00:00:01Z");
    monotonic = 12000;
    assert.equal(
      (await service.handle(request({ authorization }))).status,
      204,
    );
    assert.deepEqual(
      (
        await warehouse.query(
          "SELECT day::text FROM blast_analytics.account_days ORDER BY day",
        )
      ).rows,
      [{ day: "2030-01-01" }, { day: "2030-01-02" }],
    );
    const rows = (
      await warehouse.query(
        "SELECT first_seen,last_seen FROM blast_analytics.accounts",
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].first_seen.toISOString(), "2030-01-01T23:59:50.000Z");
    assert.equal(rows[0].last_seen.toISOString(), "2030-01-02T00:00:01.000Z");
  } finally {
    await warehouse.query(definition);
  }
});

test("a non-superuser warehouse owner can upgrade without inherited definer rights", async () => {
  const name = `analytics_operator_${process.pid}`;
  const role = "activity_migration_operator";
  await admin.query(
    `CREATE ROLE ${role} LOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD 'disposable-test'`,
  );
  await admin.query(
    `GRANT blast_analytics_activity_owner TO ${role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
  );
  await admin.query(`CREATE DATABASE ${name} OWNER ${role}`);
  const operatorUrl = new URL(database.url);
  operatorUrl.pathname = `/${name}`;
  operatorUrl.username = role;
  operatorUrl.password = "disposable-test";
  const operator = new Pool({
    connectionString: operatorUrl.toString(),
    max: 1,
  });
  const capabilityUrl = new URL(operatorUrl);
  capabilityUrl.username = "activity_ingress";
  const capability = new Pool({
    connectionString: capabilityUrl.toString(),
    max: 1,
  });
  try {
    assert.equal(
      (
        await operator.query(
          "SELECT pg_has_role(current_user,'blast_analytics_activity_owner','SET') AS can_set",
        )
      ).rows[0].can_set,
      false,
    );
    await operator.query(
      await readFile(
        new URL(
          "../../../../../apps/workers/src/modules/analytics/warehouse.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await operator.query(
      await readFile(
        new URL(
          "../../../../../apps/workers/src/modules/analytics/migrations/0001_account_activity.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      (
        await operator.query(`SELECT
      pg_has_role(current_user,'blast_analytics_activity_owner','SET') AS can_set,
      pg_has_role(current_user,'blast_analytics_activity_owner','USAGE') AS inherits,
      has_schema_privilege('blast_analytics_activity_owner','blast_analytics','CREATE') AS owner_create,
      (SELECT rolname FROM pg_roles WHERE oid=(SELECT proowner FROM pg_proc WHERE oid='blast_analytics.record_activity(text,text)'::regprocedure)) AS owner`)
      ).rows,
      [
        {
          can_set: true,
          inherits: false,
          owner_create: false,
          owner: "blast_analytics_activity_owner",
        },
      ],
    );
    await capability.query(
      "SELECT blast_analytics.record_activity(repeat('a',64),repeat('b',64))",
    );
    assert.deepEqual(
      (
        await operator.query(
          "SELECT account_hash FROM blast_analytics.accounts",
        )
      ).rows,
      [{ account_hash: "a".repeat(64) }],
    );
    await assert.rejects(
      capability.query("SELECT * FROM blast_analytics.accounts"),
      { code: "42501" },
    );
    await assert.rejects(
      capability.query("SET ROLE blast_analytics_activity_owner"),
      { code: "42501" },
    );
  } finally {
    await Promise.all([capability.end(), operator.end()]);
    await dropClosedDatabase(admin, name);
    await admin.query(`DROP ROLE ${role}`);
  }
});
