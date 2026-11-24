import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";

import type { Pool } from "pg";

import { createPresaleReceiptRecord, type PresaleReceiptRecord } from "@blast/server/modules/mission-control/card-renderer/index.ts";
import {
  CardImageService,
  FilesystemCardImageStore,
  PostgresCardImageCatalog,
  PostgresPresaleReceiptImageCatalog,
  presaleReceiptImagePathname,
} from "@blast/server/modules/mission-control/card-images/index.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { PostgresCrewDirectory } from "@blast/server/modules/presale/receipts/crew.ts";

/**
 * T-012 (AC-097 crew, AC-101 cache): the crew directory over the Mission
 * Control account tables, and the receipt image catalog
 * `presale_receipt_images` (migration 0046), both as the web runtime role
 * `blast_web`. Two service instances with their own pools share one object
 * directory and the catalog: the second serves the first's render.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const NOW = new Date("2026-10-02T12:00:00.000Z");
const POOL_SETTINGS = {
  connectionTimeoutMs: 2_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 500,
  max: 4,
  statementTimeoutMs: 5_000,
};
const PRESALE = `0x${"a1".repeat(32)}`;

async function withDatabase(t: TestContext, run: (pools: { admin: Pool; web: Pool }) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  t.mock.method(console, "info", () => {});
  const admin = createPool(databaseUrl, { max: 2 });
  const web = createRuntimePool(urlAs(databaseUrl, "blast_web"), POOL_SETTINGS, "presale-receipts-test");
  try {
    await migrateDatabase(admin);
    await admin.query("DELETE FROM presale_receipt_images");
    await run({ admin, web });
  } finally {
    await web.end();
    await admin.end();
  }
}

let next = 0x10;

/** A profile with a linked wallet, and (unless `crew` is null) a season membership. */
async function member(admin: Pool, crew: number | null, options: { suppressed?: boolean; restored?: boolean } = {}) {
  next += 1;
  const byte = next.toString(16).padStart(2, "0");
  const profileId = randomUUID();
  const legacyAddress = `0x${"e".repeat(62)}${byte}`;
  const wallet = `0x${"c".repeat(62)}${byte}`;
  await admin.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign,
       disclosure_version, disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'v1', $7)`,
    [profileId, `did:privy:${profileId}`, `x-${profileId}`, legacyAddress, `privy:legacy-${profileId}`, `receipt_${byte}`, NOW],
  );
  await admin.query(
    `INSERT INTO mission_control_account_wallets (
       wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, is_primary, verified_at
     ) VALUES ($1, $2, 'embedded', $3, $4, TRUE, $5)`,
    [randomUUID(), profileId, wallet, `privy:embedded-${profileId}`, NOW],
  );
  if (crew !== null) {
    await admin.query(
      `INSERT INTO mission_control_season_memberships (
         membership_id, allocation_id, card_id, season_id, profile_id, crew_number, fleet,
         foundry_launch_method, owner_title, zero_fleet, gold, suppressed_at, restored_at, created_at
       ) VALUES ($1, $2, $3, 'season-zero', $4, $5, 'Recon', NULL, 'Recon Fleet', FALSE, FALSE, $6, $7, $8)`,
      [
        randomUUID(), randomUUID(), randomUUID(), profileId, crew,
        options.suppressed ? NOW : null, options.restored ? NOW : null, NOW,
      ],
    );
  }
  return { wallet, legacyAddress, profileId };
}

/** Another season's membership for `profileId`, created at `createdAt`. */
async function seasonMembership(admin: Pool, profileId: string, crew: number, createdAt: Date, suppressed = false) {
  const seasonId = `season-receipts-${crew}`;
  await admin.query("INSERT INTO mission_control_seasons (season_id) VALUES ($1) ON CONFLICT DO NOTHING", [seasonId]);
  await admin.query(
    `INSERT INTO mission_control_season_memberships (
       membership_id, allocation_id, card_id, season_id, profile_id, crew_number, fleet,
       foundry_launch_method, owner_title, zero_fleet, gold, suppressed_at, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'Signal', NULL, 'Signal Fleet', FALSE, FALSE, $7, $8)`,
    [randomUUID(), randomUUID(), randomUUID(), seasonId, profileId, crew, suppressed ? createdAt : null, createdAt],
  );
}

test("the crew number comes from the linked wallet's account and membership, else null", { skip }, (t) =>
  withDatabase(t, async ({ admin, web }) => {
    const crew = new PostgresCrewDirectory(() => web);
    const linked = await member(admin, 4242);
    const noCrew = await member(admin, null);
    const suppressed = await member(admin, 4243, { suppressed: true });
    const restored = await member(admin, 4244, { suppressed: true, restored: true });

    assert.equal(await crew.crewFor(linked.wallet), 4242);
    assert.equal(await crew.crewFor(noCrew.wallet), null, "linked without a crew");
    assert.equal(await crew.crewFor(`0x${"9".repeat(64)}`), null, "not linked");
    assert.equal(await crew.crewFor(linked.legacyAddress), null, "only account wallets link a wallet");
    assert.equal(await crew.crewFor(suppressed.wallet), null, "a suppressed membership is not shown");
    assert.equal(await crew.crewFor(restored.wallet), 4244, "a restored membership is shown again");
  }));

test("the latest membership decides: a suppressed latest season hides the crew, it never falls back", { skip }, (t) =>
  withDatabase(t, async ({ admin, web }) => {
    const crew = new PostgresCrewDirectory(() => web);
    const later = new Date(NOW.getTime() + 86_400_000);
    const hidden = await member(admin, 4250);
    await seasonMembership(admin, hidden.profileId, 4251, later, true);
    assert.equal(await crew.crewFor(hidden.wallet), null, "season zero's crew is not shown in place of the suppressed latest");

    const shown = await member(admin, 4252, { suppressed: true });
    await seasonMembership(admin, shown.profileId, 4253, later);
    assert.equal(await crew.crewFor(shown.wallet), 4253, "the latest visible membership");
  }));

function receipt(wallet: string, overrides: Partial<PresaleReceiptRecord> = {}): PresaleReceiptRecord {
  return createPresaleReceiptRecord({
    schema: "blast.presale-receipt",
    version: 1,
    presaleId: PRESALE,
    wallet,
    saleToken: `0x${"3f".repeat(32)}::froggy::FROGGY`,
    quote: `0x${"db".repeat(32)}::usdc::USDC`,
    amountCommitted: "2500000000",
    quoteSymbol: "USDC",
    quoteDecimals: 6,
    coinName: "Froggy",
    coinSymbol: "FROGGY",
    logo: null,
    crew: 7,
    ...overrides,
  });
}

test("one render per digest across instances: the catalog and the store serve the second", { skip }, (t) =>
  withDatabase(t, async ({ admin }) => {
    assert.ok(databaseUrl);
    const directory = await mkdtemp(join(tmpdir(), "presale-receipts-db-"));
    const pools: Pool[] = [];
    const renders: string[] = [];
    const instance = () => {
      const pool = createRuntimePool(urlAs(databaseUrl, "blast_web"), POOL_SETTINGS, "presale-receipts-instance");
      pools.push(pool);
      return new CardImageService({
        memoryCacheBytes: 16 * 1024 * 1024,
        persistence: {
          catalog: new PostgresCardImageCatalog(pool),
          store: new FilesystemCardImageStore(directory),
          receipts: new PostgresPresaleReceiptImageCatalog(pool),
        },
        render: async () => { throw new Error("no season-zero card here"); },
        renderReceipt: async (record, format) => {
          renders.push(`${pools.length}:${format}`);
          return Buffer.from(`png:${record.wallet}:${format}:${record.amountCommitted}`);
        },
      });
    };
    try {
      const wallet = `0x${"7d".repeat(32)}`;
      const first = await instance().receiptImage({ format: "card", record: receipt(wallet) });
      const second = await instance().receiptImage({ format: "card", record: receipt(wallet) });
      assert.deepEqual([first.source, second.source], ["render", "store"]);
      assert.ok(first.bytes.equals(second.bytes));
      assert.deepEqual(renders, ["1:card"]);

      const rows = await admin.query<{ presale_id: string; wallet: string; format: string; record_digest: string; pathname: string; byte_size: number }>(
        "SELECT presale_id, wallet, format, record_digest, pathname, byte_size FROM presale_receipt_images",
      );
      const pathname = presaleReceiptImagePathname({ presaleId: PRESALE, wallet, format: "card", digest: first.digest });
      assert.deepEqual(rows.rows, [{
        presale_id: PRESALE, wallet, format: "card", record_digest: first.digest, pathname, byte_size: first.bytes.length,
      }]);
      const files = await readdir(join(directory, "presale/receipts", PRESALE, wallet));
      assert.deepEqual(files.map((file) => relative(directory, join(directory, "presale/receipts", PRESALE, wallet, file))), [pathname]);

      // A changed record is a new digest and a new row; the old row stays.
      const third = await instance().receiptImage({ format: "card", record: receipt(wallet, { amountCommitted: "3000000000" }) });
      assert.equal(third.source, "render");
      assert.equal((await admin.query("SELECT 1 FROM presale_receipt_images")).rowCount, 2);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await rm(directory, { recursive: true, force: true });
    }
  }));

test("the receipt catalog refuses malformed keys and keeps the first row of a key", { skip }, (t) =>
  withDatabase(t, async ({ admin, web }) => {
    const catalog = new PostgresPresaleReceiptImageCatalog(web);
    const key = { presaleId: PRESALE, wallet: `0x${"7d".repeat(32)}`, format: "share" as const, digest: "a".repeat(64) };
    const location = { pathname: "presale/receipts/x.png", url: "memory://x", contentType: "image/png" as const, byteSize: 10 };
    assert.equal(await catalog.find(key), null);
    await catalog.record(key, location);
    await catalog.record(key, { ...location, byteSize: 11 });
    assert.deepEqual(await catalog.find(key), location);
    for (const bad of [
      { ...key, presaleId: "0x1" },
      { ...key, wallet: key.wallet.toUpperCase() },
      { ...key, digest: "z".repeat(64) },
      { ...key, format: "post" },
    ]) {
      await assert.rejects(admin.query(
        `INSERT INTO presale_receipt_images (presale_id, wallet, format, record_digest, pathname, url, content_type, byte_size)
         VALUES ($1, $2, $3, $4, 'p', 'u', 'image/png', 1)`,
        [bad.presaleId, bad.wallet, bad.format, bad.digest],
      ), { code: "23514" }, JSON.stringify(bad));
    }
  }));
