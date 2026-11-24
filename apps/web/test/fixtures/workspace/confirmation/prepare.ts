import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { CHAIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
const directory = process.env.T014_CONFIG_DIR;
if (
  !directory ||
  !process.env.MISSION_CONTROL_TEST_DATABASE_URL?.includes(":35276/")
)
  throw new Error("Use the assigned isolated T014 fixture");
const started = performance.now();
const pool = createPool(
  process.env.MISSION_CONTROL_TEST_DATABASE_URL,
);
try {
  const schema = await pool.query(
    "SELECT to_regclass('social_blast_workspaces') AS name",
  );
  if (!schema.rows[0].name) {
    await pool.query(CHAIN_FIXTURE);
    await migrateDatabase(pool);
  }
  if (
    (
      await pool.query(
        "SELECT account_id FROM social_accounts WHERE privy_did LIKE 'did:privy:t014-%'",
      )
    ).rowCount
  )
    throw new Error("Already prepared; reuse without reseeding");
  for (let n = 1; n <= 2; n++)
    await pool.query(
      "INSERT INTO social_accounts (account_id, privy_did, callsign, privacy) VALUES ($1,$2,$3,'public')",
      [accountId(n), `did:privy:t014-${n}`, `t014_${n}`],
    );
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    `${directory}/auth.json`,
    JSON.stringify({
      privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }),
      publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
    }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      prepared_ms: performance.now() - started,
      schema: (
        await pool.query(
          "SELECT * FROM mission_control_schema_migrations ORDER BY name DESC LIMIT 1",
        )
      ).rows,
      accounts: 2,
      workspace_rows: 0,
      max_synthetic_rows_per_table: 3,
    }),
  );
} finally {
  await pool.end();
}
function accountId(n: number) {
  return `01400000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}
