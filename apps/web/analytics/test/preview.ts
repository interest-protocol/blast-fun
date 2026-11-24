/** Disposable local browser proof, never a production entrypoint. */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
// eslint-disable-next-line no-restricted-imports -- Browser proof uses the actual API over its own disposable warehouse.
import { createAnalyticsHandler } from "../../../workers/src/modules/analytics/api.ts";
// eslint-disable-next-line no-restricted-imports -- Browser proof mints one disposable code with its local owner.
import { mintAccessCode } from "../../../workers/src/modules/analytics/access-codes.ts";
import { createAccessRedeemer } from "../src/access.ts";
import { createDashboardHandler } from "../src/handler.ts";
import { createSummaryReader } from "../src/summary.ts";
import { payload, token } from "./fixture.ts";

const databaseUrl = new URL(
  process.env.MISSION_CONTROL_TEST_DATABASE_URL ?? "http://missing.invalid",
);
if (databaseUrl.hostname !== "127.0.0.1")
  throw new Error("Disposable loopback PostgreSQL required");
const directory = process.env.DASHBOARD_PREVIEW_DIRECTORY;
if (!directory?.startsWith("/tmp/blast-dashboard-399-"))
  throw new Error("Task-owned preview directory required");
const source = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
const database = `dashboard_preview_${process.pid}`;
const accessRole = `dashboard_preview_access_${process.pid}`,
  readerRole = `dashboard_preview_reader_${process.pid}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
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
  `CREATE ROLE ${accessRole} LOGIN; GRANT blast_analytics_access TO ${accessRole}; CREATE ROLE ${readerRole} LOGIN; GRANT blast_analytics_reader TO ${readerRole};`,
);
const roleUrl = (role: string) => {
  const url = new URL(adminUrl);
  url.username = role;
  return url.toString();
};
const access = createAccessRedeemer(roleUrl(accessRole));
const reader = new Pool({ connectionString: roleUrl(readerRole), max: 1 });
await writeFile(`${directory}/code`, await mintAccessCode(admin), {
  mode: 0o600,
});
await writeFile(
  `${directory}/control.json`,
  JSON.stringify({ mode: "error", revision: 0 }),
);
let mode = "error",
  clock = Date.now();
const api = createServer(
  createAnalyticsHandler(token, async () => {
    if (mode === "error") throw new Error("Disposable simulated API failure");
    if (mode === "loading")
      await new Promise((resolve) => setTimeout(resolve, 1200));
    const result = await reader.query(
      "SELECT generated_at,payload FROM blast_analytics.snapshots WHERE singleton",
    );
    return result.rows[0] ?? null;
  }),
);
api.listen(0, "127.0.0.1");
await once(api, "listening");
const apiAddress = api.address();
if (!apiAddress || typeof apiAddress === "string")
  throw new Error("Missing address");
const load = createSummaryReader(`http://127.0.0.1:${apiAddress.port}`, token, {
  development: true,
  now: () => clock,
});
async function summary() {
  const control = JSON.parse(
    await readFile(`${directory}/control.json`, "utf8"),
  ) as { mode: string; revision: number };
  mode = control.mode;
  clock = Date.now() + control.revision * 61_000;
  const data = payload(),
    current = Date.now();
  data.asOfTimestampMs = String(current);
  data.windowEndExclusiveMs = String(current + 1);
  data.coverageStartTimestampMs = String(current - 30 * 86_400_000);
  data.dailyTradeVolume = Array.from({ length: 30 }, (_, index) => ({
    day_ms: String(
      Math.floor(current / 86_400_000) * 86_400_000 - (29 - index) * 86_400_000,
    ),
    receipts: String(100 + index * 3),
    priced_receipts: String(80 + index * 3),
    priced_usd: `${1000 + index * 111}.123456789012345678`,
  }));
  if (mode === "zero") {
    data.users.dau24h = "0";
    data.users.mau30d = "0";
    data.users.uniqueSinceCoverage = "0";
    data.totals.trade_volume = { count: "0", pricedCount: "0", pricedUsd: "0" };
    data.totals.launched_coins.count = "0";
    data.totals.transactions.count = "0";
    data.volumeWindows["24h"] = {
      receipts: "0",
      priced_receipts: "0",
      priced_usd: "0",
    };
    data.volumeWindows["30d"] = { ...data.volumeWindows["24h"] };
    data.dailyTradeVolume = [];
    data.quoteTotals = {} as typeof data.quoteTotals;
  }
  if (mode === "extreme") {
    data.volumeWindows["30d"].priced_usd =
      "1".repeat(100) + ".000000000000000001";
    data.users.uniqueSinceCoverage = "9".repeat(100);
    data.dailyTradeVolume[0]!.day_ms = "9223372036854775807";
    data.dailyTradeVolume[0]!.priced_usd = "0.000000000000000001";
    data.quoteTotals = {
      ["0x" + "a".repeat(64) + "::long_module::" + "QUOTE".repeat(20)]:
        "9".repeat(100),
    } as typeof data.quoteTotals;
  }
  if (mode === "stale") {
    data.asOfTimestampMs = String(current - 4 * 3_600_000);
    data.catchingUp = true;
  }
  if (mode !== "error")
    await admin.query(
      "INSERT INTO blast_analytics.snapshots VALUES(true,now(),$1) ON CONFLICT(singleton) DO UPDATE SET generated_at=EXCLUDED.generated_at,payload=EXCLUDED.payload",
      [data],
    );
  return load();
}
const config = {
  origin: "http://127.0.0.1:55440",
  key: createHash("sha256").update("disposable-browser-key").digest(),
  secure: false,
};
const dashboard = createServer(
  createDashboardHandler(config, summary, access.redeem),
);
dashboard.listen(55440, "127.0.0.1");
await once(dashboard, "listening");
console.log(
  "Disposable dashboard ready on http://127.0.0.1:55440; local PostgreSQL port 55439.",
);
async function close() {
  dashboard.closeAllConnections();
  api.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => dashboard.close(() => resolve())),
    new Promise<void>((resolve) => api.close(() => resolve())),
  ]);
  await access.close();
  await reader.end();
  await admin.end();
  await source.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await source.query(`DROP ROLE ${accessRole}; DROP ROLE ${readerRole}`);
  await source.end();
  process.exit(0);
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
