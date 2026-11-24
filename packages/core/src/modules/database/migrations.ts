import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { Pool, PoolClient } from "pg";

const MIGRATION_LOCK = 7_524_617_001;
const MIGRATION_NAME = /^(.+)\.up\.sql$/;
const MIGRATIONS_URL = new URL("./migrations/", import.meta.url);

interface Migration {
  name: string;
  checksum: string;
  up: string;
  down: string;
}

interface AppliedMigrationRow {
  name: string;
  checksum: string;
}

interface MissionControlTableRow {
  table_name: string;
}

const RESET_PRESERVED_TABLES = new Set([
  "mission_control_reserved_callsigns",
  "mission_control_schema_migrations",
  // The operational worker's state is the launchpad's, not Mission Control's:
  // a Mission Control reset keeps its cursor, records, open submissions and leases.
  "mission_control_worker_leases",
  "mission_control_worker_jobs",
  "mission_control_worker_submissions",
  "mission_control_coin_registrations",
  "mission_control_launch_migrations",
  "mission_control_opening_rounds",
  "mission_control_fee_claims",
  // Launchpad social records are durable audit identity, not Mission Control
  // state: a reset keeps authors, posts, their moderation actions and search rows.
  "mission_control_launchpad_social_authors",
  "mission_control_launchpad_theses",
  "mission_control_launchpad_thesis_moderation",
  "mission_control_launchpad_search_documents",
  "mission_control_bonding_feature",
  "mission_control_vault_buybacks",
  // Retired chain controls retain custody history until the offline runbook reconciles it.
  "mission_control_launchpad_buybacks",
]);
const RESET_REQUIRED_TABLES = [
  "mission_control_invitation_codes",
  "mission_control_seasons",
] as const;

function quoteIdentifier(identifier: string): string {
  if (!/^mission_control_[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Cannot reset unexpected table ${identifier}.`);
  }
  return `"${identifier}"`;
}

async function loadMigrations(): Promise<Migration[]> {
  const files = await readdir(MIGRATIONS_URL);
  const names = files
    .map((file) => file.match(MIGRATION_NAME)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const [up, down] = await Promise.all([
        readFile(new URL(`${name}.up.sql`, MIGRATIONS_URL), "utf8"),
        readFile(new URL(`${name}.down.sql`, MIGRATIONS_URL), "utf8"),
      ]);

      return {
        name,
        checksum: createHash("sha256").update(up).digest("hex"),
        up,
        down,
      };
    }),
  );
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS mission_control_schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function inMigrationLock<Result>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    return await operation(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    client.release();
  }
}

/** `through` stops after that migration, so a rehearsal can change privileges where production's history did. */
export async function migrateDatabase(
  pool: Pool,
  options: { readonly through?: string } = {},
): Promise<string[]> {
  return inMigrationLock(pool, async (client) => {
    await ensureMigrationTable(client);
    const all = await loadMigrations();
    const stop = options.through === undefined ? all.length : all.findIndex(({ name }) => name === options.through) + 1;
    if (stop === 0) throw new Error(`No migration is named ${options.through}.`);
    const migrations = all.slice(0, stop);
    const applied = await client.query<AppliedMigrationRow>(
      "SELECT name, checksum FROM mission_control_schema_migrations ORDER BY name",
    );
    const appliedByName = new Map(
      applied.rows.map((migration) => [migration.name, migration.checksum]),
    );
    const newlyApplied: string[] = [];

    for (const migration of migrations) {
      const appliedChecksum = appliedByName.get(migration.name);

      if (appliedChecksum && appliedChecksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${migration.name} does not match its checked-in checksum.`,
        );
      }

      if (appliedChecksum) {
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.up);
        await client.query(
          `INSERT INTO mission_control_schema_migrations (name, checksum)
           VALUES ($1, $2)`,
          [migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        newlyApplied.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return newlyApplied;
  });
}

export async function resetDatabase(pool: Pool): Promise<string[]> {
  return inMigrationLock(pool, async (client) => {
    await ensureMigrationTable(client);
    const applied = await client.query<AppliedMigrationRow>(
      "SELECT name, checksum FROM mission_control_schema_migrations ORDER BY name",
    );
    const tables = await client.query<MissionControlTableRow>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name LIKE 'mission_control_%'
       ORDER BY table_name`,
    );
    const resetTables = tables.rows
      .map(({ table_name: tableName }) => tableName)
      .filter((tableName) => !RESET_PRESERVED_TABLES.has(tableName));
    const availableTables = new Set(
      tables.rows.map(({ table_name: tableName }) => tableName),
    );
    if (RESET_REQUIRED_TABLES.some((tableName) => !availableTables.has(tableName))) {
      throw new Error("Cannot reset Mission Control before its schema is migrated.");
    }

    await client.query("BEGIN");
    try {
      await client.query(
        `CREATE TEMP TABLE mission_control_reset_sticky_codes
         ON COMMIT DROP AS
         SELECT *
         FROM mission_control_invitation_codes
         WHERE sticky_position IS NOT NULL`,
      );
      await client.query(
        `UPDATE mission_control_reset_sticky_codes
         SET enabled = TRUE,
             consumed_at = NULL,
             owner_profile_id = NULL,
             batch_id = NULL,
             operator_action_id = NULL,
             source_allocation_id = NULL,
             allocation_ordinal = NULL,
             consumed_by_profile_id = NULL`,
      );
      if (resetTables.length > 0) {
        await client.query(
          `TRUNCATE TABLE ${resetTables.map(quoteIdentifier).join(", ")}
           RESTART IDENTITY CASCADE`,
        );
      }
      await client.query(
        `INSERT INTO mission_control_seasons (season_id)
         VALUES ('season-zero')`,
      );
      await client.query(
        `INSERT INTO mission_control_invitation_codes
         SELECT * FROM mission_control_reset_sticky_codes`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    return applied.rows.map(({ name }) => name);
  });
}
