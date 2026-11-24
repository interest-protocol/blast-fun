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
import type { SocialProfile, SocialProfileItemsPage } from "@blast/core/modules/social/contracts/profiles.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { FEED_STORY_ACCOUNTS, FEED_STORY_MARKUP, FEED_STORY_WALLETS, seedFeedStory, type FeedStory } from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { readAsOf } from "@blast/server/modules/social/items/index.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialProfileRoutes } from "@blast/server/modules/social/profiles/route.ts";

/**
 * Social-feed T-018: `GET /api/social/profiles/{callsign}` and
 * `GET /api/social/profiles/{callsign}/items` over a disposable database
 * with the fixture `chain_read_v1` and the feed story (`feed-story.ts`):
 * Kai and Nova share, Ghost is private, Late never onboarded (not sharing),
 * and Orbit is a Mission Control member who owns the story's otherwise
 * unowned wallet. Every read runs as the replica role `blast_replica`; the
 * account resolver throws if touched; the kit's primary (blast_web) is reached only by an unknown callsign (UI-06's lazy member row). The rate limiter
 * writes as `blast_web`, as in production.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-profile-app";
const PEPPER = "social-profile-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 86_400_000;
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=20";
const ORBIT_ACCOUNT = "00000000-0000-4000-8000-000000000799";
const ORBIT_PROFILE = "00000000-0000-4000-8000-000000000899";

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
  story: FeedStory;
  replica: ReadableDatabase;
  /** GET `path` below `/api/social/profiles/` with optional headers. */
  profile(path: string, headers?: Record<string, string>): Promise<Response>;
  items(path: string, headers?: Record<string, string>): Promise<Response>;
}>;

/** Orbit: a Mission Control member (identity from the profile) owning the story's unowned wallet since 60 days. */
async function seedMember(admin: Pool): Promise<void> {
  const since = new Date(NOW - 60 * DAY).toISOString();
  await admin.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, x_handle, x_avatar_reference, sui_address, provider_wallet_reference, callsign,
       display_name, avatar_reference, disclosure_version, disclosure_accepted_at
     ) VALUES ($1, 'did:privy:orbit', 'x-orbit', 'orbit_x', 'https://pbs.twimg.com/orbit.png', $2, 'wallet-orbit', 'orbit',
       'Orbit', 'https://cdn.blast.fun/avatars/orbit.png', 'fixture-v1', now())`,
    [ORBIT_PROFILE, `0x${"0b17".padStart(64, "0")}`],
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, profile_id, privacy, sharing_since, onboarded_at) VALUES ($1, $2, 'public', $3, $3)`,
    [ORBIT_ACCOUNT, ORBIT_PROFILE, since],
  );
  await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [
    FEED_STORY_WALLETS.anon, ORBIT_ACCOUNT, since,
  ]);
}

async function withFixture(run: (fixture: Fixture) => Promise<void>, filler = 0): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedFeedStory(admin, { nowMs: NOW, filler });
  await seedMember(admin);
  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-profile-replica");
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-profile-web");
  try {
    assert.equal((await replicaPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const replica = autocommitReader(replicaPool, "social");
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"));
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
          throw new Error("a profile never resolves the caller's account");
        },
        resolveWallet() {
          throw new Error("a profile never resolves the caller's account");
        },
      },
      // UI-06: only an unknown callsign reaches the primary (a member's lazy account row).
      primary: () => webPool,
    });
    const routes = createSocialProfileRoutes({ kit, primary: () => autocommitReader(webPool, "social"), database: () => replica, config: reader.getSocialConfig, now: () => NOW });
    const request = (path: string, headers: Record<string, string>) =>
      new Request(`${ORIGIN}/api/social/profiles/${path}`, { headers: { "x-forwarded-for": "203.0.113.9", ...headers } });
    await run({
      admin,
      story,
      replica,
      profile: (path, headers = {}) => routes.profile.GET(request(path, headers), testClient()),
      items: (path, headers = {}) => routes.items.GET(request(path, headers), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function ok<T>(response: Response, schema: "profile-response" | "profile-items-page"): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), PUBLIC_CACHE);
  assert.ok(response.headers.get("x-request-id"));
  return body as T;
}

async function refused(response: Response, status: number, code: string, parameter?: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string; parameter?: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.equal(body.error.parameter, parameter);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

/** A response text with `as_of.lag_ms` blanked. */
const withoutLag = (text: string) => text.replace(/"lag_ms":[0-9]+/, '"lag_ms":0');

const ids = (page: SocialProfileItemsPage) => page.items.map((item) => item.entry_id);

/** Keep paths so only public fields at their expected locations can be exempted. */
function keyPaths(value: unknown, prefix = "", paths: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) keyPaths(entry, prefix, paths);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);
      keyPaths(entry, path, paths);
    }
  }
  return paths;
}

const PORTFOLIO_KEY = /balance|position|coin|vesting|total|portfolio|holding|attribution|wallet/i;
const VIEWER_KEY = /^(viewer|me|my_.*|reacted|following|followed|is_.*|can_.*)$/;

test("T-018-AC-1 (AC-107): identity and private for a visitor and a signed-in caller alike; members and new accounts; unknown is 404", { skip }, async () => {
  await withFixture(async ({ profile, items }) => {
    const visitorResponse = await profile("kai");
    const visitorText = await visitorResponse.clone().text();
    const kai = await ok<SocialProfile>(visitorResponse, "profile-response");
    assert.deepEqual({ ...kai, as_of: null }, {
      callsign: "kai", display_name: "Kai", avatar_url: null, x_handle: "kai_x", verified: true, private: false,
      portfolio_public: false, as_of: null,
    });
    for (const authorization of [bearer("did:privy:feed-story-nova"), bearer("did:privy:feed-story-kai"), "Bearer not-a-token"]) {
      const signedIn = await profile("kai", { authorization });
      // Byte for byte, apart from the watermark's age, which grows between reads.
      assert.equal(withoutLag(await signedIn.clone().text()), withoutLag(visitorText));
      await ok(signedIn, "profile-response");
    }

    assert.equal((await ok<SocialProfile>(await profile("ghost"), "profile-response")).private, true);
    // Never onboarded: public by default, sharing nothing yet.
    assert.equal((await ok<SocialProfile>(await profile("late_one"), "profile-response")).private, false);
    // A member's identity is its Mission Control profile's.
    const orbit = await ok<SocialProfile>(await profile("orbit"), "profile-response");
    assert.deepEqual({ ...orbit, as_of: null }, {
      callsign: "orbit", display_name: "Orbit", avatar_url: "https://cdn.blast.fun/avatars/orbit.png", x_handle: "orbit_x",
      verified: true, private: false, portfolio_public: false, as_of: null,
    });
    // User text is returned as stored.
    assert.equal((await ok<SocialProfile>(await profile("mallory"), "profile-response")).display_name, FEED_STORY_MARKUP);

    await refused(await profile("nobody"), 404, "not_found");
    for (const bad of ["Kai", "k", "kai%2Fnova", "kai/nova", "%E0%A4%A", "", "kai%20", `0x${"a".repeat(64)}`]) {
      await refused(await profile(bad), 400, "invalid_parameter", "callsign");
    }
    await refused(await items("nobody/items"), 404, "not_found");
    for (const bad of ["Kai/items", "k/items", "kai%2Fnova/items", "kai/x/items", "%E0%A4%A/items", "/items", "kai/items/x", "kai/itemsx"]) {
      await refused(await items(bad), 400, "invalid_parameter", "callsign");
    }
  });
});

test("T-018-AC-2 (AC-108): only named items, newest first; none before sharing began, none for a private or unshared account", { skip }, async () => {
  await withFixture(async ({ admin, story, items }) => {
    const kai = await ok<SocialProfileItemsPage>(await items("kai/items"), "profile-items-page");
    assert.deepEqual(ids(kai), [
      story.ids.kaiTieHigh, story.ids.kaiTieLow, story.ids.kaiWhyCommit, story.ids.kaiClaim, story.ids.kaiBuy, story.ids.kaiTooOld,
    ]);
    assert.equal(kai.next_cursor, null);
    for (const item of kai.items) {
      assert.equal(item.actor?.type, "account");
      assert.equal(item.actor?.type === "account" ? item.actor.callsign : null, "kai");
    }
    // Each item carries its why.
    const why = kai.items.find((item) => item.entry_id === story.ids.kaiWhyCommit);
    assert.equal(why?.why?.text, `Team shipped on time twice. ${FEED_STORY_MARKUP}`);

    // A member's items through its wallet: the story's otherwise unnamed wallet, named for Orbit.
    const orbit = await ok<SocialProfileItemsPage>(await items("orbit/items"), "profile-items-page");
    assert.deepEqual(new Set(ids(orbit)), new Set([
      story.ids.anonSmallOpen, story.ids.anonBigOpen, story.ids.anonBigMigratedRecently, story.ids.anonBigMigratedLongAgo,
      story.ids.anonBigCancelled,
    ]));
    for (let n = 1; n < orbit.items.length; n += 1) assert.ok(orbit.items[n - 1]!.occurred_at_ms >= orbit.items[n]!.occurred_at_ms);

    // Private and never-onboarded accounts have items in the chain, but none are named.
    assert.deepEqual((await ok<SocialProfileItemsPage>(await items("ghost/items"), "profile-items-page")).items, []);
    assert.deepEqual((await ok<SocialProfileItemsPage>(await items("late_one/items"), "profile-items-page")).items, []);

    // Sharing began 40 minutes ago: older items are pre-sharing and leave on the next read.
    await admin.query("UPDATE social_accounts SET sharing_since = $2 WHERE account_id = $1", [
      FEED_STORY_ACCOUNTS.kai, new Date(NOW - 40 * MINUTE).toISOString(),
    ]);
    assert.deepEqual(ids(await ok(await items("kai/items"), "profile-items-page")), [
      story.ids.kaiTieHigh, story.ids.kaiTieLow, story.ids.kaiWhyCommit,
    ]);

    // Going private empties the list and flags the profile on the next read.
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai]);
    assert.deepEqual((await ok<SocialProfileItemsPage>(await items("kai/items"), "profile-items-page")).items, []);
  });
});

test("T-018: paging walks the same list once at every limit; bad paging parameters are invalid_parameter", { skip }, async () => {
  await withFixture(async ({ items }) => {
    const all = ids(await ok(await items("kai/items?limit=50"), "profile-items-page"));
    assert.equal(all.length, 6);
    for (const limit of [1, 2, 4, 6]) {
      const walked: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `kai/items?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const body: SocialProfileItemsPage = await ok(await items(query), "profile-items-page");
        assert.ok(body.items.length <= limit);
        walked.push(...ids(body));
        cursor = body.next_cursor;
        pages += 1;
        assert.ok(pages < 20);
      } while (cursor);
      assert.deepEqual(walked, all, `limit ${limit}`);
    }
    const first = await ok<SocialProfileItemsPage>(await items("kai/items"), "profile-items-page");
    assert.deepEqual(ids(first), all);
    await refused(await items("kai/items?limit=0"), 400, "invalid_parameter", "limit");
    await refused(await items("kai/items?limit=51"), 400, "invalid_parameter", "limit");
    await refused(await items("kai/items?limit=abc"), 400, "invalid_parameter", "limit");
    await refused(await items("kai/items?limit=2&limit=2"), 400, "invalid_parameter", "limit");
    await refused(await items("kai/items?cursor=nope"), 400, "invalid_parameter", "cursor");
    const two = await ok<SocialProfileItemsPage>(await items("kai/items?limit=2"), "profile-items-page");
    const [body, check] = two.next_cursor!.split(".");
    await refused(await items(`kai/items?cursor=${body}x.${check}`), 400, "invalid_parameter", "cursor");
    await refused(await items(`kai/items?cursor=${two.next_cursor}&cursor=${two.next_cursor}`), 400, "invalid_parameter", "cursor");
    // Unknown parameters are ignored.
    assert.deepEqual(ids(await ok(await items("kai/items?utm_source=x"), "profile-items-page")), all);
  });
});

test("T-018-AC-3 (AC-109, AC-124, AC-165, AC-042): no portfolio or viewer field, publicly cached, read on the replica, with as_of", { skip }, async () => {
  await withFixture(async ({ admin, replica, profile, items }) => {
    for (const callsign of ["kai", "orbit", "ghost", "late_one"]) {
      const identity = await profile(callsign, { authorization: bearer(`did:privy:feed-story-${callsign}`) });
      const page = await items(`${callsign}/items`);
      const identityBody = await ok<SocialProfile>(identity, "profile-response");
      const pageBody = await ok<SocialProfileItemsPage>(page, "profile-items-page");
      assert.deepEqual(Object.keys(identityBody).sort(), [
        "as_of", "avatar_url", "callsign", "display_name", "portfolio_public", "private", "verified", "x_handle",
      ]);
      assert.deepEqual(Object.keys(pageBody).sort(), ["as_of", "items", "next_cursor"]);
      for (const path of keyPaths({ identity: identityBody, page: pageBody })) {
        // OA-10 exposes the privacy setting and a public item names its presale's coin.
        if (path === "identity.portfolio_public" || path === "page.items.presale.coin_type") continue;
        const key = path.slice(path.lastIndexOf(".") + 1);
        assert.doesNotMatch(key, PORTFOLIO_KEY, `${callsign}: ${path}`);
        assert.doesNotMatch(key, VIEWER_KEY, `${callsign}: ${path}`);
      }
      // as_of is the read's watermark (the same database as the items).
      const asOf = await readAsOf(replica);
      assert.equal(identityBody.as_of.checkpoint, asOf?.checkpoint);
      assert.equal(pageBody.as_of.checkpoint, asOf?.checkpoint);
    }

    // Lag is reported, never an error.
    await admin.query(advanceWatermark(40_500, 61_000, "market"));
    const lagging = await ok<SocialProfile>(await profile("kai"), "profile-response");
    assert.equal(lagging.as_of.checkpoint, 40_500);
    assert.ok(lagging.as_of.lag_ms >= 61_000);

    // With no readable watermark the freshness is unknown: 503 no-store, with Retry-After.
    await admin.query("DELETE FROM watermarks");
    for (const response of [await profile("kai"), await items("kai/items")]) {
      await refused(response.clone(), 503, "service_unavailable");
      assert.ok(response.headers.get("retry-after"));
    }
  });
});
