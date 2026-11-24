import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { createAccessRedeemer } from "../src/access.ts";
import { createDashboardHandler } from "../src/handler.ts";
import { createSummaryReader } from "../src/summary.ts";
// eslint-disable-next-line no-restricted-imports -- Proof-only import of the actual API; runtime imports only its generated pure contract.
import { createAnalyticsHandler } from "../../../workers/src/modules/analytics/api.ts";
// eslint-disable-next-line no-restricted-imports -- Proof-only operator mint in the disposable warehouse.
import { mintAccessCode } from "../../../workers/src/modules/analytics/access-codes.ts";
import { payload, serve, token } from "./fixture.ts";

test("the restricted warehouse login atomically redeems once through HTTP without mint, table or snapshot access", async () => {
  const raw = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
  if (!raw)
    throw new Error("Explicit disposable loopback PostgreSQL is required");
  const sourceUrl = new URL(raw);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(sourceUrl.hostname),
    "Explicit disposable loopback PostgreSQL is required",
  );
  const source = new Pool({ connectionString: sourceUrl.toString(), max: 1 });
  const database = `dashboard_${process.pid}`,
    accessRole = `dashboard_access_${process.pid}`,
    readerRole = `dashboard_reader_${process.pid}`;
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = `/${database}`;
  const roleUrl = (name: string) => {
    const url = new URL(adminUrl);
    url.username = name;
    url.password = "disposable-test";
    return url.toString();
  };
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  let access: ReturnType<typeof createAccessRedeemer> | undefined;
  let accessPool: Pool | undefined, reader: Pool | undefined;
  let dashboard: Awaited<ReturnType<typeof serve>> | undefined,
    api: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await source.query(`CREATE DATABASE ${database}`);
    await admin.query(
      await readFile(
        new URL(
          "../../../workers/src/modules/analytics/warehouse.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await admin.query(
      `CREATE ROLE ${accessRole} LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_access TO ${accessRole}; CREATE ROLE ${readerRole} LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_reader TO ${readerRole};`,
    );
    access = createAccessRedeemer(roleUrl(accessRole));
    accessPool = new Pool({ connectionString: roleUrl(accessRole), max: 1 });
    reader = new Pool({ connectionString: roleUrl(readerRole), max: 1 });
    await admin.query(
      "INSERT INTO blast_analytics.snapshots(singleton,generated_at,payload) VALUES(true,now(),$1)",
      [payload()],
    );
    const apiReader = reader;
    api = await serve(() =>
      createAnalyticsHandler(token, async () => {
        const result = await apiReader.query(
          "SELECT generated_at,payload FROM blast_analytics.snapshots WHERE singleton",
        );
        return result.rows[0] ?? null;
      }),
    );
    const read = createSummaryReader(api.origin, token, { development: true });
    const redeem = access.redeem;
    dashboard = await serve((config) =>
      createDashboardHandler(config, read, redeem),
    );
    const code = await mintAccessCode(admin);
    const post = {
      method: "POST",
      headers: {
        Origin: dashboard.origin,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `password=${code}`,
      redirect: "manual" as const,
    };
    const [first, second] = await Promise.all([
      fetch(dashboard.origin + "/auth/login", post),
      fetch(dashboard.origin + "/auth/login", post),
    ]);
    assert.equal(
      Number(first.headers.has("set-cookie")) +
        Number(second.headers.has("set-cookie")),
      1,
    );
    const accepted = first.headers.has("set-cookie") ? first : second,
      denied = accepted === first ? second : first;
    assert.equal(denied.headers.get("location"), "/?access=invalid");
    const cookie = accepted.headers.get("set-cookie")!.split(";")[0]!;
    const summary = await fetch(dashboard.origin + "/api/summary", {
      headers: { Cookie: cookie },
    });
    assert.equal(summary.status, 200);
    assert.equal((await summary.json()).accountActivity, null);
    assert.equal(await redeem(code), null);
    assert.equal(await redeem("z".repeat(43)), null);
    const expired = "e".repeat(43);
    await admin.query(
      "INSERT INTO blast_analytics.access_codes VALUES($1,now()-INTERVAL '1 second',NULL)",
      [createHash("sha256").update(expired).digest("hex")],
    );
    assert.equal(await redeem(expired), null);
    await assert.rejects(
      accessPool.query("SELECT * FROM blast_analytics.access_codes"),
      { code: "42501" },
    );
    await assert.rejects(
      accessPool.query("SELECT * FROM blast_analytics.snapshots"),
      { code: "42501" },
    );
    await assert.rejects(mintAccessCode(accessPool), { code: "42501" });
    const stored = (
      await admin.query(
        "SELECT code_hash,used_at IS NOT NULL AS used FROM blast_analytics.access_codes WHERE code_hash=$1",
        [createHash("sha256").update(code).digest("hex")],
      )
    ).rows[0];
    assert.equal(stored.used, true);
    assert.equal(stored.code_hash.length, 64);
    await admin.query(
      "REVOKE SELECT ON blast_analytics.snapshots FROM blast_analytics_reader",
    );
    const refused = await fetch(api.origin + "/v1/summary", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: "snapshot_unavailable" });
  } finally {
    await dashboard?.close();
    await api?.close();
    await access?.close();
    await accessPool?.end();
    await reader?.end();
    await admin.end();
    // Pool end can precede the backend processing its Terminate packet.
    // Wait for owned backends rather than force-killing a closing client socket.
    const deadline = Date.now() + 1000;
    while (true) {
      const remaining = await source.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
        [database],
      );
      if (remaining.rows[0]!.count === 0) break;
      assert.ok(
        Date.now() < deadline,
        "Owned warehouse connections must close",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await source.query(`DROP DATABASE IF EXISTS ${database}`);
    await source.query(
      `DROP ROLE IF EXISTS ${accessRole}; DROP ROLE IF EXISTS ${readerRole}`,
    );
    await source.end();
  }
});
