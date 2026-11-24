import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { CHAIN_FIXTURE, FIXTURE_CHECKPOINT } from "./role-fixtures.ts";

/**
 * A migrated database of its own for one test, cloned from a template.
 *
 * Rebuilding the shared database (drop schemas, chain fixture, every migration)
 * costs about 6 s; cloning a migrated template costs about 0.3 s. The first
 * call on a server builds the template under an advisory lock, so processes
 * sharing a server build it once. Its name carries a hash of the migrations and
 * the chain fixture, so a changed migration gets a new template, never a stale
 * one. Every call clones it under a new name. `mission_control_test`, the
 * database the container starts with, stays unmigrated: a test still reading
 * `MISSION_CONTROL_TEST_DATABASE_URL` fails loudly instead of passing on another
 * test's rows.
 */
export type TestDatabase = Readonly<{
  /** Superuser URL of the clone; `urlAs(url, role)` gives a runtime role on it. */
  url: string;
  /** Drops the clone, closing any connection still open on it. Call it after the test's pools end. */
  drop(): Promise<void>;
}>;

const MIGRATIONS = new URL("../../../../src/modules/database/migrations/", import.meta.url);
const TEMPLATE_LOCK = 7_401_336_201;

let templateBuild: Promise<string> | undefined;
let clones = 0;

export async function freshTestDatabase(): Promise<TestDatabase> {
  templateBuild ??= buildTemplate().catch((error: unknown) => {
    templateBuild = undefined;
    throw error;
  });
  const source = await templateBuild;
  const name = `test_${process.pid}_${++clones}_${randomBytes(3).toString("hex")}`;
  await onServer((server) => server.query(`CREATE DATABASE ${name} TEMPLATE ${source}`));
  const url = databaseUrl(name);
  // The fixture stamps the watermarks with the clock at build time; each test sees them committed just now.
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      UPDATE watermarks
        SET timestamp_ms_hi_inclusive = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
            pruner_timestamp = now();
      UPDATE checkpoint_journal
        SET timestamp_ms = (SELECT timestamp_ms_hi_inclusive FROM watermarks WHERE pipeline = 'intake')
        WHERE checkpoint = ${FIXTURE_CHECKPOINT};
    `);
  } finally {
    await client.end();
  }
  return {
    url,
    drop: async () => {
      await onServer((server) => server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** Builds the template for the current migrations and chain fixture, once per server, and returns its name. */
async function buildTemplate(): Promise<string> {
  const template = await templateName();
  await onServer(async (server) => {
    await server.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    try {
      const { rows } = await server.query<{ datistemplate: boolean }>(
        "SELECT datistemplate FROM pg_database WHERE datname = $1",
        [template],
      );
      if (rows[0]?.datistemplate) return;
      // A build that died half way left an unmarked database: start again.
      if (rows.length) await server.query(`DROP DATABASE ${template} WITH (FORCE)`);
      await server.query(`CREATE DATABASE ${template}`);
      const pool = new pg.Pool({ connectionString: databaseUrl(template), max: 1 });
      try {
        await pool.query(CHAIN_FIXTURE);
        await migrateDatabase(pool);
      } finally {
        await pool.end();
      }
      await server.query(`ALTER DATABASE ${template} WITH IS_TEMPLATE true`);
    } finally {
      await server.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK]);
    }
  });
  return template;
}

/** `mission_control_template_` plus a short hash of every migration file and the chain fixture. */
async function templateName(): Promise<string> {
  const hash = createHash("sha256").update(CHAIN_FIXTURE);
  for (const file of (await readdir(MIGRATIONS)).sort()) {
    hash.update(file).update(await readFile(new URL(file, MIGRATIONS)));
  }
  return `mission_control_template_${hash.digest("hex").slice(0, 12)}`;
}

/** Runs `operation` on the server's maintenance database, which no test uses. */
async function onServer<T>(operation: (server: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl("postgres") });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

function databaseUrl(database: string): string {
  const base = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
  if (!base) throw new Error("MISSION_CONTROL_TEST_DATABASE_URL is not set");
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}
