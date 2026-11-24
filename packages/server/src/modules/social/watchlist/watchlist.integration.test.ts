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
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { SOCIAL_WATCHLIST_LIMIT, type SocialWatchlistIds, type SocialWatchlistKeys, type SocialWatchlistPage } from "@blast/core/modules/social/contracts/watchlist.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { BLAST_V1_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { PRESALE_STORY_ACCOUNTS, seedPresaleStory, type PresaleStory } from "../../../../../core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialWatchlistRoutes } from "@blast/server/modules/social/watchlist/route.ts";

/**
 * UI-12 (OA-11): the watchlist routes over the design's sample sales. Writes
 * and reads run as the web role on the primary; every answer is private.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-watchlist-app";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.UTC(2026, 9, 3, 18);
const PRIVATE = "private, no-store";

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI = bearer("did:privy:presale-story-kai");
const LUCA = bearer("did:privy:presale-story-luca");
const STRANGER = bearer("did:privy:nobody-here");

type Send = (method: "GET" | "PUT" | "DELETE", path: string, token?: string) => Promise<Response>;
type Fixture = Readonly<{ admin: Pool; story: PresaleStory; send: Send }>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 5 });
  await admin.query(advanceWatermark(70_000, 0, "market"));
  await admin.query(`UPDATE watermarks SET timestamp_ms_hi_inclusive = ${NOW} WHERE pipeline IN ('market', 'presale')`);
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-watchlist-web");
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: "social-watchlist-pepper-0123456789abcdef" }),
      accounts: new PostgresSocialAccounts(() => web),
      primary: () => web,
    });
    const db = autocommitReader(web, "social");
    const routes = createSocialWatchlistRoutes({ kit, database: () => db, now: () => NOW });
    const send: Send = (method, path, token) => {
      const request = new Request(`${ORIGIN}${path}`, {
        method,
        headers: { "x-forwarded-for": "203.0.113.21", ...(token ? { authorization: token } : {}) },
      });
      if (path.startsWith("/api/social/me/watchlist/ids")) return routes.ids.GET(request, testClient());
      if (path.startsWith("/api/social/me/watchlist/keys")) return routes.keys.GET(request, testClient());
      if (path === "/api/social/me/watchlist" || path.startsWith("/api/social/me/watchlist?")) return routes.list.GET(request, testClient());
      return method === "PUT" ? routes.item.PUT(request, testClient()) : routes.item.DELETE(request, testClient());
    };
    await run({ admin, story, send });
  } finally {
    await Promise.all([admin.end(), web.end()]);
    await database.drop();
  }
}

async function ok<T>(response: Response, schema: "watchlist-page" | "watchlist-ids-response" | "watchlist-keys-response"): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as T;
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
}

const item = (id: string) => `/api/social/me/watchlist/${id}`;

test("UI-12 (OA-11): star and unstar idempotently; ids and keyset pages, newest first; private", { skip }, () =>
  withFixture(async ({ admin, story, send }) => {
    const { MRDN, SABL, KSTL } = story.presaleIds;
    for (const id of [MRDN, SABL, KSTL]) {
      const response = await send("PUT", item(id!), KAI);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("cache-control"), PRIVATE);
    }
    // Starring again keeps the star (and its time).
    const before = await admin.query("SELECT created_at FROM social_watchlist WHERE presale_id = $1", [MRDN]);
    assert.equal((await send("PUT", item(MRDN!), KAI)).status, 204);
    assert.deepEqual((await admin.query("SELECT created_at FROM social_watchlist WHERE presale_id = $1", [MRDN])).rows, before.rows);

    const ids = await ok<SocialWatchlistIds>(await send("GET", "/api/social/me/watchlist/ids", KAI), "watchlist-ids-response");
    assert.deepEqual(ids.presale_ids, [KSTL, SABL, MRDN]);
    // Luca's list is his own.
    assert.deepEqual((await ok<SocialWatchlistIds>(await send("GET", "/api/social/me/watchlist/ids", LUCA), "watchlist-ids-response")).presale_ids, []);

    // Pages of two, then the rest: each with the presale's list summary and the total.
    const first = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?limit=2", KAI), "watchlist-page");
    assert.deepEqual(first.items.map((row) => [row.presale.name, row.presale.phase]), [["Kestrel", "trading"], ["Sable", "pending"]]);
    assert.equal(first.total, 3);
    assert.ok(first.next_cursor);
    assert.equal(first.items[0]!.presale.multiple, "4.2");
    const second = await ok<SocialWatchlistPage>(
      await send("GET", `/api/social/me/watchlist?limit=2&cursor=${first.next_cursor}`, KAI),
      "watchlist-page",
    );
    assert.deepEqual(second.items.map((row) => row.presale.name), ["Meridian"]);
    assert.equal(second.next_cursor, null);
    assert.ok(second.items[0]!.added_ms > 0);

    // Removing is idempotent; any well-formed id may be removed.
    assert.equal((await send("DELETE", item(SABL!), KAI)).status, 204);
    assert.equal((await send("DELETE", item(SABL!), KAI)).status, 204);
    assert.equal((await send("DELETE", item(`0x${"ab".repeat(32)}`), KAI)).status, 204);
    const after = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist", KAI), "watchlist-page");
    assert.deepEqual(after.items.map((row) => row.presale.name), ["Kestrel", "Meridian"]);
    assert.equal(after.total, 2);

    // Starring is not following (the bell): no follow row was written.
    assert.equal((await admin.query("SELECT 1 FROM social_follows WHERE follower_account_id = $1 AND target_id = $2", [PRESALE_STORY_ACCOUNTS.kai, KSTL])).rowCount, 0);
  }));

test("A curve coin and a tracked pool coin are saved by type and stay off the sales page", { skip }, () =>
  withFixture(async ({ admin, story, send }) => {
    const curve = `0x${"c7".repeat(32)}::curve::CURVE`;
    const tracked = BLAST_V1_COINS[0].coinType;
    await admin.query(`INSERT INTO blast_infra_fixture.vaults
      (vault_id,origin_kind,origin_id,meme_type,venue_type,venue,pool_id,quote_type,created_checkpoint,created_tx_slot)
      VALUES ($1,'launch',$1,$2,$3,'cetus',$1,$4,40000,0)`, [`0x${"c8".repeat(32)}`, curve, `0x${"f".repeat(64)}::cetus::Venue`, `0x${"2".padStart(64, "0")}::sui::SUI`]);
    const { MRDN } = story.presaleIds;
    for (const key of [MRDN!, curve, tracked]) assert.equal((await send("PUT", item(encodeURIComponent(key)), KAI)).status, 204);
    assert.equal((await send("PUT", item(encodeURIComponent(curve)), KAI)).status, 204);
    const keys = await ok<SocialWatchlistKeys>(await send("GET", "/api/social/me/watchlist/keys", KAI), "watchlist-keys-response");
    assert.deepEqual(keys.keys, [tracked, curve, MRDN]);
    // The ids reply keeps its published shape: sales only.
    const ids = await ok<SocialWatchlistIds>(await send("GET", "/api/social/me/watchlist/ids", KAI), "watchlist-ids-response");
    assert.deepEqual(ids, { presale_ids: [MRDN] });
    const page = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist", KAI), "watchlist-page");
    assert.deepEqual([page.items.map((row) => row.presale.presale_id), page.total], [[MRDN], 1]);
    // With follows (the story: Kai follows Meridian and Cobalt) the curve coin is still not counted.
    const card = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows", KAI), "watchlist-page");
    assert.deepEqual([card.items.map((row) => row.presale.presale_id), card.total], [[MRDN, story.presaleIds.CBLT], 2]);
    // An untracked type with no launch vault is unknown; a malformed one is refused.
    await refused(await send("PUT", item(encodeURIComponent(`0x${"c9".repeat(32)}::curve::NONE`)), KAI), 404, "not_found");
    await refused(await send("PUT", item(encodeURIComponent("0x2::sui::SUI")), KAI), 400, "invalid_parameter");
    for (const key of [tracked, curve]) assert.equal((await send("DELETE", item(encodeURIComponent(key)), KAI)).status, 204);
    assert.deepEqual((await ok<SocialWatchlistKeys>(await send("GET", "/api/social/me/watchlist/keys", KAI), "watchlist-keys-response")).keys, [MRDN]);
  }));

test("UI-12: refusals: unknown or malformed presale, bad paging, visitors and callers without an account", { skip }, () =>
  withFixture(async ({ story, send }) => {
    await refused(await send("PUT", item(`0x${"cd".repeat(32)}`), KAI), 404, "not_found");
    await refused(await send("PUT", item("0xNOPE"), KAI), 400, "invalid_parameter");
    await refused(await send("DELETE", item("mrdn"), KAI), 400, "invalid_parameter");
    await refused(await send("GET", "/api/social/me/watchlist?limit=0", KAI), 400, "invalid_parameter");
    await refused(await send("GET", "/api/social/me/watchlist?limit=51", KAI), 400, "invalid_parameter");
    await refused(await send("GET", "/api/social/me/watchlist?cursor=nope", KAI), 400, "invalid_parameter");
    await refused(await send("PUT", item(story.presaleIds.MRDN!)), 401, "unauthorized");
    await refused(await send("GET", "/api/social/me/watchlist/ids"), 401, "unauthorized");
    await refused(await send("GET", "/api/social/me/watchlist/keys"), 401, "unauthorized");
    await refused(await send("PUT", item(story.presaleIds.MRDN!), STRANGER), 409, "account_required");
  }));

test("UI-12: the watchlist limit holds under concurrency; a star already there is kept at the limit", { skip }, () =>
  withFixture(async ({ admin, story, send }) => {
    // The fill holds one saved curve coin: the limit counts sales and curve coins together.
    const fill = SOCIAL_WATCHLIST_LIMIT - 2;
    await admin.query(
      `INSERT INTO social_watchlist (account_id, presale_id)
       SELECT $1, '0x' || lpad(to_hex(n), 64, '0') || CASE WHEN n = 1 THEN '::curve::CURVE' ELSE '' END
       FROM generate_series(1, $2::int) AS n`,
      [PRESALE_STORY_ACCOUNTS.kai, fill],
    );
    assert.equal((await send("PUT", item(story.presaleIds.CBLT!), KAI)).status, 204);
    // One slot left, two stars at once: exactly one lands.
    const [a, b] = await Promise.all([send("PUT", item(story.presaleIds.MRDN!), KAI), send("PUT", item(story.presaleIds.TIDE!), KAI)]);
    assert.deepEqual([a.status, b.status].sort(), [204, 422]);
    const loser = a.status === 422 ? a : b;
    await refused(loser, 422, "watchlist_limit");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_watchlist WHERE account_id = $1", [PRESALE_STORY_ACCOUNTS.kai])).rows[0].n, SOCIAL_WATCHLIST_LIMIT);
    // At the limit an existing star is still a success.
    assert.equal((await send("PUT", item(story.presaleIds.CBLT!), KAI)).status, 204);
    // The keys read stops at the limit too; the ids read leaves the curve coin out.
    const keys = await ok<SocialWatchlistKeys>(await send("GET", "/api/social/me/watchlist/keys", KAI), "watchlist-keys-response");
    assert.equal(keys.keys.length, SOCIAL_WATCHLIST_LIMIT);
    const ids = await ok<SocialWatchlistIds>(await send("GET", "/api/social/me/watchlist/ids", KAI), "watchlist-ids-response");
    assert.equal(ids.presale_ids.length, SOCIAL_WATCHLIST_LIMIT - 1);
    // Unlisted stars count in the total but are left out of a page; the curve coin is in neither.
    const page = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?limit=50", KAI), "watchlist-page");
    assert.equal(page.total, SOCIAL_WATCHLIST_LIMIT - 1);
    assert.ok(page.items.length >= 2 && page.items.length <= 50);
  }));

test("UI-12b (OA-17): include=follows lists the stars, then followed presales not starred, in keyset pages; the list filter stays stars only", { skip }, () =>
  withFixture(async ({ admin, story, send }) => {
    const { MRDN, SABL, CBLT } = story.presaleIds;
    // The story: Kai follows Meridian and Cobalt. Make their order certain: Cobalt is the newer follow.
    await admin.query(
      `UPDATE social_follows SET created_at = now() - CASE target_id WHEN $2 THEN interval '2 hours' ELSE interval '1 hour' END
       WHERE follower_account_id = $1 AND target_kind = 'presale'`,
      [PRESALE_STORY_ACCOUNTS.kai, MRDN],
    );
    for (const id of [MRDN, SABL]) assert.equal((await send("PUT", item(id!), KAI)).status, 204);
    const shown = (page: SocialWatchlistPage) => page.items.map((row) => [row.presale.name, row.starred, row.followed]);

    // The design's card: Sable and Meridian starred (newest first), then Cobalt followed; Meridian counted once.
    const card = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows", KAI), "watchlist-page");
    assert.deepEqual(shown(card), [["Sable", true, false], ["Meridian", true, true], ["Cobalt", false, true]]);
    assert.equal(card.total, 3);
    assert.equal(card.next_cursor, null);
    // The presale list's filter: the stars only (each still says whether it is followed).
    const stars = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist", KAI), "watchlist-page");
    assert.deepEqual(shown(stars), [["Sable", true, false], ["Meridian", true, true]]);
    assert.equal(stars.total, 2);

    // Keyset pages of one cross from the stars into the follows; of two, the second page starts the follows.
    const names: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const body: SocialWatchlistPage = await ok<SocialWatchlistPage>(
        await send("GET", `/api/social/me/watchlist?include=follows&limit=1${cursor ? `&cursor=${cursor}` : ""}`, KAI),
        "watchlist-page",
      );
      names.push(...body.items.map((row) => row.presale.name));
      assert.equal(body.total, 3);
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    assert.deepEqual(names, ["Sable", "Meridian", "Cobalt"]);
    const two = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows&limit=2", KAI), "watchlist-page");
    const rest = await ok<SocialWatchlistPage>(await send("GET", `/api/social/me/watchlist?include=follows&limit=2&cursor=${two.next_cursor}`, KAI), "watchlist-page");
    assert.deepEqual(shown(rest), [["Cobalt", false, true]]);
    assert.equal(rest.next_cursor, null);

    // After the last star the next page starts the follows; a followed presale's cursor belongs to include=follows reads.
    const lastStar = (await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows&limit=2", KAI), "watchlist-page")).next_cursor!;
    const intoFollows = await ok<SocialWatchlistPage>(await send("GET", `/api/social/me/watchlist?include=follows&limit=1&cursor=${lastStar}`, KAI), "watchlist-page");
    assert.deepEqual(shown(intoFollows), [["Cobalt", false, true]]);
    const meridianCursor = (await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows&limit=1", KAI), "watchlist-page")).next_cursor;
    const cobaltCursor = (await ok<SocialWatchlistPage>(
      await send("GET", `/api/social/me/watchlist?include=follows&limit=2&cursor=${meridianCursor}`, KAI),
      "watchlist-page",
    )).next_cursor;
    assert.equal(cobaltCursor, null);
    const followedCursor = Buffer.from(JSON.stringify([String(Date.now() * 1_000), CBLT, "f"])).toString("base64url");
    await refused(await send("GET", `/api/social/me/watchlist?cursor=${followedCursor}`, KAI), 400, "invalid_parameter");
    await refused(await send("GET", "/api/social/me/watchlist?include=stars", KAI), 400, "invalid_parameter");

    // Unstarring a followed presale keeps it in the card, among the follows (newest follow first).
    assert.equal((await send("DELETE", item(MRDN!), KAI)).status, 204);
    const unstarred = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows", KAI), "watchlist-page");
    assert.deepEqual(shown(unstarred), [["Sable", true, false], ["Cobalt", false, true], ["Meridian", false, true]]);
    assert.equal(unstarred.total, 3);
    // Unfollowing a presale not starred takes it out.
    await admin.query("DELETE FROM social_follows WHERE follower_account_id = $1 AND target_kind = 'presale' AND target_id = $2", [PRESALE_STORY_ACCOUNTS.kai, CBLT]);
    const unfollowed = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows", KAI), "watchlist-page");
    assert.deepEqual(shown(unfollowed), [["Sable", true, false], ["Meridian", false, true]]);
    assert.equal(unfollowed.total, 2);
    // Luca follows nothing and starred nothing: an empty card with its total.
    const empty = await ok<SocialWatchlistPage>(await send("GET", "/api/social/me/watchlist?include=follows", LUCA), "watchlist-page");
    assert.deepEqual([empty.items, empty.total, empty.next_cursor], [[], 0, null]);
  }));
