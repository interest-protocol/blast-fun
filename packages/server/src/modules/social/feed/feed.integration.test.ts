import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { SOCIAL_CONFIG_DEFAULTS, type SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import type { SocialFeedNewResponse, SocialFeedPage } from "@blast/core/modules/social/contracts/feed.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { FEED_STORY_ACCOUNTS, FEED_STORY_HIDDEN_TEXT, FEED_STORY_MARKUP, seedFeedStory, seedHiddenSales, type FeedStory } from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialFeedRoute } from "@blast/server/modules/social/feed/route.ts";

/**
 * Social-feed T-007: `GET /api/social/feed` (For You) over a disposable
 * database with the fixture `chain_read_v1` and the feed story
 * (`feed-story.ts`). Feed reads run as the replica role `blast_replica`; the
 * rate limiter writes as `blast_web`, as in production.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-feed-app";
const PEPPER = "social-feed-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.now();

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

type Fixture = Readonly<{
  admin: Pool;
  /** The test's own database. */
  url: string;
  story: FeedStory;
  replica: ReadableDatabase;
  /** GET the feed with `query` and optional headers. */
  get(query?: string, headers?: Record<string, string>): Promise<Response>;
  /** GET the "N new posts" count (`/api/social/feed/new`) with `query`. */
  fresh(query: string): Promise<Response>;
  /** The next read's tuning values come from the database again. */
  expireConfig(): void;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, filler = 0): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedFeedStory(admin, { nowMs: NOW, filler });
  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-feed-replica");
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-feed-web");
  try {
    assert.equal((await replicaPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const replica = autocommitReader(replicaPool, "social");
    let clock = 0;
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"), { now: () => clock });
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: {
        resolve() {
          throw new Error("the feed never resolves an account");
        },
        resolveWallet() {
          throw new Error("the feed never resolves an account");
        },
      },
      primary: () => {
        throw new Error("the feed never opens a primary transaction");
      },
    });
    const route = createSocialFeedRoute({ kit, database: () => replica, config: reader.getSocialConfig, now: () => NOW });
    await run({
      admin,
      url,
      story,
      replica,
      get: (query = "", headers = {}) =>
        route.GET(new Request(`${ORIGIN}/api/social/feed${query}`, { headers: { "x-forwarded-for": "203.0.113.7", ...headers } }), testClient("203.0.113.7")),
      fresh: (query) => route.NEW(new Request(`${ORIGIN}/api/social/feed/new${query}`, { headers: { "x-forwarded-for": "203.0.113.7" } }), testClient("203.0.113.7")),
      expireConfig: () => {
        clock += 60_000;
      },
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function page(response: Response): Promise<SocialFeedPage> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("feed-page", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "public, s-maxage=10, stale-while-revalidate=20");
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialFeedPage;
}

async function refused(response: Response, parameter: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string; parameter?: string } };
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error.code, "invalid_parameter");
  assert.equal(body.error.parameter, parameter);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

/** Every item of the feed, walking pages of `limit`. */
async function walk(get: Fixture["get"], limit: number): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const body = await page(await get(query));
    pages += 1;
    ids.push(...body.items.map((item) => item.entry_id));
    cursor = body.next_cursor;
    assert.ok(pages < 100);
  } while (cursor);
  return { ids, pages };
}

const VIEWER_KEYS = /"(viewer|me|my_[a-z_]+|reacted|following|followed|is_[a-z_]+|can_[a-z_]+)"\s*:/;

test("T-007-AC-1: For You is byte-identical for a visitor and a signed-in caller, publicly cached, with no viewer field", { skip }, async () => {
  await withFixture(async ({ get }) => {
    const visitorResponse = await get("?tab=for_you");
    const visitorText = await visitorResponse.clone().text();
    const visitor = await page(visitorResponse);
    const signedIn = await page(await get("?tab=for_you", { authorization: bearer(`did:privy:feed-story-kai`) }));
    const garbage = await page(await get("", { authorization: "Bearer not-a-token" }));
    assert.ok(visitor.items.length > 5);
    assert.equal(JSON.stringify(signedIn.items), JSON.stringify(visitor.items));
    assert.equal(JSON.stringify(garbage.items), JSON.stringify(visitor.items));
    assert.equal(signedIn.next_cursor, visitor.next_cursor);
    assert.deepEqual(Object.keys(visitor).sort(), ["as_of", "items", "next_cursor"]);
    assert.doesNotMatch(visitorText, VIEWER_KEYS);
    for (const item of visitor.items) assert.deepEqual(validator.validate("feed-item", item).errors, []);
  });
});

test("T-007-AC-2: boosted time ranks a 25-minute-old why above a 10-minute-old item; a why_boost_ms change reorders the next uncached read; ties by entry_id desc", { skip }, async () => {
  await withFixture(async ({ admin, story, get, expireConfig }) => {
    const ids = (await page(await get())).items.map((item) => item.entry_id);
    const at = (name: keyof FeedStory["ids"]) => ids.indexOf(story.ids[name]);
    assert.ok(at("kaiWhyCommit") >= 0 && at("novaPlainCommit") >= 0);
    assert.ok(at("kaiWhyCommit") < at("novaPlainCommit"), "the 25-minute-old item with a why ranks first");
    // Equal rank: the larger entry id (bytewise) first.
    assert.ok(story.ids.kaiTieHigh > story.ids.kaiTieLow);
    assert.equal(at("kaiTieLow"), at("kaiTieHigh") + 1);
    // The big unnamed commit, 45 minutes old with the 30-minute big boost, ranks as if 15 minutes old.
    assert.ok(at("anonBigOpen") > at("novaPlainCommit"));

    await admin.query(
      "INSERT INTO social_config (key, value, updated_by) VALUES ('why_boost_ms', '0'::jsonb, 'operator-1')",
    );
    // Within the config cache window the order holds; the next uncached read applies the change.
    assert.deepEqual((await page(await get())).items.map((item) => item.entry_id), ids);
    expireConfig();
    const after = (await page(await get())).items.map((item) => item.entry_id);
    assert.ok(after.indexOf(story.ids.kaiWhyCommit) > after.indexOf(story.ids.novaPlainCommit));
    assert.ok(after.indexOf(story.ids.kaiWhyCommit) > after.indexOf(story.ids.kaiTieLow));

    // A big_boost_ms of zero drops the big commit below the 25-minute-old items too.
    await admin.query("INSERT INTO social_config (key, value, updated_by) VALUES ('big_boost_ms', '0'::jsonb, 'operator-1')");
    expireConfig();
    const unboosted = (await page(await get())).items;
    for (let n = 1; n < unboosted.length; n += 1) {
      const [a, b] = [unboosted[n - 1]!, unboosted[n]!];
      assert.ok(a.occurred_at_ms > b.occurred_at_ms || (a.occurred_at_ms === b.occurred_at_ms && a.entry_id > b.entry_id), `${a.entry_id} before ${b.entry_id}`);
    }
  });
});

test("T-007-AC-3: the window, the naming rule and live or recently migrated presales decide the candidates", { skip }, async () => {
  await withFixture(async ({ story, get }) => {
    const items = (await page(await get("?limit=50"))).items;
    const ids = new Set(items.map((item) => item.entry_id));
    const present = [
      "kaiWhyCommit", "novaPlainCommit", "kaiTieLow", "kaiTieHigh", "novaNoUsdCommit", "novaRefundOnly", "kaiClaim", "kaiBuy",
      "malloryCommit", "anonBigOpen", "anonBigMigratedRecently", "openOpened", "fundedFunded", "migratedRecently", "milestone",
    ] as const;
    const absent = [
      "kaiTooOld", "anonSmallOpen", "ghostSmallCommit", "lateSmallCommit", "anonBigMigratedLongAgo", "anonBigCancelled",
      "migratedLongAgo", "cancelled",
    ] as const;
    for (const name of present) assert.ok(ids.has(story.ids[name]), `${name} is a candidate`);
    for (const name of absent) assert.ok(!ids.has(story.ids[name]), `${name} is not a candidate`);
    assert.equal(ids.size, present.length);
    // The big commit by an unowned wallet shows its address only; the default account's item shows her account.
    const anon = items.find((item) => item.entry_id === story.ids.anonBigOpen);
    assert.equal(anon?.actor?.type, "address");
    assert.equal(anon?.big, true);
    const nova = items.find((item) => item.entry_id === story.ids.novaPlainCommit);
    assert.deepEqual(nova?.actor && nova.actor.type === "account" ? nova.actor.callsign : null, "nova");
    assert.ok(FEED_STORY_ACCOUNTS.nova);
  });
});

test("T-007-AC-4: as_of is the slowest pipeline's watermark; 61 s of lag is reported, never an error", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await admin.query(advanceWatermark(41_000, 1_000, "presale"));
    await admin.query(advanceWatermark(40_500, 61_000, "market"));
    const body = await page(await get());
    assert.equal(body.as_of.checkpoint, 40_500);
    assert.ok(body.as_of.lag_ms >= 61_000 && body.as_of.lag_ms < 120_000, String(body.as_of.lag_ms));
    assert.ok(body.items.length > 0);
    await admin.query(advanceWatermark(39_000, 3_600_000, "presale"));
    const later = await page(await get());
    assert.equal(later.as_of.checkpoint, 39_000);
    assert.ok(later.as_of.lag_ms >= 3_600_000);
    assert.deepEqual(later.items.map((item) => item.entry_id), body.items.map((item) => item.entry_id));
    // With no readable watermark the freshness is unknown: 503, not stale data presented as fresh.
    await admin.query("DELETE FROM watermarks");
    const unknown = await get();
    assert.equal(unknown.status, 503);
    assert.equal(unknown.headers.get("cache-control"), "no-store");
    assert.ok(unknown.headers.get("retry-after"));
  });
});

test("T-007: paging walks every candidate exactly once in rank order; bad parameters are invalid_parameter", { skip }, async () => {
  await withFixture(async ({ get }) => {
    const all = (await walk(get, 50)).ids;
    assert.ok(all.length > 50, String(all.length));
    assert.equal(new Set(all).size, all.length);
    const first = await page(await get());
    assert.equal(first.items.length, 20);
    assert.ok(first.next_cursor);
    for (const limit of [1, 7, 20]) {
      const walked = await walk(get, limit);
      assert.deepEqual(walked.ids, all, `limit ${limit}`);
    }
    assert.ok((await walk(get, 20)).pages >= 3);

    await refused(await get("?tab=following"), "tab");
    await refused(await get("?tab=For_You"), "tab");
    await refused(await get("?tab="), "tab");
    await refused(await get("?tab=for_you&tab=for_you"), "tab");
    await refused(await get("?limit=0"), "limit");
    await refused(await get("?limit=51"), "limit");
    await refused(await get("?limit=abc"), "limit");
    await refused(await get("?cursor=nope"), "cursor");
    const [body, check] = first.next_cursor!.split(".");
    await refused(await get(`?cursor=${body}x.${check}`), "cursor");
    // Unknown parameters are ignored.
    assert.deepEqual((await page(await get("?utm_source=x"))).items.map((item) => item.entry_id), first.items.map((item) => item.entry_id));
  }, 40);
});

test("T-007-AC-7, AC-8: items carry the amounts, through counts and plain user text the card renders", { skip }, async () => {
  await withFixture(async ({ story, get }) => {
    const items = new Map((await page(await get("?limit=50"))).items.map((item) => [item.entry_id, item]));
    const why = items.get(story.ids.kaiWhyCommit)!;
    assert.equal(why.why?.text, `Team shipped on time twice. ${FEED_STORY_MARKUP}`);
    assert.deepEqual(why.through, { people: 2, volume_usd: "150.00" });
    // OA-5: the rocket is the only configured reaction; the story's stored fire rows are not shown.
    assert.deepEqual(why.reactions, { rocket: 1 });
    assert.deepEqual(items.get(story.ids.novaPlainCommit)!.through, { people: 0, volume_usd: "0.00" });
    const noUsd = items.get(story.ids.novaNoUsdCommit)!;
    assert.equal(noUsd.amounts?.usd, null);
    assert.equal(noUsd.amounts?.quote_symbol, "USDC");
    const claim = items.get(story.ids.kaiClaim)!;
    assert.equal(claim.amounts?.tokens, "250000000000");
    assert.equal(claim.amounts?.quote_refund, "5000000");
    assert.equal(claim.presale?.decimals, 9);
    const refund = items.get(story.ids.novaRefundOnly)!;
    assert.equal(refund.amounts?.tokens, "0");
    const mallory = items.get(story.ids.malloryCommit)!;
    assert.equal(mallory.actor?.type === "account" ? mallory.actor.display_name : null, FEED_STORY_MARKUP);
  });
});

test("T-007: the default config's values are what the route applies without any row", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    const { readForYouPage } = await import("@blast/server/modules/social/feed/feed-reader.ts");
    const config: SocialConfig = { ...SOCIAL_CONFIG_DEFAULTS, for_you_window_days: 1 };
    const body = await readForYouPage(replica, { config, nowMs: NOW, limit: 50, before: null, hiddenKinds: [] });
    // A one-day window drops the recently migrated presale's post (two days old).
    assert.ok(body.items.every((item) => item.occurred_at_ms >= NOW - 86_400_000));
  });
});

test("UI-02 scale: the bounded scan gives the same pages and new-items counts whatever its step size", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    const { forYouEntries, forYouNewEntries } = await import("@blast/server/modules/social/feed/for-you.ts");
    // A big boost so entries far back outrank recent ones and the stop rule is exercised.
    const config: SocialConfig = { ...SOCIAL_CONFIG_DEFAULTS, why_boost_ms: 6 * 3_600_000, big_boost_ms: 2 * 3_600_000 };
    const walk = async (scanBatch: number) => {
      const ids: string[] = [];
      let before = null;
      for (let page = 0; page < 20; page += 1) {
        const entries = await forYouEntries(replica, { config, nowMs: NOW, limit: 7, before, scanBatch, hiddenKinds: [] });
        ids.push(...entries.map((entry) => `${entry.entryId}@${entry.rankMs}`));
        if (entries.length < 7) break;
        before = { rankMs: entries.at(-1)!.rankMs, entryId: entries.at(-1)!.entryId };
      }
      return ids;
    };
    const reference = await walk(400);
    assert.ok(reference.length > 40, `${reference.length} candidates`);
    for (const step of [1, 3, 7, 50]) assert.deepEqual(await walk(step), reference, `step ${step}`);
    // Ranks are non-increasing and no entry repeats.
    const ranks = reference.map((id) => Number(id.split("@")[1]));
    assert.ok(ranks.every((rank, n) => n === 0 || rank <= ranks[n - 1]!));
    assert.equal(new Set(reference).size, reference.length);
    for (const sinceMs of [0, NOW - 3_600_000, NOW - 4 * 3_600_000]) {
      const expected = await forYouNewEntries(replica, { config, nowMs: NOW, sinceMs, max: 50, actors: 3, hiddenKinds: [] });
      for (const step of [1, 4, 25]) {
        assert.deepEqual(await forYouNewEntries(replica, { config, nowMs: NOW, sinceMs, max: 50, actors: 3, scanBatch: step, hiddenKinds: [] }), expected, `since ${sinceMs} step ${step}`);
      }
    }
  }, 60);
});

/**
 * T-043 hidden sales (`seedHiddenSales`): blast-infra leaves its excluded test
 * sales out of every presale view but not out of `chain_read_v1.activity`,
 * and a sale with no coin metadata is in `presales` but not shown. Kai and
 * Nova (both named) commit, claim and trade on them, newer than every story
 * item, so a read that keeps one shows it on the first page. The route here
 * shows trades (no hidden kinds), so the excluded coin's trades are in play.
 */
test("T-043 hidden sales: no commit, claim, trade or post of a hidden sale reaches For You or its new count, and every page is the one without them", { skip }, async () => {
  await withFixture(async ({ admin, get, fresh }) => {
    const walks = async () => Promise.all([1, 7, 20, 50].map(async (limit) => (await walk(get, limit)).ids));
    const count = async () => {
      const response = await fresh(`?since=${NOW - 11 * 60_000}`);
      const body = (await response.json()) as SocialFeedNewResponse;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(validator.validate("feed-new-response", body).errors, []);
      return { count: body.count, more: body.more, actors: body.actors };
    };
    const before = await walks();
    const newBefore = await count();
    // Only Nova's 10-minute-old commit is newer than 11 minutes.
    assert.equal(newBefore.count, 1);

    const hidden = await seedHiddenSales(admin, { nowMs: NOW });
    const after = await walks();
    for (const [n, ids] of after.entries()) {
      assert.deepEqual(ids, before[n], `the walk at every limit is the one without the hidden sales (${[1, 7, 20, 50][n]})`);
      for (const id of Object.values(hidden.ids)) assert.ok(!ids.includes(id), id);
    }
    const first = await page(await get("?limit=50"));
    assert.doesNotMatch(JSON.stringify(first), FEED_STORY_HIDDEN_TEXT);
    assert.ok(first.items.every((item) => item.presale !== null), "every item has its sale's chip");
    assert.deepEqual(await count(), newBefore);
  });
});

test("Admin pins lead Home once per sale, page without repeats, persist, and unpin to normal ranking", { skip }, async () => {
  await withFixture(async ({ admin, url, replica, get, story }) => {
    const { createAdminPresaleRoute } = await import("@blast/server/modules/social/admin-presales/route.ts");
    const { FEED_STORY_PRESALES } = await import("../../../../../core/test/fixtures/modules/social/feed/feed-story.ts");
    const social = createPool(urlAs(url, "blast_web"), { max: 2 });
    const route = createAdminPresaleRoute(() => social, () => NOW);
    const change = (id: string, pinned: boolean) => route(new Request(`${ORIGIN}/api/admin/presales`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presale_id: id, pinned }),
    }));
    try {
      const baseline = (await page(await get("?limit=50"))).items.map((item) => item.entry_id);
      assert.equal((await change(`0x${"f".repeat(64)}`, true)).status, 404);
      assert.equal((await change(FEED_STORY_PRESALES.open, true)).status, 200);
      assert.equal((await change(FEED_STORY_PRESALES.open, true)).status, 200, "pin is idempotent");
      // Saved terminal pins stay stored but cannot lead Home.
      assert.equal((await change(FEED_STORY_PRESALES.migratedLongAgo, true)).status, 404);
      await admin.query("INSERT INTO social_presale_pins (presale_id) VALUES ($1)", [FEED_STORY_PRESALES.migratedLongAgo]);
      const top = await page(await get("?limit=1"));
      assert.equal(top.items[0]?.entry_id, story.ids.novaPlainCommit);
      assert.equal(top.items[0]?.pinned, true);
      assert.ok(top.next_cursor);
      const second = await page(await get(`?limit=1&cursor=${top.next_cursor}`));
      assert.notEqual(second.items[0]?.pinned, true);
      const collected = [...top.items, ...second.items];
      let cursor = second.next_cursor;
      while (cursor) {
        const next = await page(await get(`?limit=7&cursor=${cursor}`));
        collected.push(...next.items);
        cursor = next.next_cursor;
        assert.ok(collected.length < 100, "pagination terminates");
      }
      assert.equal(new Set(collected.map((item) => item.entry_id)).size, collected.length);
      assert.equal(collected.filter((item) => item.pinned).length, 1);
      const listing = await route(new Request(`${ORIGIN}/api/admin/presales?id=${FEED_STORY_PRESALES.open}`));
      assert.equal(listing.status, 200);
      assert.equal((await listing.json()).presales[0].pinned, true);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_presale_pins")).rows[0].n, 2);
      await admin.query("UPDATE blast_infra_fixture.presales SET end_ms = $1 WHERE presale_id = $2", [NOW, FEED_STORY_PRESALES.open]);
      const ended = await page(await get("?limit=50"));
      assert.equal(ended.items.some((item) => item.pinned), false, "pin expires at the exact deadline even while lifecycle is open");
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_presale_pins")).rows[0].n, 2, "expiry does not delete saved pins");
      assert.equal((await change(FEED_STORY_PRESALES.open, false)).status, 200);
      assert.equal((await change(FEED_STORY_PRESALES.migratedLongAgo, false)).status, 200);
      assert.deepEqual((await page(await get("?limit=50"))).items.map((item) => item.entry_id), baseline);
      await assert.rejects(replica.read("DELETE FROM social_presale_pins"), /read|SELECT|statement/i);
    } finally { await social.end(); }
  });
});


test("shared count head preserves real PostgreSQL selection and actor parity across since, hidden kinds and tuning", { skip }, async () => {
  await withFixture(async ({ replica }) => {
    const { forYouNewEntries, forYouNewEntriesFromHead, forYouNewHead } = await import("@blast/server/modules/social/feed/for-you.ts");
    const { createForYouNewReader, readForYouNew } = await import("@blast/server/modules/social/feed/feed-reader.ts");
    for (const config of [SOCIAL_CONFIG_DEFAULTS, { ...SOCIAL_CONFIG_DEFAULTS, for_you_window_days: 1, for_you_migrated_days: 1, big_commit_usd: "5000", big_trade_usd: "5000" }]) {
      for (const hiddenKinds of [[], ["trade_buy", "trade_sell"]]) {
        const head = await forYouNewHead(replica, { config, nowMs: NOW, max: 50, hiddenKinds, scanBatch: 7 });
        assert.ok(head.entries.length <= 51);
        const reader = createForYouNewReader(() => replica, () => NOW);
        const sinceValues = [0, NOW, NOW - 11 * 60_000, NOW - 3_600_000, ...head.entries.slice(0, 3).map((entry) => entry.occurredAtMs)];
        const shared = await Promise.all(sinceValues.map((sinceMs) => reader({ config, sinceMs, hiddenKinds })));
        for (const [index, sinceMs] of sinceValues.entries()) {
          const direct = await forYouNewEntries(replica, { config, nowMs: NOW, sinceMs, max: 50, actors: 3, hiddenKinds, scanBatch: 3 });
          assert.deepEqual(forYouNewEntriesFromHead(head, sinceMs, 3), direct);
          const original = await readForYouNew(replica, { config, nowMs: NOW, sinceMs, hiddenKinds });
          assert.deepEqual({ count: shared[index]!.count, more: shared[index]!.more, actors: shared[index]!.actors }, { count: original.count, more: original.more, actors: original.actors });
          assert.equal(shared[index]!.as_of.checkpoint, original.as_of.checkpoint);
          assert.equal(shared[index]!.as_of.timestamp_ms, original.as_of.timestamp_ms);
        }
      }
    }
  }, 60);
});
