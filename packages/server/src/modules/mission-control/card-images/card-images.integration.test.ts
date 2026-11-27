import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { LRUCache } from "lru-cache";

import type { Pool } from "pg";

import { createSeasonZeroCardRecord, renderSeasonZeroCardPng, type SeasonZeroCardRecord } from "@blast/server/modules/mission-control/card-renderer/index.ts";
import { makeSeasonZeroCardFixtures } from "../../../../test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
import { createPool, createRuntimePool, type PoolSettings } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { recordStatements } from "../../../../../core/test/fixtures/modules/database/testing.ts";
import { isCardPublished, publishedCardSnapshot } from "@blast/server/modules/mission-control/card-images/published-card.ts";
import {
  cardImageIdentity,
  cardImagePathname,
  CardImageService,
  FilesystemCardImageStore,
  PostgresCardImageCatalog,
  PUBLIC_CARD_IMAGE_CACHE_CONTROL,
  publicCardImageResponse,
  renderCardImageWithSharp,
  type CardImage,
  type CardImageFormat,
} from "@blast/server/modules/mission-control/card-images/index.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const NOW = new Date("2026-09-25T12:00:00.000Z");

/** The runtime defaults: nothing here waits on a lock or holds a transaction open. */
const INSTANCE_SETTINGS: PoolSettings = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 15_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 3_000,
  max: 5,
  statementTimeoutMs: 8_000,
};

interface Render {
  readonly instance: number;
  readonly key: string;
}

interface Harness {
  admin: Pool;
  directory: string;
  instance(): CardImageService;
  /** Each instance's pool, in creation order. */
  pools: Pool[];
  /** Every render, tagged with the instance that ran it. */
  renders: Render[];
}

async function withHarness(t: TestContext, run: (harness: Harness) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  t.mock.method(console, "info", () => {});
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const directory = await mkdtemp(join(tmpdir(), "card-images-db-"));
  const pools: Pool[] = [];
  const renders: Render[] = [];
  try {
    await run({
      admin,
      directory,
      instance() {
        // A separate pool, cache, and single-flight map: one Fluid instance.
        const instance = pools.length;
        const pool = createRuntimePool(urlAs(database.url, "blast_web"), INSTANCE_SETTINGS);
        pools.push(pool);
        return new CardImageService({
          memoryCacheBytes: 64 * 1024 * 1024,
          persistence: {
            catalog: new PostgresCardImageCatalog(pool),
            store: new FilesystemCardImageStore(directory),
          },
          render: async (record, format) => {
            renders.push({ instance, key: `${record.cardId}/${format}` });
            return renderCardImageWithSharp(record, format);
          },
        });
      },
      pools,
      renders,
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.end();
    await database.drop();
    await rm(directory, { force: true, recursive: true });
  }
}

// Past the Zero Fleet range, so memberships need no Zero Fleet title.
let crewNumber = 1_000;

async function insertCard(pool: Pool, callsign: string): Promise<SeasonZeroCardRecord> {
  crewNumber += 1;
  const profileId = randomUUID();
  const membershipId = randomUUID();
  const cardId = randomUUID();
  const byte = crewNumber.toString(16).padStart(2, "0").slice(-2);
  await pool.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, x_handle, x_display_name,
       x_avatar_reference, sui_address, provider_wallet_reference,
       callsign, display_name, avatar_reference, disclosure_version,
       disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, NULL, NULL, 'v1', $9)`,
    [
      profileId,
      `did:privy:${profileId}`,
      `x-${profileId}`,
      `x_${callsign}`,
      `X ${callsign}`,
      `0x${byte.repeat(32)}`,
      `privy:embedded-${profileId}`,
      callsign,
      NOW,
    ],
  );
  await pool.query(
    `INSERT INTO mission_control_season_memberships (
       membership_id, allocation_id, card_id, season_id, profile_id,
       crew_number, fleet, foundry_launch_method, owner_title,
       zero_fleet, gold, created_at
     ) VALUES ($1, $2, $3, 'season-zero', $4, $5, 'Recon', NULL, 'Recon Fleet', FALSE, FALSE, $6)`,
    [membershipId, randomUUID(), cardId, profileId, crewNumber, NOW],
  );
  const [fixture] = await makeSeasonZeroCardFixtures();
  const record = createSeasonZeroCardRecord({
    avatar: fixture.record.avatar,
    callsign,
    cardId,
    crew: crewNumber,
    title: "Telemetry",
  });
  await pool.query(
    `INSERT INTO mission_control_cards (
       card_id, profile_id, membership_id, record_schema, record_version,
       card_record, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [cardId, profileId, membershipId, record.schema, record.version, JSON.stringify(record), NOW],
  );
  return record;
}

/** The record as routes see it: read back from JSONB, so key order is not preserved. */
async function storedRecord(pool: Pool, cardId: string): Promise<unknown> {
  const result = await pool.query<{ card_record: unknown }>(
    "SELECT card_record FROM mission_control_cards WHERE card_id = $1",
    [cardId],
  );
  return result.rows[0]?.card_record;
}

async function catalogRows(pool: Pool, cardId: string) {
  const result = await pool.query<{
    byte_size: number;
    content_type: string;
    format: CardImageFormat;
    pathname: string;
    record_digest: string;
    url: string;
  }>(
    `SELECT format, record_digest, pathname, url, content_type, byte_size
     FROM mission_control_card_images WHERE card_id = $1 ORDER BY format`,
    [cardId],
  );
  return result.rows;
}

function sourcesOf(images: readonly CardImage[]): string[] {
  return [...new Set(images.map((image) => image.source))].sort();
}

/** How many times each instance rendered `key`. */
function renderCounts(renders: readonly Render[], key: string): number[] {
  const counts = new Map<number, number>();
  for (const render of renders) {
    if (render.key === key) counts.set(render.instance, (counts.get(render.instance) ?? 0) + 1);
  }
  return [...counts.values()];
}

test(
  "two instances sharing one database and directory render a card at most once each and persist it once",
  { skip },
  async (t) => withHarness(t, async ({ admin, directory, instance, renders }) => {
    const record = await insertCard(admin, "pilot_one");
    const stored = await storedRecord(admin, record.cardId);
    const first = instance();
    const second = instance();

    const images = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      (index % 2 === 0 ? first : second).image({ format: "share", record: stored })));
    const shareKey = `${record.cardId}/share`;
    const shareCounts = renderCounts(renders, shareKey);
    assert.ok(shareCounts.length >= 1 && shareCounts.every((count) => count === 1), `renders per instance: ${shareCounts}`);
    t.diagnostic(`share renders: ${shareCounts.length} instance(s), one each`);

    const direct = await renderSeasonZeroCardPng(record, {}, "share");
    for (const image of images) assert.deepEqual(image.bytes, direct.bytes);
    // Every request on an instance shares that instance's one load.
    for (const fromInstance of [
      images.filter((_, index) => index % 2 === 0),
      images.filter((_, index) => index % 2 === 1),
    ]) {
      assert.equal(sourcesOf(fromInstance).length, 1);
    }

    const { digest } = cardImageIdentity(stored, { recruitHandles: [], recruitTotal: 0 });
    const pathname = cardImagePathname({ cardId: record.cardId, digest, format: "share" });
    assert.deepEqual(await catalogRows(admin, record.cardId), [{
      byte_size: direct.bytes.byteLength,
      content_type: "image/png",
      format: "share",
      pathname,
      record_digest: digest,
      url: pathToFileURL(join(directory, pathname)).href,
    }]);
    assert.deepEqual(await readdir(join(directory, `mission-control/cards/${record.cardId}`)), [
      `share-${digest}.png`,
    ]);
    assert.deepEqual(await readFile(join(directory, pathname)), direct.bytes);

    // The other format is its own render, again at most once per instance.
    const cards = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      (index % 2 === 0 ? second : first).image({ format: "card", record: stored })));
    const cardCounts = renderCounts(renders, `${record.cardId}/card`);
    assert.ok(cardCounts.length >= 1 && cardCounts.every((count) => count === 1), `renders per instance: ${cardCounts}`);
    const directCard = await renderSeasonZeroCardPng(record, {}, "card");
    for (const image of cards) assert.deepEqual(image.bytes, directCard.bytes);
    assert.deepEqual((await catalogRows(admin, record.cardId)).map((row) => row.format), ["card", "share"]);

    // Later requests never render again: memory on these instances, the store on a new one.
    const rendered = renders.length;
    assert.equal((await first.image({ format: "share", record: stored })).source, "memory");
    const third = instance();
    const again = await third.image({ format: "share", record: stored });
    assert.equal(again.source, "store");
    assert.deepEqual(again.bytes, direct.bytes);
    assert.equal(renders.length, rendered);
  }),
);

test(
  "the public image route 404s unpublished cards and serves published ones without rendering again",
  { skip },
  async (t) => withHarness(t, async ({ admin, instance, renders }) => {
    const record = await insertCard(admin, "pilot_two");
    const images = instance();
    const dependencies = {
      images,
      published: new LRUCache<string, string>({ max: 100 }),
      isPublished: (cardId: string) => isCardPublished(cardId, admin),
      publishedCard: (cardId: string) => publishedCardSnapshot(cardId, admin),
    };

    const hidden = await publicCardImageResponse(record.cardId, dependencies);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.headers.get("cache-control"), "no-store");
    const unknown = await publicCardImageResponse(randomUUID(), dependencies);
    assert.equal(unknown.status, 404);
    assert.deepEqual(renders, []);

    // The owner previews the share image before publishing: persisted, not public.
    const preview = await images.image({ format: "share", record: await storedRecord(admin, record.cardId) });
    assert.equal(preview.source, "render");
    assert.equal((await publicCardImageResponse(record.cardId, dependencies)).status, 404);

    await admin.query("UPDATE mission_control_cards SET published_at = $2 WHERE card_id = $1", [record.cardId, NOW]);
    const response = await publicCardImageResponse(record.cardId, {
      ...dependencies,
      images: instance(),
    }, "share", 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), PUBLIC_CARD_IMAGE_CACHE_CONTROL);
    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, preview.bytes);
    assert.equal(response.headers.get("content-length"), String(body.byteLength));
    assert.equal(renders.length, 1);
  }),
);

test(
  "a catalogued image whose object went missing is rendered and written again",
  { skip },
  async (t) => withHarness(t, async ({ admin, directory, instance, renders }) => {
    const record = await insertCard(admin, "pilot_four");
    const stored = await storedRecord(admin, record.cardId);
    const first = await instance().image({ format: "share", record: stored });
    const [row] = await catalogRows(admin, record.cardId);
    assert.ok(row);
    await rm(join(directory, row.pathname));

    const healed = await instance().image({ format: "share", record: stored });
    assert.equal(healed.source, "render");
    assert.deepEqual(healed.bytes, first.bytes);
    assert.deepEqual(await readFile(join(directory, row.pathname)), first.bytes);
    assert.equal((await catalogRows(admin, record.cardId)).length, 1);
    assert.equal((await instance().image({ format: "share", record: stored })).source, "store");
    assert.equal(renders.length, 2);
  }),
);

test(
  "a cached full card is served only while the account is active",
  { skip },
  async (t) => withHarness(t, async ({ admin, instance, pools, renders }) => {
    const record = await insertCard(admin, "pilot_five");
    const later = await insertCard(admin, "pilot_six");
    await admin.query("UPDATE mission_control_cards SET published_at = $2 WHERE card_id = $1", [record.cardId, NOW]);

    const images = instance();
    // Every transaction checks out one connection, so connects count database round trips.
    const lookups = t.mock.method(admin, "connect");
    const catalog = t.mock.method(pools.at(-1)!, "connect");
    const catalogStatements = recordStatements(pools.at(-1)!);
    const dependencies = {
      images,
      published: new LRUCache<string, string>({ max: 100 }),
      isPublished: (cardId: string) => isCardPublished(cardId, admin),
      publishedCard: (cardId: string) => publishedCardSnapshot(cardId, admin),
    };

    const first = await publicCardImageResponse(record.cardId, dependencies, "card");
    assert.equal(first.status, 200);
    const bytes = Buffer.from(await first.arrayBuffer());
    assert.equal(lookups.mock.callCount(), 1);
    assert.equal(catalog.mock.callCount(), 2, "catalog lookup, then the new row");
    assert.deepEqual(
      catalogStatements.map((text) => text.trim().split(/\s+/, 1)[0]),
      ["SELECT", "INSERT"],
      "one statement each, without BEGIN or COMMIT",
    );

    for (let request = 0; request < 3; request += 1) {
      const cached = await publicCardImageResponse(record.cardId, dependencies, "card");
      assert.equal(cached.status, 200);
      assert.equal(cached.headers.get("cache-control"), PUBLIC_CARD_IMAGE_CACHE_CONTROL);
      assert.deepEqual(Buffer.from(await cached.arrayBuffer()), bytes);
    }
    assert.equal(lookups.mock.callCount(), 4, "one publication check per cached origin response");
    assert.equal(catalog.mock.callCount(), 2, "no catalog query");
    assert.equal(renders.length, 1);

    for (let request = 0; request < 3; request += 1) {
      assert.equal((await publicCardImageResponse(later.cardId, dependencies, "card")).status, 404);
    }
    assert.equal(lookups.mock.callCount(), 7, "an unpublished card is looked up every time");
    await admin.query("UPDATE mission_control_cards SET published_at = $2 WHERE card_id = $1", [later.cardId, NOW]);
    const beforePublishedLookup = lookups.mock.callCount();
    assert.equal((await publicCardImageResponse(later.cardId, dependencies, "card")).status, 200);
    assert.equal(lookups.mock.callCount(), beforePublishedLookup + 1, "and is served once published");
    await admin.query(
      `INSERT INTO social_accounts (account_id, profile_id, deleted_at, privacy)
       SELECT gen_random_uuid(), profile_id, now(), 'private' FROM mission_control_cards WHERE card_id = $1`,
      [record.cardId],
    );
    assert.equal((await publicCardImageResponse(record.cardId, dependencies, "card")).status, 404);
    assert.equal((await publicCardImageResponse(record.cardId, dependencies, "share", 0)).status, 404);
    assert.equal(dependencies.published.has(record.cardId), false);
  }),
);
