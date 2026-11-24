import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { DatabaseError } from "pg";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import {
  PROFILE_CALLS_MAX,
  type SocialMePresales,
  type SocialProfileCalls,
  type SocialProfileEdit,
  type SocialProfileMutuals,
} from "@blast/core/modules/social/contracts/profile-page.ts";
import { withProfileBio, type SocialProfile, type SocialProfileItemsPage } from "@blast/core/modules/social/contracts/profiles.ts";
import { createSocialValidator, type SocialSchemaName } from "@blast/core/modules/social/contracts/validate.ts";
import { VESTING_MAX_MS } from "@blast/core/modules/social/contracts/vesting.ts";
import {
  FEED_STORY_ACCOUNTS,
  FEED_STORY_HIDDEN,
  FEED_STORY_HIDDEN_TEXT,
  FEED_STORY_MARKUP,
  FEED_STORY_PRESALES,
  FEED_STORY_QUOTE_TYPE,
  FEED_STORY_WALLETS,
  seedFeedStory,
  seedHiddenSales,
  type FeedStory,
} from "../../../../../../packages/core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialFollowRoutes } from "@blast/server/modules/social/follows/route.ts";

import { readForYouPage } from "@blast/server/modules/social/feed/feed-reader.ts";
import { isVisible, presalePostEntriesOf, visibleEntry } from "@blast/core/modules/social/read-model/entries.ts";
import { createSocialProfileEditRoutes } from "@blast/server/modules/social/profile-edit/route.ts";
import { vercelBlobLaunchAssetStore } from "@blast/server/modules/launch-assets/store.ts";
import { fetchProfileEdit, saveProfileEdit, uploadProfilePicture } from "../../../components/social/profile/profile-client.ts";
import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import type { ProfilePictureStore } from "@blast/server/modules/social/profile-edit/store.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialProfileRoutes } from "@blast/server/modules/social/profiles/route.ts";
import { FOLLOWERS_OF_CALLER } from "@blast/server/modules/social/viewer-state/store.ts";
import { isSocialConnectionCounts, isSocialConnections } from "@blast/core/modules/social/contracts/connections.ts";

/**
 * Social-feed UI-06 (canonical UI §6): the profile page's routes over a
 * disposable database with the fixture `chain_read_v1` and the feed story.
 * Public reads run as the replica role, viewer reads and writes as
 * `blast_web` on the primary, as in production.
 *
 * Added to the story: Kai's named commits to the recently migrated presale
 * (1,000 USDC) and to the cancelled one (300 USDC); that presale's claims
 * (net 800 USDC for 800,000 tokens: $0.001 a token, 80% filled) and a fresh
 * $0.0042 price (4.2×); Orbit, a Mission Control member without an account
 * row; Quinn, a member whose row exists.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-profile-page-app";
const PEPPER = "social-profile-page-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.now();
const MINUTE = 60_000;
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=20";
const ORBIT_PROFILE = "00000000-0000-4000-8000-000000000899";
const QUINN_PROFILE = "00000000-0000-4000-8000-00000000089a";
const QUINN_ACCOUNT = "00000000-0000-4000-8000-00000000079a";
const CLAIMER = `0x${"c1a1".padStart(64, "0")}`;

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

const KAI = bearer("did:privy:feed-story-kai");
const NOVA = bearer("did:privy:feed-story-nova");

type Get = (path: string, headers?: Record<string, string>) => Promise<Response>;
type Fixture = Readonly<{
  admin: Pool;
  /** The test's own database. */
  url: string;
  story: FeedStory;
  get: Get;
  editGet: Get;
  editPut: (body: unknown, headers?: Record<string, string>) => Promise<Response>;
  picture: (bytes: Uint8Array, type: string, headers?: Record<string, string>) => Promise<Response>;
  follow: (callsign: string, authorization: string) => Promise<Response>;
  stored: string[];
  storedImages: Map<string, Buffer>;
  profileApi: SocialApiOptions;
  setStorageFailure: (failed: boolean) => void;
}>;

async function seedProfilePage(admin: Pool): Promise<void> {
  const P = FEED_STORY_PRESALES;
  const commit = (checkpoint: number, presaleId: string, usd: number, minutesAgo = 5) => ({
    checkpoint, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: NOW - minutesAgo * MINUTE, digest: `Fp${checkpoint}`.padEnd(44, "1"),
    kind: "presale_commit", product: "presale" as const, actor: FEED_STORY_WALLETS.kai, tx_sender: FEED_STORY_WALLETS.kai,
    presale_id: presaleId, coin_type: `${presaleId}::coin::X`, quote_type: FEED_STORY_QUOTE_TYPE, quote_amount: String(usd * 1_000_000),
    coin_amount: null, quote_refund: null, usd_value: String(usd), usd_price_as_of_ms: NOW - 6 * MINUTE, venue: null,
    participants_after: null, total_commitments_after: null,
  });
  await seedChainRead(admin, {
    // The commit to the migrated sale lands before the story's claim of it (50 minutes ago).
    activity: [commit(60_001, P.migratedRecently, 1_000, 60), commit(60_002, P.cancelled, 300)],
    presale_positions: [
      { presale_id: P.migratedRecently, wallet: CLAIMER, commitment: "1000000000", last_commit_ms: NOW - 9 * MINUTE, claim_digest: "Fc1".padEnd(44, "1"), claimed_tokens: "800000000000000", claimed_quote_refund: "200000000", claimed_ms: NOW - MINUTE },
      { presale_id: P.migratedRecently, wallet: FEED_STORY_WALLETS.kai, commitment: "1000000000", last_commit_ms: NOW - 5 * MINUTE, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null },
      { presale_id: P.open, wallet: FEED_STORY_WALLETS.kai, commitment: "90000000", last_commit_ms: NOW - 12 * MINUTE, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null },
    ],
    prices: [{ coin_type: `${P.migratedRecently}::coin::MIGR`, usd_price: "0.0042", as_of_ms: NOW - 10_000, source: "pool" }],
  });
  await admin.query("UPDATE blast_infra_fixture.presales SET total_commitments = '73000000000' WHERE presale_id = $1", [P.open]);
  // R3-32: the story's claim of that sale, as the chain would log the 1,000 USDC commit's fill: 800,000 tokens, 200 back.
  await admin.query(
    `UPDATE blast_infra_fixture.activity SET coin_amount = 800000000000000, quote_refund = 200000000
     WHERE kind = 'presale_claim' AND actor = $1 AND presale_id = $2`,
    [FEED_STORY_WALLETS.kai, P.migratedRecently],
  );
  for (const [profileId, callsign, n] of [[ORBIT_PROFILE, "orbit", 1], [QUINN_PROFILE, "quinn", 2]] as const) {
    await admin.query(
      `INSERT INTO mission_control_profiles (
         profile_id, privy_did, x_subject, x_handle, x_avatar_reference, sui_address, provider_wallet_reference, callsign,
         display_name, avatar_reference, disclosure_version, disclosure_accepted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 'fixture-v1', now())`,
      [profileId, `did:privy:${callsign}`, `x-${callsign}`, `${callsign}_x`, `https://pbs.twimg.com/${callsign}.png`,
        `0x${(0xb170 + n).toString(16).padStart(64, "0")}`, `wallet-${callsign}`, callsign, callsign.toUpperCase()],
    );
  }
  await admin.query("INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2)", [QUINN_ACCOUNT, QUINN_PROFILE]);
  await admin.query(
    "INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at) VALUES ($1, 'privy', 'did:privy:quinn', now())",
    [QUINN_PROFILE],
  );
}

async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Readonly<{ store?: boolean }> = {}): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedFeedStory(admin, { nowMs: NOW });
  await seedProfilePage(admin);
  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "ui06-replica");
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "ui06-web");
  const stored: string[] = [];
  let failStorage = false;
  const storedImages = new Map<string, Buffer>();
  // Only the external Blob write is replaced. Real public access options,
  // image normalization, owner auth and SQL persistence remain in the path.
  const store: ProfilePictureStore = vercelBlobLaunchAssetStore("isolated-public-image-token", async (pathname, bytes, options) => {
    assert.equal(options.access, "public");
    assert.equal(options.contentType, "image/webp");
    assert.equal(options.addRandomSuffix, false);
    assert.equal(options.allowOverwrite, true);
    if (options.token !== "isolated-public-image-token") throw new Error("unexpected fixture token");
    if (failStorage) throw new Error("isolated storage unavailable");
    stored.push(pathname);
    storedImages.set(pathname, Buffer.from(bytes));
    return { url: `https://blob.blast.test/${pathname}` };
  });
  try {
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"));
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
    });
    const replica = autocommitReader(replicaPool, "social");
    const routes = createSocialProfileRoutes({
      kit, database: () => replica, config: reader.getSocialConfig, now: () => NOW,
      primary: () => autocommitReader(webPool, "social"),
    });
    const edit = createSocialProfileEditRoutes({ kit, findBlockedTerm: reader.findBlockedTerm, store: () => (options.store === false ? null : store) });
    const follows = createSocialFollowRoutes({ kit });
    const request = (path: string, init: RequestInit = {}) =>
      new Request(`${ORIGIN}${path}`, { ...init, headers: { "x-forwarded-for": "203.0.113.9", ...(init.headers as Record<string, string>) } });
    const route = (path: string) => /\/(calls|theses|mutuals|items|connections)(\?|$)/.exec(path)?.[1] ?? "";
    await run({
      admin,
      url,
      story,
      stored,
      storedImages,
      setStorageFailure: (failed) => { failStorage = failed; },
      profileApi: {
        getAccessToken: async () => KAI.slice("Bearer ".length),
        fetch: async (input, init) => {
          const req = request(String(input), init);
          if (new URL(req.url).pathname.endsWith("/picture")) return edit.picture.PUT(req, testClient());
          return req.method === "GET" ? edit.profile.GET(req, testClient()) : edit.profile.PUT(req, testClient());
        },
      },
      get: (path, headers = {}) => {
        const req = request(path, { headers });
        if (path === "/api/social/me/presales/created") return routes.createdPresales.GET(req, testClient());
        if (path.startsWith("/api/social/me/presales")) return routes.mePresales.GET(req, testClient());
        const part = route(path);
        if (part === "connections") return routes.connections.GET(req, testClient());
        if (part === "calls") return routes.calls.GET(req, testClient());
        if (part === "theses") return routes.theses.GET(req, testClient());
        if (part === "mutuals") return routes.mutuals.GET(req, testClient());
        if (part === "items") return routes.items.GET(req, testClient());
        return routes.profile.GET(req, testClient());
      },
      editGet: (path, headers = {}) => edit.profile.GET(request(path, { headers }), testClient()),
      editPut: (body, headers = {}) =>
        edit.profile.PUT(request("/api/social/me/profile", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }), testClient()),
      picture: (bytes, type, headers = {}) =>
        edit.picture.PUT(request("/api/social/me/profile/picture", { method: "PUT", body: Buffer.from(bytes), headers: { "content-type": type, ...headers } }), testClient()),
      follow: (callsign, authorization) =>
        follows.account.PUT(request(`/api/social/follows/account/${callsign}`, { method: "PUT", headers: { authorization } }), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function ok<T>(response: Response, schema: SocialSchemaName, cache = PUBLIC_CACHE): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), cache);
  return body as T;
}

async function refused(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  return body.error;
}

test("UI-06 (OA-9, OA-14): calls are the named commits per presale; the track record is presales backed, launched and PnL", { skip }, async () => {
  await withFixture(async ({ admin, story, get }) => {
    const body = await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response");
    const P = FEED_STORY_PRESALES;
    assert.deepEqual(body.calls.map((call) => [call.presale.presale_id, call.presale.status, call.committed_usd]), [
      [P.migratedRecently, "trading", "1000.00"],
      [P.cancelled, "cancelled", "300.00"],
      [P.open, "open", "110.00"],
    ]);
    const [trading, cancelled, open] = body.calls;
    // Entry $0.001 (net 800 USDC for 800,000 tokens), now $0.0042: 4.2×; 80% filled, so 1,000 is worth 200 + 800 × 4.2.
    assert.deepEqual([trading!.entry_price_usd, trading!.price_usd, trading!.multiple, trading!.value_usd, trading!.pnl_usd], ["0.001", "0.0042", "4.2000", "3560.00", "2560.00"]);
    assert.deepEqual([cancelled!.value_usd, cancelled!.pnl_usd], ["300.00", "0.00"]);
    assert.deepEqual([open!.entry_price_usd, open!.multiple, open!.value_usd, open!.presale.fill_pct], [null, null, null, 73]);
    assert.equal(trading!.series, null);
    assert.deepEqual(body.track_record, { presales_backed: 3, launched: 1, pnl_usd: "2560.00" });
    // The thesis line: the story's why on Kai's commit to the open sale; none on the others.
    assert.deepEqual(body.calls.map((call) => call.why), [null, null, `Team shipped on time twice. ${FEED_STORY_MARKUP}`]);

    // A newer why on another of the sale's commits is the call's thesis; a why on a trade of the trading sale's coin is none.
    await admin.query(
      `INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES
         ('00000000-0000-4000-8000-0000000c11a1', $1, $3, 'Doubling down'), ('00000000-0000-4000-8000-0000000c11a2', $2, $3, 'Bought the dip')`,
      [story.ids.kaiTieHigh, story.ids.kaiBuy, FEED_STORY_ACCOUNTS.kai],
    );
    const withWhys = await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response");
    assert.deepEqual(withWhys.calls.map((call) => call.why), [null, null, "Doubling down"]);
    // A deleted why is no thesis: the older one is the line again.
    await admin.query("UPDATE social_whys SET state = 'deleted', deleted_at = now() WHERE why_id = '00000000-0000-4000-8000-0000000c11a1'");
    const deleted = await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response");
    assert.equal(deleted.calls.at(-1)!.why, `Team shipped on time twice. ${FEED_STORY_MARKUP}`);

    // A stale price: the trading call has no value, so the PnL is unknown rather than partial.
    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1", [NOW - 10 * MINUTE]);
    const stale = await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response");
    assert.equal(stale.calls.find((call) => call.presale.status === "trading")?.multiple, null);
    assert.equal(stale.track_record.pnl_usd, null);

    // Unnamed accounts have no calls: private, never onboarded.
    for (const callsign of ["ghost", "late_one"]) {
      const none = await ok<SocialProfileCalls>(await get(`/api/social/profiles/${callsign}/calls`), "profile-calls-response");
      assert.deepEqual([none.calls, none.track_record], [[], { presales_backed: 0, launched: 0, pnl_usd: null }]);
    }
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai]);
    assert.deepEqual((await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response")).calls, []);
    await refused(await get("/api/social/profiles/nobody/calls"), 404, "not_found");
    await refused(await get("/api/social/profiles/Kai/calls"), 400, "invalid_parameter");
  });
});

test("UI-06: the profile carries verified and portfolio_public; a member without an account row gets one on its first read", { skip }, async () => {
  await withFixture(async ({ admin, get, follow }) => {
    const kai = await ok<SocialProfile>(await get("/api/social/profiles/kai"), "profile-response");
    // kai's X account is linked in the feed story (OA-8: verified means X linked).
    assert.deepEqual([kai.verified, kai.private, kai.portfolio_public], [true, false, false]);
    await admin.query("UPDATE social_accounts SET portfolio_public = true WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai]);
    assert.equal((await ok<SocialProfile>(await get("/api/social/profiles/kai"), "profile-response")).portfolio_public, true);
    // Private wins over the switch.
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai]);
    assert.equal((await ok<SocialProfile>(await get("/api/social/profiles/kai"), "profile-response")).portfolio_public, false);

    const rows = async () => (await admin.query("SELECT count(*)::int AS n FROM social_accounts WHERE profile_id = $1", [ORBIT_PROFILE])).rows[0]!.n as number;
    assert.equal(await rows(), 0);
    const [first, second] = await Promise.all([get("/api/social/profiles/orbit"), get("/api/social/profiles/orbit")]);
    const orbit = await ok<SocialProfile>(first, "profile-response");
    await ok(second, "profile-response");
    assert.deepEqual([orbit.callsign, orbit.display_name, orbit.verified, orbit.private], ["orbit", "ORBIT", true, false]);
    assert.equal(await rows(), 1);
    // Its calls and items read as an account's that shares nothing yet.
    assert.deepEqual((await ok<SocialProfileCalls>(await get("/api/social/profiles/orbit/calls"), "profile-calls-response")).calls, []);
    assert.deepEqual((await ok<SocialProfileItemsPage>(await get("/api/social/profiles/orbit/items"), "profile-items-page")).items, []);
    assert.equal(await rows(), 1);
    // An unknown callsign creates nothing.
    await refused(await get("/api/social/profiles/nobody"), 404, "not_found");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_accounts WHERE profile_id IS NOT NULL AND callsign IS NOT NULL")).rows[0]!.n, 0);

    // Following a member who never opened Blast works too.
    await admin.query("DELETE FROM social_accounts WHERE profile_id = $1", [ORBIT_PROFILE]);
    assert.equal((await follow("orbit", NOVA)).status, 204);
    assert.equal(await rows(), 1);
  });
});

test("UI-06: theses are the account's named posts with its why, most rockets first, paged by their own cursor", { skip }, async () => {
  await withFixture(async ({ admin, story, get }) => {
    const A = FEED_STORY_ACCOUNTS;
    // Two more whys on Kai's posts; the tie-high post gets two rockets.
    await admin.query(
      `INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES
         ('00000000-0000-4000-8000-0000000007b1', $1, $3, 'Second thesis'), ('00000000-0000-4000-8000-0000000007b2', $2, $3, 'Third thesis')`,
      [story.ids.kaiTieHigh, story.ids.kaiTieLow, A.kai],
    );
    await admin.query(
      "INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ($1, $2, 'rocket'), ($1, $3, 'rocket'), ($1, $4, 'fire')",
      [story.ids.kaiTieHigh, A.nova, A.mallory, A.ghost],
    );
    const all = await ok<SocialProfileItemsPage>(await get("/api/social/profiles/kai/theses"), "profile-items-page");
    // Rockets 2, then 1 (the story's why commit), then 0.
    assert.deepEqual(all.items.map((item) => item.entry_id), [story.ids.kaiTieHigh, story.ids.kaiWhyCommit, story.ids.kaiTieLow]);
    assert.ok(all.items.every((item) => item.why !== null));
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: SocialProfileItemsPage = await ok(await get(`/api/social/profiles/kai/theses?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), "profile-items-page");
      walked.push(...page.items.map((item) => item.entry_id));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(walked, all.items.map((item) => item.entry_id));
    // Nova has no why; an items cursor is not a theses cursor.
    assert.deepEqual((await ok<SocialProfileItemsPage>(await get("/api/social/profiles/nova/theses"), "profile-items-page")).items, []);
    const itemsPage = await ok<SocialProfileItemsPage>(await get("/api/social/profiles/kai/items?limit=1"), "profile-items-page");
    await refused(await get(`/api/social/profiles/kai/theses?cursor=${encodeURIComponent(itemsPage.next_cursor!)}`), 400, "invalid_parameter");
    // Going private hides them.
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [A.kai]);
    assert.deepEqual((await ok<SocialProfileItemsPage>(await get("/api/social/profiles/kai/theses"), "profile-items-page")).items, []);
  });
});

test("0098: a why on the account's trade (event_slot u32::MAX, as T-038 writes it) is one of its theses", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const P = FEED_STORY_PRESALES;
    await seedChainRead(admin, {
      activity: [{
        checkpoint: 39_998, tx_slot: 4, event_slot: 4_294_967_295, part: 0, timestamp_ms: NOW - 2 * MINUTE, digest: "Trd0098".padEnd(44, "1"),
        kind: "trade_buy", product: "market", actor: FEED_STORY_WALLETS.kai, tx_sender: FEED_STORY_WALLETS.kai,
        presale_id: P.migratedRecently, coin_type: `${P.migratedRecently}::coin::X`, quote_type: FEED_STORY_QUOTE_TYPE,
        quote_amount: "20000000", coin_amount: "900000000000", quote_refund: null, usd_value: "20", usd_price_as_of_ms: NOW - 2 * MINUTE - 1_000,
        venue: "cetus", participants_after: null, total_commitments_after: null,
      }],
    });
    const entry = "a:39998:4:4294967295:0";
    await admin.query(
      "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ('00000000-0000-4000-8000-0000000098a1', $1, $2, 'Adding on the breakout')",
      [entry, FEED_STORY_ACCOUNTS.kai],
    );
    const theses = await ok<SocialProfileItemsPage>(await get("/api/social/profiles/kai/theses"), "profile-items-page");
    assert.ok(theses.items.some((item) => item.entry_id === entry), "the trade's why is a thesis");
  });
});

test("UI-06: mutuals are people the viewer follows who follow the account; never cached; private accounts left out", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const A = FEED_STORY_ACCOUNTS;
    const followRow = (follower: string, target: string, minutesAgo: number) =>
      admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source, created_at) VALUES ($1, 'account', $2, 'user', $3)", [follower, target, new Date(NOW - minutesAgo * MINUTE).toISOString()]);
    // Kai follows Nova, Mallory and Ghost (private); all three follow Late.
    await followRow(A.kai, A.nova, 3);
    await followRow(A.kai, A.mallory, 1);
    await followRow(A.kai, A.ghost, 2);
    for (const follower of [A.nova, A.mallory, A.ghost]) await followRow(follower, A.late, 5);
    const body = await ok<SocialProfileMutuals>(await get("/api/social/profiles/late_one/mutuals", { authorization: KAI }), "profile-mutuals-response", "private, no-store");
    assert.deepEqual([body.accounts.map((account) => account.callsign), body.total], [["mallory", "nova"], 2]);
    assert.deepEqual((await ok<SocialProfileMutuals>(await get("/api/social/profiles/nova/mutuals", { authorization: KAI }), "profile-mutuals-response", "private, no-store")).total, 0);
    await refused(await get("/api/social/profiles/late_one/mutuals"), 401, "unauthorized");
    await refused(await get("/api/social/profiles/nobody/mutuals", { authorization: KAI }), 404, "not_found");
    // A private target's followers are its owner's alone: Nova and Mallory follow Ghost, yet no mutuals show through it.
    for (const follower of [A.nova, A.mallory]) await followRow(follower, A.ghost, 4);
    const privateTarget = await ok<SocialProfileMutuals>(await get("/api/social/profiles/ghost/mutuals", { authorization: KAI }), "profile-mutuals-response", "private, no-store");
    assert.deepEqual([privateTarget.accounts, privateTarget.total], [[], 0]);
    // follows_you never names a private follower: Ghost and Nova both follow Late, only Nova is said to.
    const { rows } = await admin.query<{ callsign: string }>(FOLLOWERS_OF_CALLER, [A.late, ["ghost", "nova"]]);
    assert.deepEqual(rows.map((row) => row.callsign), ["nova"]);
  });
});

test("profile connections: real counts, keyset pages, search, read-your-writes and privacy", { skip }, async () => {
  await withFixture(async ({ admin, get, follow }) => {
    const A = FEED_STORY_ACCOUNTS;
    await admin.query("DELETE FROM social_follows");
    for (const [actor, target] of [[A.kai, A.nova], [A.kai, A.mallory], [A.kai, A.ghost], [A.nova, A.kai], [A.mallory, A.kai], [A.ghost, A.kai]]) {
      await admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source, created_at) VALUES ($1, 'account', $2, 'user', '2026-10-14T12:00:00.123456Z')", [actor, target]);
    }
    // Presales never count as people.
    await admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'presale', $2, 'user')", [A.kai, FEED_STORY_PRESALES.open]);
    const read = async (path: string, authorization?: string) => {
      const response = await get(path, authorization ? { authorization } : {});
      const body: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(isSocialConnections(body));
      return body;
    };
    const base = "/api/social/profiles/kai/connections";
    const counts = async (path = base, authorization?: string, headers: Record<string, string> = {}) => {
      const response = await get(path, { ...headers, ...(authorization ? { authorization } : {}) });
      const body: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(isSocialConnectionCounts(body));
      assert.deepEqual(Object.keys(body).sort(), ["followers", "following"]);
      return body;
    };
    assert.deepEqual(await counts(), { followers: 2, following: 2 });
    assert.equal((await counts(base, KAI)).following, 3);
    assert.equal((await counts(base, KAI, { "x-blast-public-view": "1" })).following, 2);
    const first = await read(`${base}?tab=followers&limit=1`);
    assert.deepEqual(Object.keys(first).sort(), ["accounts", "next_cursor"]);
    assert.equal(first.accounts.length, 1);
    assert.ok(first.next_cursor);
    const second = await read(`${base}?tab=followers&limit=1&cursor=${first.next_cursor}`);
    assert.deepEqual([...first.accounts, ...second.accounts].map((a) => a.callsign), ["mallory", "nova"]);
    assert.equal(second.next_cursor, null);
    await refused(await get(`${base}?tab=following&cursor=${first.next_cursor}`), 400, "invalid_parameter");
    assert.deepEqual((await read(`${base}?tab=following&q=@NoVa`)).accounts.map((a) => a.callsign), ["nova"]);
    assert.deepEqual((await read(`${base}?tab=following&q=%25`)).accounts, []);
    assert.equal((await read(`${base}?tab=following&q=ghost`)).accounts.length, 0);
    const ownGhost = await read(`${base}?tab=following&q=ghost`, KAI);
    assert.equal(ownGhost.accounts[0]?.private, true);
    // Indexed search must retain literal substrings, current names, and one row per identity.
    for (const [q, displayName] of [["a%b", "a%b"], ["a_b", "a_b"], ["a\\b", "a\\b"], ["élan", "Élan"], ["personname", "PERSONNAME"]]) {
      await admin.query("UPDATE social_accounts SET display_name=$1 WHERE account_id=$2", [displayName, A.nova]);
      for (const tab of ["followers", "following"]) {
        assert.deepEqual((await read(`${base}?tab=${tab}&q=${encodeURIComponent(q!)}`)).accounts.map((a) => a.callsign), ["nova"]);
      }
    }
    assert.deepEqual((await read(`${base}?tab=following&q=nova%20personname`)).accounts, []);
    await admin.query("UPDATE mission_control_profiles SET display_name='obsolete-source' WHERE profile_id=$1", [QUINN_PROFILE]);
    await admin.query("UPDATE social_accounts SET display_name='quinn override' WHERE account_id=$1", [QUINN_ACCOUNT]);
    for (const [actor, target] of [[A.kai, QUINN_ACCOUNT], [QUINN_ACCOUNT, A.kai]]) {
      await admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'account', $2, 'user')", [actor, target]);
    }
    for (const tab of ["followers", "following"]) {
      assert.deepEqual((await read(`${base}?tab=${tab}&q=obsolete-source`)).accounts, []);
      assert.deepEqual((await read(`${base}?tab=${tab}&q=quinn`)).accounts.map((a) => a.callsign), ["quinn"]);
    }
    await admin.query("DELETE FROM social_follows WHERE follower_account_id=$1 OR (target_kind='account' AND target_id=$1::text)", [QUINN_ACCOUNT]);
    const visitor = await get(`${base}?tab=following&q=ghost`, { authorization: KAI, "x-blast-public-view": "1" });
    assert.deepEqual((await visitor.json()).accounts, []);
    // Private actors stay hidden even from the recipient of their follow.
    assert.deepEqual((await read(`${base}?tab=followers`, KAI)).accounts.map((a) => a.callsign), ["mallory", "nova"]);
    for (const authorization of [undefined, NOVA, "Bearer invalid"]) await refused(await get("/api/social/profiles/ghost/connections?tab=following", authorization ? { authorization } : {}), 404, "not_found");
    const ghost = bearer("did:privy:feed-story-ghost");
    assert.deepEqual((await read("/api/social/profiles/ghost/connections?tab=following", ghost)).accounts.map((a) => a.callsign), ["kai"]);
    await refused(await get("/api/social/profiles/ghost/connections", { authorization: ghost, "x-blast-public-view": "1" }), 404, "not_found");
    assert.equal((await follow("late_one", KAI)).status, 204);
    assert.equal((await counts(base, KAI)).following, 4);
    assert.equal((await counts()).following, 3);
    // A privacy change hides the rows and their counts on the very next page/read.
    await admin.query("UPDATE social_accounts SET privacy='private', sharing_since=NULL WHERE account_id=$1", [A.mallory]);
    assert.equal((await counts()).followers, 1);
    assert.equal((await counts()).following, 2);
    await admin.query("UPDATE social_accounts SET privacy='private', sharing_since=NULL WHERE account_id=$1", [A.kai]);
    await refused(await get(`${base}?tab=followers&cursor=${first.next_cursor}`), 404, "not_found");
    assert.equal((await counts(base, KAI)).following, 4);
    await admin.query("UPDATE social_accounts SET callsign='kai_renamed' WHERE account_id=$1", [A.kai]);
    assert.equal((await counts(base, KAI)).following, 4);
    assert.equal((await counts("/api/social/profiles/kai_renamed/connections", KAI)).following, 4);
    await refused(await get(base), 404, "not_found");
    await refused(await get("/api/social/profiles/nobody/connections"), 404, "not_found");
    await refused(await get(`${base}?tab=followers&limit=51`), 400, "invalid_parameter");
  });
});

test("UI-06: the viewer's own presales (positions and watchlist) for the right column", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    // UI-12, OA-17: the watchlist is the starred presales, then the followed ones not starred (following is not starring).
    await admin.query("INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, $2)", [FEED_STORY_ACCOUNTS.kai, FEED_STORY_PRESALES.pending]);
    await admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'presale', $2, 'user')", [FEED_STORY_ACCOUNTS.kai, FEED_STORY_PRESALES.open]);
    const P = FEED_STORY_PRESALES;
    const DAY = 86_400_000;
    await seedChainRead(admin, {
      coin_balances: [
        { coin_type: `${P.migratedRecently}::coin::MIGR`, owner: FEED_STORY_WALLETS.kai, balance: "250000000000000", updated_checkpoint: 1 },
        { coin_type: `${P.migratedRecently}::coin::MIGR`, owner: CLAIMER, balance: "999000000000", updated_checkpoint: 1 },
      ],
      vesting_schedules: [
        { schedule_id: "vs-1", presale_id: P.migratedRecently, beneficiary: FEED_STORY_WALLETS.kai, total: "400000000000000", claimed: "10000000000000", start_ms: NOW - 18 * DAY, cliff_ms: "0", end_ms: String(NOW + 162 * DAY) },
        { schedule_id: "vs-2", presale_id: P.migratedRecently, beneficiary: CLAIMER, total: "1", claimed: "0", start_ms: 0, cliff_ms: "0", end_ms: "1" },
      ],
    });
    // Kai claimed: 800,000 tokens and a 200 USDC refund.
    await admin.query(
      "UPDATE blast_infra_fixture.presale_positions SET claim_digest = 'Fk', claimed_tokens = 800000000000000, claimed_quote_refund = 200000000 WHERE wallet = $1 AND presale_id = $2",
      [FEED_STORY_WALLETS.kai, P.migratedRecently],
    );
    const body = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
    assert.deepEqual(body.positions.map((position) => [position.presale.presale_id, position.committed_usd, position.status, position.claimed_tokens, position.refunded_usd, position.value_usd, position.multiple]), [
      [P.migratedRecently, "1000.00", "delivered", "800000", "200.00", "3360.00", "4.2000"],
      [P.open, "90.00", "open", null, null, null, null],
    ]);
    const positionsOnly = await ok<SocialMePresales>(await get("/api/social/me/presales?view=positions", { authorization: KAI }), "me-presales-response", "private, no-store");
    assert.deepEqual(positionsOnly, { ...body, coins: [] });
    // Coins: the sale coin Kai's wallet holds at its fresh price; another wallet's balance is not Kai's.
    assert.deepEqual(body.coins.map((coin) => [coin.presale.presale_id, coin.quantity, coin.value_usd, coin.multiple]), [[P.migratedRecently, "250000", "1050.00", "4.2000"]]);
    // R3-32: Kai bought 900 for $12.50 and claimed 800,000 for $800 (1,000 USDC, 200 back): 800,900 for $812.50.
    // 250,000 are held (the rest left without a trade), at the average: $253.62; worth $1,050, +$796.38, 4.14×.
    const migr = { basis_usd: "253.62", basis_complete: true, pnl_usd: "796.38", pnl_multiple: "4.1400" };
    const basis = (row: { basis_usd: string | null; basis_complete: boolean; pnl_usd: string | null; pnl_multiple: string | null }) =>
      ({ basis_usd: row.basis_usd, basis_complete: row.basis_complete, pnl_usd: row.pnl_usd, pnl_multiple: row.pnl_multiple });
    assert.deepEqual(body.coins.map(basis), [migr]);
    assert.deepEqual(body.positions.map(basis), [migr, { basis_usd: null, basis_complete: true, pnl_usd: null, pnl_multiple: null }]);
    // Vesting: 18 of 180 days, 10% vested (40,000), 10,000 claimed, 30,000 to claim.
    assert.deepEqual(body.vestings.map((v) => [v.schedule_id, v.total, v.claimed, v.claimable, v.claimable_usd, v.vested_pct]), [["vs-1", "400000", "10000", "30000", "126.00", 10]]);
    assert.deepEqual(body.watchlist.map((presale) => [presale.presale_id, presale.status]), [[FEED_STORY_PRESALES.pending, "pending"], [FEED_STORY_PRESALES.open, "open"]]);
    await refused(await get("/api/social/me/presales"), 401, "unauthorized");
  });
});

test("R3-32-AC-5 (OA-9): a call's multiple and the position's basis multiple agree to the last place", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const P = FEED_STORY_PRESALES;
    const W = FEED_STORY_WALLETS;
    // Kai's only acquisition of MIGR is the claim (the story's buy goes), every token still held, and the 1,000
    // USDC committed were worth $999.80 at event time (USDC at $0.9998).
    await admin.query("DELETE FROM blast_infra_fixture.activity WHERE kind = 'trade_buy' AND actor = $1 AND presale_id = $2", [W.kai, P.migratedRecently]);
    await admin.query("UPDATE blast_infra_fixture.activity SET usd_value = 999.8 WHERE kind = 'presale_commit' AND actor = $1 AND presale_id = $2", [W.kai, P.migratedRecently]);
    await admin.query(
      "UPDATE blast_infra_fixture.presale_positions SET claim_digest = 'Fk', claimed_tokens = 800000000000000, claimed_quote_refund = 200000000 WHERE wallet = $1 AND presale_id = $2",
      [W.kai, P.migratedRecently],
    );
    await seedChainRead(admin, {
      coin_balances: [{ coin_type: `${P.migratedRecently}::coin::MIGR`, owner: W.kai, balance: "800000000000000", updated_checkpoint: 1 }],
    });

    const calls = await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response");
    const call = calls.calls.find((row) => row.presale.presale_id === P.migratedRecently);
    const mine = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
    const position = mine.positions.find((row) => row.presale.presale_id === P.migratedRecently);
    const coin = mine.coins.find((row) => row.presale.presale_id === P.migratedRecently);
    // 800,000 at $0.0042 = $3,360 over $999.80 × 800 / 1,000 = $799.84: 4.200840…×. The sale's own price ÷ entry
    // (net 800 USDC for 800,000 tokens) is 4.2000, which the call showed before R3-32.
    assert.equal(call?.multiple, "4.2008");
    assert.equal(position?.pnl_multiple, call?.multiple);
    assert.equal(coin?.pnl_multiple, call?.multiple);
    assert.deepEqual([position?.basis_usd, position?.pnl_usd, coin?.value_usd], ["799.84", "2560.16", "3360.00"]);
    // The PnL tile reads the call: 200 back + 800 × 4.2008.
    assert.deepEqual([call?.value_usd, call?.pnl_usd, calls.track_record.pnl_usd], ["3560.64", "2560.64", "2560.64"]);

    // After a buy the position's own multiple moves; the call stays the presale acquisition's.
    await seedChainRead(admin, {
      activity: [{
        checkpoint: 60_100, tx_slot: 0, event_slot: 1, part: 0, timestamp_ms: NOW - MINUTE, digest: "Fb1".padEnd(44, "1"),
        kind: "trade_buy", product: "market", actor: W.kai, tx_sender: W.kai, presale_id: P.migratedRecently,
        coin_type: `${P.migratedRecently}::coin::MIGR`, quote_type: FEED_STORY_QUOTE_TYPE, quote_amount: "3360000000",
        coin_amount: "800000000000000", quote_refund: null, usd_value: "3360", usd_price_as_of_ms: NOW - MINUTE, venue: "cetus",
        participants_after: null, total_commitments_after: null,
      }],
    });
    await admin.query("UPDATE blast_infra_fixture.coin_balances SET balance = 1600000000000000 WHERE owner = $1", [W.kai]);
    const after = await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response");
    const moved = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
    assert.equal(after.calls.find((row) => row.presale.presale_id === P.migratedRecently)?.multiple, "4.2008");
    // 1,600,000 at $0.0042 = $6,720 over $799.84 + $3,360.
    assert.equal(moved.coins.find((row) => row.presale.presale_id === P.migratedRecently)?.pnl_multiple, "1.6154");
  });
});

test("T-020 alignment: a cliff holds back everything until it ends, and NUMERIC times beyond a Date are clamped", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const P = FEED_STORY_PRESALES;
    const DAY = 86_400_000;
    await seedChainRead(admin, {
      vesting_schedules: [
        // A three-month cliff over a sixteen-month unlock: 18 days in, nothing has unlocked.
        { schedule_id: "vs-cliff", presale_id: P.migratedRecently, beneficiary: FEED_STORY_WALLETS.kai, total: "400000000000000", claimed: "0", start_ms: NOW - 18 * DAY, cliff_ms: String(90 * DAY), end_ms: String(NOW + 200 * DAY) },
        // `period x periods` beyond BIGINT: both times are NUMERIC, and no Date holds them.
        { schedule_id: "vs-numeric", presale_id: P.migratedRecently, beneficiary: FEED_STORY_WALLETS.kai, total: "400000000000000", claimed: "0", start_ms: 0, cliff_ms: "100000000000000000000", end_ms: "200000000000000000000" },
      ],
    });
    const body = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
    const schedules = new Map(body.vestings.map((vesting) => [vesting.schedule_id, vesting]));

    const cliff = schedules.get("vs-cliff");
    assert.equal(cliff?.cliff_end_ms, NOW - 18 * DAY + 90 * DAY);
    assert.equal(cliff?.claimable, "0");
    assert.equal(cliff?.vested_pct, 0);

    const numeric = schedules.get("vs-numeric");
    assert.equal(numeric?.cliff_end_ms, VESTING_MAX_MS);
    assert.equal(numeric?.end_ms, VESTING_MAX_MS);
    assert.equal(numeric?.claimable, "0");
    assert.equal(numeric?.vested_pct, 0);

    // Soonest end first, so the clamped schedule is last.
    assert.deepEqual(body.vestings.map((vesting) => vesting.schedule_id), ["vs-cliff", "vs-numeric"]);
  });
});

async function png(width: number, height: number): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: "#ff4c98" } }).withMetadata({ exif: { IFD0: { Copyright: "secret" } } }).png().toBuffer();
}

test("UI-06 (OA-14): the edit sheet changes the display name, bio and picture", { skip }, async () => {
  await withFixture(async ({ admin, get, editGet, editPut, picture, profileApi, stored }) => {
    // Blocked terms are cached per process for 30 s: the term exists before the first check.
    await admin.query("INSERT INTO social_blocked_terms (term, added_by) VALUES ('scam', 'test')");
    const before = await ok<SocialProfileEdit>(await editGet("/api/social/me/profile", { authorization: KAI }), "profile-edit-response", "private, no-store");
    assert.deepEqual(before, { callsign: "kai", callsign_editable: true, display_name: "Kai", picture: "source", avatar_url: null, source_avatar_url: null, upload_available: true });

    const renamed = await saveProfileEdit(profileApi, { display_name: "  Kai   Moreno ", bio: "  Sui\n builder  " });
    assert.equal(renamed.status, "ok");
    assert.equal(renamed.body.display_name, "Kai Moreno");
    assert.equal(renamed.body.bio, "Sui builder");
    const publicProfile = await ok<SocialProfile>(await get(withProfileBio("/api/social/profiles/kai")), "profile-response");
    assert.equal(publicProfile.display_name, "Kai Moreno");
    assert.equal(publicProfile.bio, "Sui builder");
    const legacyEdit = await ok<SocialProfileEdit>(await editGet("/api/social/me/profile", { authorization: KAI }), "profile-edit-response", "private, no-store");
    assert.equal(legacyEdit.bio, undefined);
    assert.equal((await ok<SocialProfile>(await get("/api/social/profiles/kai"), "profile-response")).bio, undefined);
    const ownerEdit = await fetchProfileEdit(profileApi);
    assert.equal(ownerEdit.status, "ok");
    assert.equal(ownerEdit.body.bio, "Sui builder");

    for (const bad of ["", "   ", "x".repeat(33), "Kai\u0000", "Kai\u202emoreno", 42]) {
      await refused(await editPut({ display_name: bad }, { authorization: KAI }), 422, "invalid_display_name");
    }
    assert.equal((await refused(await editPut({ display_name: "Not a SCAM" }, { authorization: KAI }), 422, "blocked_term")).field, "display_name");
    assert.equal((await refused(await editPut({ bio: "SCAM" }, { authorization: KAI }), 422, "blocked_term")).field, "bio");
    for (const body of [{ picture: "upload" }, { bio: "😀".repeat(161) }, { bio: "Sui\u0000" }, { bio: null }, { display_name: "Kai", picture: null }]) {
      await refused(await editPut(body, { authorization: KAI }), 400, "invalid_request");
    }
    await refused(await editPut({ display_name: "Kai" }), 401, "unauthorized");
    await refused(await editPut({ display_name: "Kai" }, { authorization: KAI, origin: "https://evil.example" }), 403, "origin_invalid");

    // Upload: decoded, squared to 400×400 WebP without metadata, stored at its content address.
    const uploaded = await ok<SocialProfileEdit>(await picture(await png(300, 200), "image/png", { authorization: KAI }), "profile-edit-response", "private, no-store");
    assert.equal(uploaded.picture, "upload");
    assert.equal(uploaded.bio, undefined);
    assert.match(stored[0]!, /^social-pictures\/[0-9a-f]{64}\.webp$/);
    assert.equal(uploaded.avatar_url, `https://blob.blast.test/${stored[0]}`);
    const editedPhoto = await uploadProfilePicture(profileApi, new Blob([new Uint8Array(await png(300, 200))], { type: "image/png" }));
    assert.equal(editedPhoto.status, "ok");
    assert.equal(editedPhoto.body.bio, "Sui builder");
    assert.equal((await ok<SocialProfile>(await get("/api/social/profiles/kai"), "profile-response")).avatar_url, uploaded.avatar_url);
    assert.equal((await refused(await picture(await png(300, 200), "image/jpeg", { authorization: KAI }), 422, "invalid_image")).reason, "type");
    assert.equal((await refused(await picture(await png(40, 40), "image/png", { authorization: KAI }), 422, "invalid_image")).reason, "dimensions");
    assert.equal((await refused(await picture(Buffer.from("<svg onload=alert(1)>"), "image/svg+xml", { authorization: KAI }), 422, "invalid_image")).reason, "type");
    await refused(await picture(Buffer.alloc(2 * 1024 * 1024 + 1, 1), "image/png", { authorization: KAI }), 413, "body_too_large");

    // Remove, then back to the source.
    const removed = await saveProfileEdit(profileApi, { picture: "none", bio: "" });
    assert.equal(removed.status, "ok");
    assert.deepEqual([removed.body.picture, removed.body.avatar_url], ["none", null]);
    assert.equal(removed.body.bio, undefined);
    assert.equal((await ok<SocialProfile>(await get(withProfileBio("/api/social/profiles/kai")), "profile-response")).bio, undefined);
    assert.equal((await ok<SocialProfileEdit>(await editPut({ picture: "source" }, { authorization: KAI }), "profile-edit-response", "private, no-store")).picture, "source");

    // A member's name overrides its Mission Control profile's on Blast only.
    const quinn = bearer("did:privy:quinn");
    const member = await ok<SocialProfileEdit>(await editGet("/api/social/me/profile", { authorization: quinn }), "profile-edit-response", "private, no-store");
    assert.deepEqual([member.display_name, member.source_avatar_url], ["QUINN", "https://pbs.twimg.com/quinn.png"]);
    const memberBio = "😀".repeat(160);
    await ok(await editPut({ display_name: "Quinn Ray", picture: "none", bio: memberBio }, { authorization: quinn }), "profile-edit-response", "private, no-store");
    const shown = await ok<SocialProfile>(await get(withProfileBio("/api/social/profiles/quinn")), "profile-response");
    assert.deepEqual([shown.display_name, shown.avatar_url], ["Quinn Ray", null]);
    assert.equal(shown.bio, memberBio);
    assert.equal((await admin.query("SELECT display_name FROM mission_control_profiles WHERE profile_id = $1", [QUINN_PROFILE])).rows[0]!.display_name, "QUINN");
  });
});

test("UI-06: without a picture store uploads are off and say so; the rest of the sheet works", { skip }, async () => {
  await withFixture(async ({ editGet, picture, editPut }) => {
    assert.equal((await ok<SocialProfileEdit>(await editGet("/api/social/me/profile", { authorization: KAI }), "profile-edit-response", "private, no-store")).upload_available, false);
    const response = await picture(await png(100, 100), "image/png", { authorization: KAI });
    await refused(response, 503, "picture_upload_unavailable");
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    await ok(await editPut({ display_name: "Kai" }, { authorization: KAI }), "profile-edit-response", "private, no-store");
  }, { store: false });
});

/**
 * T-043 hidden sales (`seedHiddenSales`): Kai's commits, trades and a why on
 * the excluded test sale (no `presales` row, its activity kept) and on a sale
 * with no coin metadata, newer than his story items.
 */
test("T-043 hidden sales: a profile's items, calls and theses leave out hidden sales, and every items page is the one without them", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const walk = async (path: string, limit: number) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const page: SocialProfileItemsPage = await ok(await get(`${path}${query}`), "profile-items-page");
        assert.doesNotMatch(JSON.stringify(page), FEED_STORY_HIDDEN_TEXT);
        ids.push(...page.items.map((item) => item.entry_id));
        cursor = page.next_cursor;
      } while (cursor);
      return ids;
    };
    const read = async () => ({
      items: await Promise.all([1, 3, 20].map((limit) => walk("/api/social/profiles/kai/items", limit))),
      novaItems: await walk("/api/social/profiles/nova/items", 2),
      calls: (({ calls, track_record }) => ({ calls, track_record }))(
        await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response"),
      ),
      theses: await walk("/api/social/profiles/kai/theses", 1),
    });
    const before = await read();
    assert.ok(before.items[0]!.length >= 5 && before.theses.length === 1);

    const hidden = await seedHiddenSales(admin, { nowMs: NOW });
    // Rockets put the hidden thesis first if it were kept at all.
    await admin.query(
      "INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ($1, $2, 'rocket'), ($1, $3, 'rocket')",
      [hidden.ids.kaiCommit, FEED_STORY_ACCOUNTS.nova, FEED_STORY_ACCOUNTS.mallory],
    );
    const after = await read();
    assert.deepEqual(after.items, before.items, "Kai's items at limits 1, 3 and 20");
    assert.deepEqual(after.novaItems, before.novaItems, "Nova's items (her claim and big commit are hidden)");
    assert.deepEqual(after.calls, before.calls);
    assert.doesNotMatch(JSON.stringify(after.calls), FEED_STORY_HIDDEN_TEXT);
    assert.deepEqual(after.theses, before.theses, "the why on the hidden sale's commit is no thesis");
  });
});

test("T-043 hidden sales: a hidden sale never takes one of the PROFILE_CALLS_MAX call places", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    // Kai backs PROFILE_CALLS_MAX more shown sales, all older than his commits to the hidden ones.
    const sales = Array.from({ length: PROFILE_CALLS_MAX }, (_, n) => `0x${(0xca11000 + n).toString(16).padStart(64, "0")}`);
    await seedChainRead(admin, {
      presales: sales.map((id, n) => ({
        presale_id: id, sale_token: `${id}::coin::C${n}`, quote_type: FEED_STORY_QUOTE_TYPE, sale_symbol: `C${n}`, sale_name: `Call ${n}`,
        sale_icon_url: `https://i.blast.test/c${n}.png`, sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle: "open" as const,
        start_ms: NOW - 20 * 86_400_000, end_ms: NOW + 86_400_000, raise_target: "100000000000", min_commitment: "1000000", wallet_cap: null,
        total_commitments: "0", participants: 0, venue: "cetus" as const, pool_id: null, updated_checkpoint: 20_000,
      })),
      activity: sales.map((id, n) => ({
        checkpoint: 61_000 + n, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: NOW - (60 + n) * MINUTE, digest: `Fq${61_000 + n}`.padEnd(44, "1"),
        kind: "presale_commit", product: "presale" as const, actor: FEED_STORY_WALLETS.kai, tx_sender: FEED_STORY_WALLETS.kai,
        presale_id: id, coin_type: `${id}::coin::C${n}`, quote_type: FEED_STORY_QUOTE_TYPE, quote_amount: "10000000", coin_amount: null,
        quote_refund: null, usd_value: "10", usd_price_as_of_ms: NOW - 61 * MINUTE, venue: null, participants_after: null, total_commitments_after: null,
      })),
    });
    await seedHiddenSales(admin, { nowMs: NOW });
    const body = await ok<SocialProfileCalls>(await get("/api/social/profiles/kai/calls"), "profile-calls-response");
    const ids = body.calls.map((call) => call.presale.presale_id);
    // The newest PROFILE_CALLS_MAX shown sales: the story's three, then the newest of the added ones.
    assert.equal(ids.length, PROFILE_CALLS_MAX);
    assert.ok(!ids.includes(FEED_STORY_HIDDEN.excluded) && !ids.includes(FEED_STORY_HIDDEN.incomplete));
    assert.deepEqual(new Set(ids), new Set([FEED_STORY_PRESALES.migratedRecently, FEED_STORY_PRESALES.cancelled, FEED_STORY_PRESALES.open, ...sales.slice(0, PROFILE_CALLS_MAX - 3)]));
    assert.equal(body.track_record.presales_backed, PROFILE_CALLS_MAX);
  });
});


test("created presales survive migration backfill, keep private identity private, and wait for complete chain metadata", { skip }, async () => {
  await withFixture(async ({ admin, url, get }) => {
    await seedHiddenSales(admin, { nowMs: NOW });
    const P = FEED_STORY_PRESALES;
    const H = FEED_STORY_HIDDEN;
    const absent = `0x${"a".repeat(64)}`;
    const publish = async (n: number, accountId: string, presaleId: string) => {
      await admin.query(`INSERT INTO social_presale_drafts (draft_id, account_id, version, body, published_presale_id, published_at)
        VALUES ($1, $2, 1, '{}', $3, $4)`, [`00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`, accountId, presaleId, new Date(NOW - n * 1_000).toISOString()]);
    };
    await publish(1, FEED_STORY_ACCOUNTS.kai, P.pending);
    await publish(2, FEED_STORY_ACCOUNTS.kai, P.open);
    await publish(3, FEED_STORY_ACCOUNTS.kai, H.incomplete);
    await publish(4, FEED_STORY_ACCOUNTS.kai, absent);
    await publish(5, FEED_STORY_ACCOUNTS.nova, P.migratedRecently);
    const created = async (authorization: string, expected: readonly string[]) => {
      const response = await get("/api/social/me/presales/created", { authorization });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const body = await response.json();
      assert.deepEqual(body.presales.map((sale: { presale_id: string }) => sale.presale_id), expected);
      for (const sale of body.presales) assert.deepEqual(validator.validate("presale-summary", sale).errors, []);
      return body.presales;
    };
    // Publications from before the migration appear without a separate backfill job.
    const migration = (direction: string) => readFile(new URL(`../../../../../../packages/core/src/modules/database/migrations/0110_social_presale_creation_discovery.${direction}.sql`, import.meta.url), "utf8");
    await admin.query(await migration("down"));
    await admin.query(await migration("up"));
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai]);
    const mine = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
    assert.deepEqual(mine.created.map((sale) => sale.presale_id), [P.pending, P.open]);
    await created(KAI, [P.pending, P.open]);
    await created(NOVA, [P.migratedRecently]);
    await refused(await get("/api/social/me/presales/created"), 401, "unauthorized");
    const other = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: NOVA }), "me-presales-response", "private, no-store");
    assert.deepEqual(other.created.map((sale) => sale.presale_id), [P.migratedRecently]);
    await refused(await get("/api/social/me/presales"), 401, "unauthorized");
    const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "creation-discovery-replica");
    try {
      const replica = autocommitReader(replicaPool, "social");
      const config = await createSocialConfigReader(autocommitReader(admin, "social")).getSocialConfig();
      const publicFeed = await readForYouPage(replica, { config, nowMs: NOW, limit: 50, before: null, hiddenKinds: [] });
      assert.ok(publicFeed.items.every((item) => item.kind !== "presale_created"));
      assert.ok(publicFeed.items.some((item) => item.kind === "presale_opened" && item.presale?.presale_id === P.open));
      const thresholds = { bigCommitUsd: config.big_commit_usd, bigTradeUsd: config.big_trade_usd };
      assert.ok((await presalePostEntriesOf(replica, "all", thresholds, { limit: 50 })).every((entry) => entry.kind !== "presale_created"));
      assert.equal(await isVisible(replica, `l:${P.pending}:created`, thresholds), false);
      assert.equal(await visibleEntry(replica, `l:${P.pending}:created`, thresholds), null);
      await assert.rejects(replicaPool.query("SELECT body FROM social_presale_drafts"), /permission denied/);
      const safe = await replicaPool.query("SELECT * FROM social_published_presales LIMIT 1");
      assert.deepEqual(safe.fields.map((field) => field.name), ["presale_id", "published_at_ms"]);
      // Future chain-native creation events use the same id, without a second announcement.
      await admin.query(`INSERT INTO blast_infra_fixture.presale_lifecycle (presale_id, state, digest, timestamp_ms, checkpoint)
        VALUES ($1, 'created', 'ChainCreation', $2, 1)`, [P.pending, NOW - 2_000]);
      assert.equal((await replicaPool.query("SELECT count(*)::int AS n FROM social_feed_entries WHERE entry_id = $1", [`l:${P.pending}:created`])).rows[0].n, 1);
      assert.equal(await isVisible(replica, `l:${P.pending}:created`, thresholds), false);
      // The incomplete sale appears once real metadata arrives; no draft values substitute for chain amounts.
      await admin.query("UPDATE blast_infra_fixture.presales SET sale_symbol = 'INC', sale_name = 'Incomplete', sale_icon_url = '', sale_decimals = 9 WHERE presale_id = $1", [H.incomplete]);
      const refreshed = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
      assert.deepEqual(refreshed.created.map((sale) => sale.presale_id), [P.pending, P.open, H.incomplete]);
      // Chain-native sales are also ours, using all linked wallet kinds and refusing contested ownership.
      await admin.query("UPDATE blast_infra_fixture.presales SET creator = $1 WHERE presale_id = ANY($2::text[])", [FEED_STORY_WALLETS.kai, [P.pending, P.funded]]);
      await admin.query("UPDATE blast_infra_fixture.presales SET creator = $1 WHERE presale_id = $2", [FEED_STORY_WALLETS.nova, P.cancelled]);
      const contested = `0x${"c".repeat(64)}`;
      await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, now())", [contested, FEED_STORY_ACCOUNTS.kai]);
      await admin.query("INSERT INTO presale_embedded_wallets (privy_did, address, resolved_at) VALUES ('did:privy:feed-story-nova', $1, now())", [contested]);
      await admin.query("UPDATE blast_infra_fixture.presales SET creator = $1 WHERE presale_id = $2", [contested, P.migratedLongAgo]);
      const chainMine = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
      assert.deepEqual(chainMine.created.map((sale) => sale.presale_id), [P.pending, P.open, H.incomplete, P.funded]);
      await created(KAI, chainMine.created.map((sale) => sale.presale_id));
      const chainOther = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: NOVA }), "me-presales-response", "private, no-store");
      assert.deepEqual(chainOther.created.map((sale) => sale.presale_id), [P.migratedRecently, P.cancelled]);
      await created(NOVA, chainOther.created.map((sale) => sale.presale_id));
      await admin.query("DELETE FROM social_account_wallets WHERE account_id = $1 AND address = $2", [FEED_STORY_ACCOUNTS.kai, FEED_STORY_WALLETS.kai]);
      const unlinked = await ok<SocialMePresales>(await get("/api/social/me/presales", { authorization: KAI }), "me-presales-response", "private, no-store");
      await created(KAI, unlinked.created.map((sale) => sale.presale_id));
      assert.deepEqual(unlinked.created.map((sale) => sale.presale_id), [P.pending, P.open, H.incomplete], "verified publications survive unlinking the creator wallet");
    } finally {
      await replicaPool.end();
    }
  });
});

test("social callsigns can change without moving the account; previous names remain owned and readable", { skip }, async () => {
  await withFixture(async ({ admin, get, editGet, editPut, follow }) => {
    await admin.query("INSERT INTO social_blocked_terms (term, added_by) VALUES ('scam', 'test')");
    const before = (await admin.query<{ account_id: string }>("SELECT account_id FROM social_accounts WHERE callsign = 'kai'")).rows[0]!;
    const edit = await ok<SocialProfileEdit>(await editGet("/api/social/me/profile", { authorization: KAI }), "profile-edit-response", "private, no-store");
    assert.equal(edit.callsign_editable, true);
    await refused(await editPut({ callsign: "quinn" }, { authorization: KAI }), 409, "callsign_taken");
    await refused(await editPut({ callsign: "x" }, { authorization: KAI }), 422, "invalid_callsign");
    await refused(await editPut({ callsign: "scam_pilot" }, { authorization: KAI }), 422, "blocked_term");
    const updated = await ok<SocialProfileEdit>(await editPut({ callsign: "Kai_New", display_name: "Kai New" }, { authorization: KAI }), "profile-edit-response", "private, no-store");
    assert.equal(updated.callsign, "kai_new");
    for (const callsign of ["kai", "kai_new"]) {
      const profile = await ok<SocialProfile>(await get(`/api/social/profiles/${callsign}`), "profile-response");
      assert.equal(profile.callsign, "kai_new");
    }
    assert.equal((await admin.query("SELECT account_id FROM social_callsign_aliases WHERE callsign = 'kai'")).rows[0].account_id, before.account_id);
    assert.equal((await follow("kai", NOVA)).status, 204);
    assert.equal((await admin.query("SELECT account_id FROM social_accounts WHERE callsign = 'kai_new'")).rows[0].account_id, before.account_id);
    // The previous name remains valid for its owner, and cannot be reassigned to another account.
    await ok(await editPut({ callsign: "kai" }, { authorization: KAI }), "profile-edit-response", "private, no-store");
    await refused(await editPut({ callsign: "kai_new" }, { authorization: NOVA }), 409, "callsign_taken");
    await assert.rejects(admin.query(
      "INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES (gen_random_uuid(), 'did:privy:alias-takeover', 'kai_new')",
    ), (error: unknown) => error instanceof DatabaseError && error.constraint === "social_accounts_callsign_taken");
    const member = await ok<SocialProfileEdit>(await editGet("/api/social/me/profile", { authorization: bearer("did:privy:quinn") }), "profile-edit-response", "private, no-store");
    assert.equal(member.callsign_editable, false);
    await refused(await editPut({ callsign: "quinn_new" }, { authorization: bearer("did:privy:quinn") }), 400, "invalid_request");
  });
});

test("configured owner photo uploads normalize PNG, JPEG and WebP and reload through the profile client", { skip }, async () => {
  await withFixture(async ({ profileApi, get, storedImages }) => {
    const { default: sharp } = await import("sharp");
    for (const format of ["png", "jpeg", "webp"] as const) {
      const source = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ff4c98" } })
        .withMetadata({ exif: { IFD0: { Copyright: "fixture metadata" } } }).toFormat(format).toBuffer();
      const uploaded = await uploadProfilePicture(profileApi, new Blob([new Uint8Array(source)], { type: `image/${format}` }));
      assert.equal(uploaded.status, "ok");
      if (uploaded.status !== "ok") throw new Error("owner upload refused");
      assert.equal(uploaded.body.picture, "upload");
      const url = uploaded.body.avatar_url!;
      assert.match(url, /^https:\/\/blob\.blast\.test\/social-pictures\/[0-9a-f]{64}\.webp$/);
      const stored = storedImages.get(new URL(url).pathname.slice(1));
      assert.ok(stored);
      const metadata = await sharp(stored).metadata();
      assert.deepEqual([metadata.format, metadata.width, metadata.height], ["webp", 400, 400]);
      for (const key of ["exif", "icc", "xmp", "iptc"] as const) assert.equal(metadata[key], undefined);
      const reloaded = await fetchProfileEdit(profileApi);
      assert.equal(reloaded.status, "ok");
      if (reloaded.status === "ok") assert.equal(reloaded.body.avatar_url, url);
      assert.equal((await ok<SocialProfile>(await get("/api/social/profiles/kai"), "profile-response")).avatar_url, url);
      assert.equal((await ok<SocialProfile>(await get("/api/social/profiles/nova"), "profile-response")).avatar_url, null);
    }
  });
});

test("refused images and failed public storage leave the owner's current photo intact and permit retry", { skip }, async () => {
  await withFixture(async ({ profileApi, picture, stored, setStorageFailure }) => {
    const image = new Blob([new Uint8Array(await png(100, 100))], { type: "image/png" });
    const original = await uploadProfilePicture(profileApi, image);
    assert.equal(original.status, "ok");
    if (original.status !== "ok") throw new Error("fixture photo upload refused");
    setStorageFailure(true);
    const { default: sharp } = await import("sharp");
    const replacement = new Blob([new Uint8Array(await sharp({ create: { width: 120, height: 80, channels: 3, background: "#3366ff" } }).png().toBuffer())], { type: "image/png" });
    await refused(await picture(await png(100, 100), "image/png"), 401, "unauthorized");
    await refused(await picture(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", { authorization: KAI }), 422, "invalid_image");
    const failed = await uploadProfilePicture(profileApi, replacement);
    assert.equal(failed.status, "refused");
    if (failed.status === "refused") assert.equal(failed.code, "picture_upload_unavailable");
    assert.equal(stored.length, 1);
    const reloaded = await fetchProfileEdit(profileApi);
    assert.equal(reloaded.status, "ok");
    if (reloaded.status === "ok") assert.deepEqual([reloaded.body.picture, reloaded.body.avatar_url], [original.body.picture, original.body.avatar_url]);
    setStorageFailure(false);
    const retried = await uploadProfilePicture(profileApi, replacement);
    assert.equal(retried.status, "ok");
    if (retried.status === "ok") assert.notEqual(retried.body.avatar_url, original.body.avatar_url);
  });
});
