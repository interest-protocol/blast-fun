import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Pool } from "pg";

import { blankDraft, parseDraft } from "@blast/core/modules/social/create/model.ts";
import { freshTestDatabase } from "../../../../test/fixtures/modules/database/template.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "Disposable PostgreSQL required";
const MIGRATION = "0130_social_recipient_drafts";
const CONSTRAINT = "social_presale_drafts_canonical_recipients";
const ACCOUNT = "00000000-0000-4000-8000-000000000130";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const oldRow = { label: "Team", address: "half typed", bps: 1250, vest: false, cliff_months: 3, months: 12 };
const expectedRow = { label: "Team", address: "half typed", bps: 1250, vest: false, cliff: 3, duration: 12, cliff_unit: "months", duration_unit: "months" };
const canonicalRow = { label: "Treasury", address: "", bps: 0, vest: false, cliff: 5, duration: 17, cliff_unit: "minutes", duration_unit: "weeks" };
const migrationSql = (direction: "up" | "down") => readFile(new URL(`../../../../../../packages/core/src/modules/database/migrations/${MIGRATION}.${direction}.sql`, import.meta.url), "utf8");

async function withDatabase(run: (pool: Pool) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const pool = createPool(database.url, { max: 3 });
  try {
    // Recreate the predecessor state on a clone of the fully migrated template.
    await pool.query(`ALTER TABLE social_presale_drafts DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
    await pool.query("DELETE FROM mission_control_schema_migrations WHERE name = $1", [MIGRATION]);
    await pool.query("INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES ($1, 'did:privy:recipient-migration', 'recipient_migration')", [ACCOUNT]);
    await run(pool);
  } finally {
    await pool.end();
    await database.drop();
  }
}

async function insert(pool: Pool, number: number, body: unknown, published = false): Promise<void> {
  await pool.query(`INSERT INTO social_presale_drafts
    (draft_id, account_id, version, body, logo_url, allowlist, created_at, updated_at,
     quote_type, site, x_handle, telegram, docs_url, audit_url, cover_key, cover_url,
     cover_width, cover_height, published_presale_id, published_at)
    VALUES ($1, $2, 7, $3::jsonb, 'https://example.test/logo.png', '{"retained":"raw"}',
      '2026-09-01 12:34:56.123456+00', '2026-09-02 12:34:56.654321+00',
      '0x2::sui::SUI', 'https://example.test', 'creator', 'creator',
      'https://example.test/docs', 'https://example.test/audit',
      $4, 'https://example.test/cover.webp', 512, 256, $5, $6)`,
  [id(number), ACCOUNT, JSON.stringify(body), `draft-covers/${id(number)}/${"a".repeat(64)}.webp`,
    published ? `0x${number.toString(16).padStart(64, "0")}` : null,
    published ? "2026-09-03 12:34:56.987654+00" : null]);
}

async function snapshot(pool: Pool) {
  // SQL renders timestamps to preserve microseconds rather than JS Date precision.
  const { rows } = await pool.query<{ draft_id: string; body: Record<string, unknown>; protected: string }>(
    "SELECT draft_id, body, (to_jsonb(d) - 'body')::text AS protected FROM social_presale_drafts d ORDER BY draft_id",
  );
  return { rows, protectedHash: createHash("sha256").update(JSON.stringify(rows.map((row) => row.protected))).digest("hex") };
}

test("recipient migration preserves all row facts, normalizes both arrays once and blocks stale old writes", { skip }, () => withDatabase(async (pool) => {
  const raw = { ...blankDraft(), token_recipients: [oldRow, canonicalRow], raise_recipients: [oldRow] };
  // Absence of unrelated optional facts is preserved, rather than parser defaults being serialized.
  Reflect.deleteProperty(raw, "site");
  Reflect.deleteProperty(raw, "quote_type");
  await insert(pool, 1, raw);
  await insert(pool, 2, { ...raw, token_recipients: [canonicalRow], raise_recipients: [oldRow, canonicalRow] }, true);
  await insert(pool, 3, { ...blankDraft(), token_recipients: [canonicalRow], raise_recipients: [] });
  const before = await snapshot(pool);
  const applied = await migrateDatabase(pool);
  const after = await snapshot(pool);
  assert.deepEqual(after.rows[0]!.body, { ...raw, token_recipients: [expectedRow, canonicalRow], raise_recipients: [expectedRow] });
  assert.deepEqual(after.rows[1]!.body, { ...raw, token_recipients: [canonicalRow], raise_recipients: [expectedRow, canonicalRow] });
  assert.deepEqual(after.rows[2], before.rows[2]);
  assert.equal(after.protectedHash, before.protectedHash);
  assert.deepEqual(applied, [MIGRATION]);
  const ledger = (await pool.query("SELECT * FROM mission_control_schema_migrations ORDER BY name")).rows;
  assert.deepEqual(await migrateDatabase(pool), []);
  assert.deepEqual(await snapshot(pool), after);
  assert.deepEqual((await pool.query("SELECT * FROM mission_control_schema_migrations ORDER BY name")).rows, ledger);
  await assert.rejects(insert(pool, 4, raw), { code: "23514", constraint: CONSTRAINT });
  assert.deepEqual(await snapshot(pool), after);
}));

test("one ambiguous recipient aborts every draft update and the migration ledger", { skip }, () => withDatabase(async (pool) => {
  const good = { ...blankDraft(), token_recipients: [oldRow], raise_recipients: [oldRow] };
  await insert(pool, 1, good);
  await insert(pool, 2, { ...good, raise_recipients: [{ ...oldRow, cliff: 4 }] });
  const before = await snapshot(pool);
  await assert.rejects(migrateDatabase(pool), /recipient draft migration refused/);
  assert.deepEqual(await snapshot(pool), before);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM mission_control_schema_migrations WHERE name = $1", [MIGRATION])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'social_presale_drafts'::regclass AND conname = $1", [CONSTRAINT])).rows[0].n, 0);
}));

test("invalid recipient shapes and scalars refuse without partial updates or ledger writes", { skip }, () => withDatabase(async (pool) => {
  const missing = { ...oldRow } as Record<string, unknown>;
  delete missing.months;
  const badArrays: unknown[] = [
    null, {}, "[]", [null], [3], [missing], [{ ...oldRow, extra: true }],
    [{ ...oldRow, duration_unit: "months" }], [{ ...oldRow, cliff_months: "3" }],
    [{ ...oldRow, cliff_months: -1 }], [{ ...oldRow, months: 1.5 }],
    [{ ...oldRow, months: 9007199254740992 }], [{ ...oldRow, bps: 1000001 }],
    [{ ...oldRow, bps: null }], [{ ...oldRow, vest: "false" }],
    [{ ...oldRow, label: "a".repeat(21) }], [{ ...oldRow, address: "a".repeat(67) }],
    [{ ...oldRow, label: "bad\nlabel" }], [{ ...oldRow, address: "bad\u007faddress" }],
    [{ ...canonicalRow, duration_unit: "years" }], [{ ...canonicalRow, cliff_unit: null }],
    [{ ...canonicalRow, cliff: -1 }], [{ ...canonicalRow, months: 3 }],
    Array.from({ length: 65 }, () => oldRow),
  ];
  const good = { ...blankDraft(), token_recipients: [oldRow], raise_recipients: [] };
  for (const [index, invalid] of badArrays.entries()) {
    await pool.query("DELETE FROM social_presale_drafts");
    await insert(pool, 1, good);
    // Alternate the two arrays; an error in either must preserve all rows.
    await insert(pool, 2, { ...good, [index % 2 ? "raise_recipients" : "token_recipients"]: invalid });
    const before = await snapshot(pool);
    await assert.rejects(migrateDatabase(pool), /recipient draft migration refused/, `case ${index}`);
    assert.deepEqual(await snapshot(pool), before, `case ${index}`);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM mission_control_schema_migrations WHERE name = $1", [MIGRATION])).rows[0].n, 0);
  }
}));

test("maximum arrays, safe integers, every unit and unfinished values retain canonical meaning", { skip }, () => withDatabase(async (pool) => {
  const units = ["months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"];
  const current = units.map((unit) => ({ ...canonicalRow, cliff_unit: unit, duration_unit: unit }));
  const unitless = { label: "", address: "", bps: 0, vest: false, cliff: 0, duration: 0 };
  const largeOld = { label: "\u0085", address: "😀".repeat(33), bps: 1000000, vest: false, cliff_months: 9007199254740991, months: 0 };
  const largeExpected = { label: "\u0085", address: "😀".repeat(33), bps: 1000000, vest: false, cliff: 9007199254740991, duration: 0, cliff_unit: "months", duration_unit: "months" };
  const raw = { ...blankDraft(), token_recipients: Array.from({ length: 64 }, () => largeOld), raise_recipients: [...current, unitless] };
  await insert(pool, 1, raw);
  await insert(pool, 2, { ...blankDraft(), token_recipients: [], raise_recipients: Array.from({ length: 64 }, () => oldRow) });
  const before = await snapshot(pool);
  await migrateDatabase(pool);
  const after = await snapshot(pool);
  assert.equal(after.protectedHash, before.protectedHash);
  assert.deepEqual(after.rows[0]!.body, { ...raw, token_recipients: Array.from({ length: 64 }, () => largeExpected) });
  assert.deepEqual(after.rows[1]!.body.raise_recipients, Array.from({ length: 64 }, () => expectedRow));
  assert.deepEqual(after.rows[1]!.body.token_recipients, []);
  for (const row of after.rows) assert.doesNotThrow(() => parseDraft(row.body));
}));

test("transformed body overflow refuses atomically instead of truncating raw facts", { skip }, () => withDatabase(async (pool) => {
  // Exercise the database's independent byte guard. This extra synthetic field
  // would also fail the mandatory full-body preflight for retained data.
  const raw = { ...blankDraft(), token_recipients: [oldRow], raise_recipients: [], opaque_fixture_padding: "" };
  const initial = (await pool.query("SELECT octet_length($1::jsonb::text)::int AS size", [JSON.stringify(raw)])).rows[0].size;
  raw.opaque_fixture_padding = "x".repeat(65536 - initial);
  await insert(pool, 1, raw);
  const before = await snapshot(pool);
  await assert.rejects(migrateDatabase(pool), /recipient draft migration refused: transformed body limit/);
  assert.deepEqual(await snapshot(pool), before);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM mission_control_schema_migrations WHERE name = $1", [MIGRATION])).rows[0].n, 0);
}));

test("an active writer bounds migration lock waiting and its committed edit survives retry", { skip }, () => withDatabase(async (pool) => {
  const raw = { ...blankDraft(), token_recipients: [oldRow], raise_recipients: [] };
  await insert(pool, 1, raw);
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await writer.query("UPDATE social_presale_drafts SET body = jsonb_set(body, '{name}', '\"Concurrent edit\"'), version = 8 WHERE draft_id = $1", [id(1)]);
    const before = await snapshot(pool);
    await assert.rejects(migrateDatabase(pool), { code: "55P03" });
    assert.deepEqual(await snapshot(pool), before);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM mission_control_schema_migrations WHERE name = $1", [MIGRATION])).rows[0].n, 0);
    await writer.query("COMMIT");
    await migrateDatabase(pool);
    const row = (await pool.query("SELECT version, body FROM social_presale_drafts WHERE draft_id = $1", [id(1)])).rows[0];
    assert.equal(row.version, 8);
    assert.deepEqual(row.body, { ...raw, name: "Concurrent edit", token_recipients: [expectedRow] });
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
  }
}));

test("a read-then-write transaction completes before migration without a lock-upgrade deadlock", { skip }, () => withDatabase(async (pool) => {
  const raw = { ...blankDraft(), token_recipients: [oldRow], raise_recipients: [] };
  await insert(pool, 1, raw);
  const writer = await pool.connect();
  let pending: Promise<{ applied?: string[]; error?: unknown }> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query("SELECT draft_id FROM social_presale_drafts WHERE draft_id = $1 FOR UPDATE", [id(1)]);
    pending = migrateDatabase(pool).then((applied) => ({ applied }), (error: unknown) => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await pool.query("SELECT 1 FROM pg_locks WHERE relation = 'social_presale_drafts'::regclass AND mode = 'AccessExclusiveLock' AND NOT granted");
      if (rows.length > 0) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(waiting, "migration must wait for its final DDL lock before reading or updating any row");
    await writer.query("UPDATE social_presale_drafts SET body = jsonb_set(body, '{name}', '\"Read then write\"'), version = 8 WHERE draft_id = $1", [id(1)]);
    await writer.query("COMMIT");
    assert.deepEqual(await pending, { applied: [MIGRATION] });
    const row = (await pool.query("SELECT version, body FROM social_presale_drafts WHERE draft_id = $1", [id(1)])).rows[0];
    assert.equal(row.version, 8);
    assert.deepEqual(row.body, { ...raw, name: "Read then write", token_recipients: [expectedRow] });
  } finally {
    await writer.query("ROLLBACK");
    writer.release();
    if (pending) await pending;
  }
}));

test("a queued old writer waits for migration commit and is then rejected without losing data", { skip }, () => withDatabase(async (pool) => {
  const raw = { ...blankDraft(), token_recipients: [oldRow], raise_recipients: [] };
  await insert(pool, 1, raw);
  const migrator = await pool.connect();
  const writer = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await migrator.query("BEGIN");
    await migrator.query(await migrationSql("up"));
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await writer.query("SET statement_timeout = '10s'");
    // Handle rejection immediately so the pending query never creates an
    // unhandled promise while the migration still owns the lock.
    pending = writer.query("UPDATE social_presale_drafts SET body = $2::jsonb, version = 8 WHERE draft_id = $1", [id(1), JSON.stringify(raw)])
      .then(() => ({ code: "unexpected_success" }), (error: unknown) => error);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const row = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0];
      if (row?.wait_event_type === "Lock") { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "the real writer must be observed waiting on a PostgreSQL lock");
    await migrator.query("COMMIT");
    const error = await pending as { code?: string; constraint?: string };
    assert.equal(error.code, "23514");
    assert.equal(error.constraint, CONSTRAINT);
    const row = (await pool.query("SELECT version, body FROM social_presale_drafts WHERE draft_id = $1", [id(1)])).rows[0];
    assert.equal(row.version, 7);
    assert.deepEqual(row.body, { ...raw, token_recipients: [expectedRow] });
  } finally {
    await migrator.query("ROLLBACK");
    if (pending) await pending;
    writer.release();
    migrator.release();
  }
}));

test("down removes only the guard and reapplying up retains canonical bodies and metadata", { skip }, () => withDatabase(async (pool) => {
  await insert(pool, 1, { ...blankDraft(), token_recipients: [oldRow], raise_recipients: [] });
  await migrateDatabase(pool);
  const after = await snapshot(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(await migrationSql("down"));
    await client.query("DELETE FROM mission_control_schema_migrations WHERE name = $1", [MIGRATION]);
    await client.query("COMMIT");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  assert.deepEqual(await snapshot(pool), after);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'social_presale_drafts'::regclass AND conname = $1", [CONSTRAINT])).rows[0].n, 0);
  assert.deepEqual(await migrateDatabase(pool), [MIGRATION]);
  assert.deepEqual(await snapshot(pool), after);
}));
