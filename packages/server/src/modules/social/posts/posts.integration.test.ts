import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { SOCIAL_FEED_NEW_MAX, type SocialFeedNewResponse, type SocialFeedPage } from "@blast/core/modules/social/contracts/feed.ts";
import { entryIdOfPost, postIdOf, socialItemPath, socialReactionPath, type SocialItemResponse } from "@blast/core/modules/social/contracts/item-routes.ts";
import type { FeedItem } from "@blast/core/modules/social/contracts/items.ts";
import { createSocialValidator, type SocialSchemaName } from "@blast/core/modules/social/contracts/validate.ts";
import type { SocialViewerStateResponse } from "@blast/core/modules/social/contracts/viewer-state.ts";
import {
  FEED_STORY_ACCOUNTS,
  FEED_STORY_HIDDEN,
  FEED_STORY_PRESALES,
  FEED_STORY_QUOTE_TYPE,
  FEED_STORY_WALLETS,
  seedFeedStory,
  seedHiddenSales,
  type FeedStory,
} from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialFeedRoute } from "@blast/server/modules/social/feed/route.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialViewerStateRoute } from "@blast/server/modules/social/viewer-state/route.ts";
import { createSocialPostRoutes } from "@blast/server/modules/social/posts/route.ts";

/**
 * Social-feed UI-02/03 backend over a disposable database with the fixture
 * `chain_read_v1` and the feed story: T-010 (rocket reactions: AC-073 to
 * AC-075, AC-126), the post permalink item read, the "N new posts" count
 * (T-012's read), calls with their multiple (OA-9), verified actors (OA-8),
 * the named backers of presale posts and the viewer's followed backers.
 * Public reads run as `blast_replica`; reactions, viewer state and the rate
 * limiter as `blast_web` on the primary, as in production.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-posts-app";
const PEPPER = "social-posts-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const NOW = Date.now();
const MINUTE = 60_000;
const PUBLIC = "public, s-maxage=10, stale-while-revalidate=20";
const SALE_TOKEN = `${FEED_STORY_PRESALES.migratedRecently}::coin::MIGR`;

const did = (callsign: string) => `did:privy:feed-story-${callsign}`;

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

type Fixture = Readonly<{
  admin: Pool;
  story: FeedStory;
  replica: ReadableDatabase;
  /** Kai's commit to the recently migrated presale, which is a call. */
  callId: string;
  react(method: "PUT" | "DELETE", entryId: string, reaction: string, callsign: string | null, raw?: string): Promise<Response>;
  item(entryIdOrPath: string, headers?: Record<string, string>, hidden?: boolean): Promise<Response>;
  feed(query?: string, hidden?: boolean): Promise<Response>;
  fresh(query: string): Promise<Response>;
  viewerState(callsign: string, body: unknown): Promise<Response>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, filler = 0): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedFeedStory(admin, { nowMs: NOW, filler });
  // OA-9: Kai committed $500 to MIGR before it launched; its presale price is
  // 0.0005 USDC (raise 100,000 USDC for 200M tokens) and the coin trades at 0.0021.
  const commit = {
    checkpoint: 39_000, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: NOW - 26 * MINUTE, digest: "FsCall".padEnd(44, "1"),
    kind: "presale_commit", product: "presale" as const, actor: FEED_STORY_WALLETS.kai, tx_sender: FEED_STORY_WALLETS.kai,
    presale_id: FEED_STORY_PRESALES.migratedRecently, coin_type: SALE_TOKEN, quote_type: FEED_STORY_QUOTE_TYPE,
    quote_amount: "500000000", coin_amount: null, quote_refund: null, usd_value: "500", usd_price_as_of_ms: NOW - 27 * MINUTE,
    venue: null, participants_after: 10, total_commitments_after: "500000000",
  };
  await seedChainRead(admin, {
    activity: [commit],
    // The presale price is what buyers paid, from the sale's claims: $50 for 100,000 tokens is 0.0005.
    presale_positions: [{
      presale_id: FEED_STORY_PRESALES.migratedRecently, wallet: FEED_STORY_WALLETS.anon, commitment: "50000000", last_commit_ms: NOW - 4 * 86_400_000,
      claim_digest: "ClPosts".padEnd(44, "1"), claimed_tokens: "100000000000000", claimed_quote_refund: "0", claimed_ms: NOW - 86_400_000,
    }],
    prices: [
      { coin_type: SALE_TOKEN, usd_price: "0.0021", as_of_ms: NOW - 5_000, source: "pool" },
      { coin_type: FEED_STORY_QUOTE_TYPE, usd_price: "1", as_of_ms: NOW - 5_000, source: "pyth" },
    ],
  });
  const callId = "a:39000:0:0:0";

  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-posts-replica");
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-posts-web");
  try {
    assert.equal((await replicaPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const replica = autocommitReader(replicaPool, "social");
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"), { now: () => 0 });
    // Two kits: trades shown, and hidden as for an outsider while trading is off.
    const kitWith = (trading: boolean) => createSocialRouteKit({
      tradingVisible: () => trading,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
    });
    const hidden = { kit: kitWith(false), database: () => replica, config: reader.getSocialConfig, now: () => NOW };
    const all = { ...hidden, kit: kitWith(true) };
    const hiddenPosts = createSocialPostRoutes(hidden);
    const allPosts = createSocialPostRoutes(all);
    const hiddenFeed = createSocialFeedRoute(hidden);
    const allFeed = createSocialFeedRoute(all);
    const viewerState = createSocialViewerStateRoute({ kit: hidden.kit });
    const headersOf = (callsign: string | null): Record<string, string> =>
      callsign ? { authorization: bearer(callsign.startsWith("did:") ? callsign : did(callsign)) } : {};
    await run({
      admin,
      story,
      replica,
      callId,
      react: (method, entryId, reaction, callsign, raw) =>
        hiddenPosts.reaction[method](new Request(`${ORIGIN}${raw ?? socialReactionPath(entryId, reaction)}`, { method, headers: headersOf(callsign) }), testClient()),
      item: (entryIdOrPath, headers = {}, hidden = true) =>
        (hidden ? hiddenPosts : allPosts).item.GET(new Request(
          `${ORIGIN}${entryIdOrPath.startsWith("/") ? entryIdOrPath : socialItemPath(entryIdOrPath)}`,
          { headers: { "x-forwarded-for": "203.0.113.9", ...headers } },
        ), testClient("203.0.113.9")),
      feed: (query = "", hidden = true) =>
        (hidden ? hiddenFeed : allFeed).GET(new Request(`${ORIGIN}/api/social/feed${query}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), testClient("203.0.113.9")),
      fresh: (query) => hiddenFeed.NEW(new Request(`${ORIGIN}/api/social/feed/new${query}`, { headers: { "x-forwarded-for": "203.0.113.9" } }), testClient("203.0.113.9")),
      viewerState: (callsign, body) =>
        viewerState.POST(new Request(`${ORIGIN}/api/social/viewer-state`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headersOf(callsign) },
          body: JSON.stringify(body),
        }), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function ok<Body>(response: Response, schema: SocialSchemaName, cache = PUBLIC): Promise<Body> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), cache);
  assert.ok(response.headers.get("x-request-id"));
  return body as Body;
}

async function refused(response: Response, status: number, code: string, extra: Record<string, unknown> = {}): Promise<void> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  for (const [key, value] of Object.entries(extra)) assert.equal(body.error[key], value, key);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  if (status === 429 || status === 503) assert.ok(Number(response.headers.get("retry-after")) > 0);
}

async function noContent(response: Response, label: string): Promise<void> {
  const text = await response.text();
  assert.equal(response.status, 204, `${label}: ${text}`);
  assert.equal(text, "");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

async function rows(admin: Pool, entryId: string): Promise<string[]> {
  const result = await admin.query<{ who: string }>(
    `SELECT a.callsign || ':' || r.reaction AS who FROM social_reactions r JOIN social_accounts a USING (account_id)
     WHERE r.entry_id = $1 ORDER BY 1`,
    [entryId],
  );
  return result.rows.map((row) => row.who);
}

const itemOf = async (response: Response) => (await ok<SocialItemResponse>(response, "item-response")).item;

test("T-010-AC-1 (AC-073): PUT twice then DELETE twice is 204 each time, one row after the PUTs and none after", { skip }, () =>
  withFixture(async ({ admin, story, react }) => {
    const entry = story.ids.novaPlainCommit;
    assert.deepEqual(await rows(admin, entry), []);
    await noContent(await react("PUT", entry, "rocket", "kai"), "first PUT");
    await noContent(await react("PUT", entry, "rocket", "kai"), "second PUT");
    assert.deepEqual(await rows(admin, entry), ["kai:rocket"]);
    await noContent(await react("DELETE", entry, "rocket", "kai"), "first DELETE");
    await noContent(await react("DELETE", entry, "rocket", "kai"), "second DELETE");
    assert.deepEqual(await rows(admin, entry), []);
    // Ten concurrent PUTs store one row.
    const answers = await Promise.all(Array.from({ length: 10 }, () => react("PUT", entry, "rocket", "nova")));
    for (const answer of answers) await noContent(answer, "concurrent PUT");
    assert.deepEqual(await rows(admin, entry), ["nova:rocket"]);
  }));

test("T-010-AC-2 (AC-074): an unconfigured key is 422, an invisible entry 404, a malformed one 400; nothing is stored", { skip }, () =>
  withFixture(async ({ admin, story, react }) => {
    const entry = story.ids.novaPlainCommit;
    // OA-5: the rocket is the only configured key; `fire` has stored rows from before but is no longer accepted.
    for (const key of ["fire", "heart", "eyes"]) {
      await refused(await react("PUT", entry, key, "kai"), 422, "invalid_reaction");
      await refused(await react("DELETE", entry, key, "kai"), 422, "invalid_reaction");
    }
    // Unnamed small commits (an unowned wallet, a private account, a never-onboarded one) are not visible.
    for (const name of ["anonSmallOpen", "ghostSmallCommit", "lateSmallCommit"] as const) {
      await refused(await react("PUT", story.ids[name], "rocket", "kai"), 404, "not_found");
    }
    await refused(await react("PUT", "a:1:0:0:0", "rocket", "kai"), 404, "not_found");
    await refused(await react("PUT", `l:${FEED_STORY_PRESALES.open}:migrated`, "rocket", "kai"), 404, "not_found");
    // Presale posts are visible whoever made them: a lifecycle post and an unnamed big commit.
    await noContent(await react("PUT", story.ids.openOpened, "rocket", "kai"), "lifecycle post");
    await noContent(await react("PUT", story.ids.anonBigOpen, "rocket", "kai"), "big unnamed commit");
    // Malformed path parameters name the parameter.
    const base = "/api/social/items/";
    for (const [raw, parameter] of [
      [`${base}x%3A1/reactions/rocket`, "entry_id"],
      [`${base}/reactions/rocket`, "entry_id"],
      [`${base}a%3A1%3A0%3A0%3A0/reactions/Rocket`, "reaction"],
      [`${base}a%3A1%3A0%3A0%3A0/reactions/`, "reaction"],
      [`${base}a%3A1%3A0%3A0%3A0/reactions/rocket/x`, "entry_id"],
      [`${base}a%3A1%3A0%3A0%3A0/likes/rocket`, "entry_id"],
      [`${base}%E0%A4%A/reactions/rocket`, "entry_id"],
    ] as const) {
      await refused(await react("PUT", "", "", "kai", raw), 400, "invalid_parameter", { parameter });
    }
    // A visitor and a signed-in caller without an account.
    await refused(await react("PUT", entry, "rocket", null), 401, "unauthorized");
    await refused(await react("PUT", entry, "rocket", "did:privy:nobody-here"), 409, "account_required");
    assert.deepEqual(await rows(admin, entry), []);
    assert.deepEqual(await rows(admin, story.ids.anonSmallOpen), []);
  }));

test("T-010-AC-3 (AC-075): counts equal stored rockets for everyone; viewer state returns the caller's own keys", { skip }, () =>
  withFixture(async ({ story, react, item, feed, viewerState }) => {
    const entry = story.ids.novaPlainCommit;
    for (const callsign of ["kai", "nova", "mallory"]) await noContent(await react("PUT", entry, "rocket", callsign), callsign);
    const shown = await itemOf(await item(entry));
    assert.deepEqual(shown.reactions, { rocket: 3 });
    const page = await ok<SocialFeedPage>(await feed("?limit=50"), "feed-page");
    assert.deepEqual(page.items.find((candidate) => candidate.entry_id === entry)?.reactions, { rocket: 3 });
    // Mallory's stored `fire` on Kai's why commit is kept but no longer shown or counted.
    assert.deepEqual(page.items.find((candidate) => candidate.entry_id === story.ids.kaiWhyCommit)?.reactions, { rocket: 1 });
    const kai = await ok<SocialViewerStateResponse>(
      await viewerState("kai", { entry_ids: [entry, story.ids.kaiWhyCommit] }),
      "viewer-state-response",
      "private, no-store",
    );
    assert.deepEqual(kai.reactions, { [entry]: ["rocket"], [story.ids.kaiWhyCommit]: [] });
    await noContent(await react("DELETE", entry, "rocket", "kai"), "unreact");
    assert.deepEqual((await itemOf(await item(entry))).reactions, { rocket: 2 });
    const after = await ok<SocialViewerStateResponse>(await viewerState("kai", { entry_ids: [entry] }), "viewer-state-response", "private, no-store");
    assert.deepEqual(after.reactions, { [entry]: [] });
  }));

test("T-010-AC-4 (AC-126): past 240 reaction writes a minute the next is rate_limited with Retry-After, per account", { skip }, () =>
  withFixture(async ({ admin, story, react }) => {
    const entry = story.ids.novaPlainCommit;
    // The limiter's windows are fixed minutes: start with at least 25 s left so all 241 writes share one.
    const into = Date.now() % 60_000;
    if (into > 35_000) await new Promise((resolve) => setTimeout(resolve, 60_000 - into + 100));
    for (let n = 0; n < 240; n += 1) {
      const response = await react(n % 2 === 0 ? "PUT" : "DELETE", entry, "rocket", "mallory");
      assert.equal(response.status, 204, `request ${n}`);
    }
    await refused(await react("PUT", entry, "rocket", "mallory"), 429, "rate_limited");
    assert.deepEqual(await rows(admin, entry), []);
    await noContent(await react("PUT", entry, "rocket", "kai"), "another account");
  }));

test("UI-03: a post permalink's item is public, the same for every caller, and only for visible entries", { skip }, () =>
  withFixture(async ({ admin, story, item }) => {
    const entry = story.ids.kaiWhyCommit;
    // The permalink id is reversible and stable.
    assert.equal(postIdOf(entry), entry.replaceAll(":", "-"));
    assert.equal(entryIdOfPost(postIdOf(entry)), entry);
    assert.equal(entryIdOfPost(postIdOf(story.ids.openOpened)), story.ids.openOpened);
    for (const bad of ["", "a:1:0:0:0", "x-1", "a-", "a-1 2"]) assert.equal(entryIdOfPost(bad), null, bad);

    const visitor = await item(entry);
    const text = await visitor.clone().text();
    const shown = await itemOf(visitor);
    assert.equal(shown.entry_id, entry);
    // OA-8 and OA-4: verified and the `/@` path.
    assert.deepEqual(shown.actor, {
      type: "account", callsign: "kai", display_name: "Kai", avatar_url: null, x_handle: "kai_x", verified: true, path: "/@kai",
    });
    for (const authorization of [bearer(did("nova")), "Bearer not-a-token"]) {
      const signedIn = await item(entry, { authorization });
      assert.equal((await signedIn.clone().text()).replace(/"lag_ms":\d+/, ""), text.replace(/"lag_ms":\d+/, ""));
      await itemOf(signedIn);
    }
    // A raw `:` in the path works as well as `%3A`.
    assert.equal((await itemOf(await item(`/api/social/items/${entry}`))).entry_id, entry);
    // Not visible, unknown or malformed.
    await refused(await item(story.ids.ghostSmallCommit), 404, "not_found");
    await refused(await item("a:1:0:0:0"), 404, "not_found");
    await refused(await item("/api/social/items/nope"), 400, "invalid_parameter", { parameter: "entry_id" });
    await refused(await item("/api/social/items/a%3A1%3A0%3A0%3A0/x"), 400, "invalid_parameter", { parameter: "entry_id" });
    // OA-7: a trade is not found while trading is hidden, and shown when it is not.
    await refused(await item(story.ids.kaiBuy), 404, "not_found");
    assert.equal((await itemOf(await item(story.ids.kaiBuy, {}, false))).kind, "trade_buy");
    // Lifecycle and milestone posts.
    assert.equal((await itemOf(await item(story.ids.milestone))).kind, "milestone_participants");
    // Without a readable watermark: 503.
    await admin.query("DELETE FROM watermarks");
    await refused(await item(entry), 503, "service_unavailable");
  }));

test("UI-02 (OA-7): the home feed leaves the trade kinds out while trading is hidden, and keeps pages full", { skip }, () =>
  withFixture(async ({ feed }) => {
    const all = await ok<SocialFeedPage>(await feed("?limit=50", false), "feed-page");
    const hidden = await ok<SocialFeedPage>(await feed("?limit=50"), "feed-page");
    assert.ok(all.items.some((candidate) => candidate.kind.startsWith("trade_")));
    assert.ok(!hidden.items.some((candidate) => candidate.kind.startsWith("trade_")));
    assert.deepEqual(
      hidden.items.map((candidate) => candidate.entry_id),
      all.items.filter((candidate) => !candidate.kind.startsWith("trade_")).map((candidate) => candidate.entry_id),
    );
    // A small page is filled from the next candidates, not left short.
    const two = await ok<SocialFeedPage>(await feed("?limit=2"), "feed-page");
    assert.equal(two.items.length, 2);
  }));

test("T-012 read: the new-items count is For You items newer than since, capped, with the newest named faces", { skip }, () =>
  withFixture(async ({ fresh, feed }) => {
    const page = await ok<SocialFeedPage>(await feed("?limit=50"), "feed-page");
    const newer = (since: number) => page.items.filter((candidate) => candidate.occurred_at_ms > since)
      .sort((a, b) => b.occurred_at_ms - a.occurred_at_ms || (a.entry_id < b.entry_id ? 1 : -1));
    for (const minutes of [0, 11, 26, 46, 61, 200]) {
      const since = NOW - minutes * MINUTE;
      const body = await ok<SocialFeedNewResponse>(await fresh(`?since=${since}`), "feed-new-response");
      const expected = newer(since);
      assert.equal(body.count, expected.length, `${minutes} min`);
      assert.equal(body.more, false);
      const faces = [...new Set(expected.flatMap((candidate) => (candidate.actor?.type === "account" ? [candidate.actor.callsign] : [])))].slice(0, 3);
      assert.deepEqual(body.actors.map((actor) => actor.callsign), faces, `${minutes} min`);
    }
    // A newer reader sees nothing new; trades never count while hidden.
    assert.equal((await ok<SocialFeedNewResponse>(await fresh(`?since=${NOW}`), "feed-new-response")).count, 0);
    // Faces carry the public identity only.
    const any = await ok<SocialFeedNewResponse>(await fresh(`?since=${NOW - 200 * MINUTE}`), "feed-new-response");
    for (const actor of any.actors) assert.deepEqual(Object.keys(actor).sort(), ["avatar_url", "callsign", "display_name"]);
    // `since` is required, once, a non-negative integer.
    for (const query of ["", "?since=", "?since=abc", "?since=-1", "?since=1.5", "?since=1e3", `?since=${NOW}&since=${NOW}`, "?since=99999999999999999"]) {
      await refused(await fresh(query), 400, "invalid_parameter", { parameter: "since" });
    }
  }));

test("T-012 read: the count stops at its cap and says there is more", { skip }, () =>
  withFixture(async ({ fresh }) => {
    const body = await ok<SocialFeedNewResponse>(await fresh("?since=0"), "feed-new-response");
    assert.equal(body.count, SOCIAL_FEED_NEW_MAX);
    assert.equal(body.more, true);
    assert.equal(body.actors.length, 3);
  }, 60));

test("UI-03 (OA-9): a named commit of a migrated presale is a call with its multiple; claims are worth the coin's price", { skip }, () =>
  withFixture(async ({ admin, callId, item }) => {
    const call = await itemOf(await item(callId));
    assert.equal(call.call, true);
    assert.equal(call.presale?.lifecycle, "migrated");
    assert.equal(call.presale?.venue, "cetus");
    assert.deepEqual(call.presale?.market, { presale_price_usd: "0.0005", price_usd: "0.0021", price_as_of_ms: NOW - 5_000, multiple: "4.2000" });
    assert.equal(call.do_the_same?.label, "View presale");
    // A stale coin price: still a call, without a result.
    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1 WHERE coin_type = $2", [NOW - 121_000, SALE_TOKEN]);
    const stale = await itemOf(await item(callId));
    assert.equal(stale.call, true);
    assert.deepEqual(stale.presale?.market, { presale_price_usd: "0.0005", price_usd: null, price_as_of_ms: null, multiple: null });
    // Before the sale's first claim there is no presale price.
    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1 WHERE coin_type = $2", [NOW - 1_000, SALE_TOKEN]);
    await admin.query(`UPDATE blast_infra_fixture.presale_positions
      SET claim_digest = NULL, claimed_tokens = NULL, claimed_quote_refund = NULL, claimed_ms = NULL`);
    const unknown = await itemOf(await item(callId));
    assert.deepEqual([unknown.presale?.market?.presale_price_usd, unknown.presale?.market?.price_usd, unknown.presale?.market?.multiple], [null, "0.0021", null]);
  }));

test("UI-03: presale posts carry their named backers (the naming rule), and viewer state the ones the caller follows", { skip }, () =>
  withFixture(async ({ admin, story, item, viewerState }) => {
    const opened = await itemOf(await item(story.ids.openOpened));
    // Kai $110 (four named commits, one older than the For You window), then Nova and Mallory at $20 each, the later first.
    // Never the private, the never-onboarded or the unowned wallet.
    assert.deepEqual(opened.backers?.map((backer) => [backer.callsign, backer.usd, backer.path, backer.verified]), [
      ["kai", "110.00", "/@kai", true], ["nova", "20.00", "/@nova", true], ["mallory", "20.00", "/@mallory", true],
    ]);
    assert.equal(opened.presale?.participants, 0);
    // Person items carry none.
    assert.equal((await itemOf(await item(story.ids.kaiWhyCommit))).backers, null);

    // Nova follows Kai: one followed backer of OPEN, none of FUND.
    await admin.query(
      "INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'account', $2, 'user')",
      [FEED_STORY_ACCOUNTS.nova, FEED_STORY_ACCOUNTS.kai],
    );
    const state = await ok<SocialViewerStateResponse>(
      await viewerState("nova", { backers_of: [FEED_STORY_PRESALES.open, FEED_STORY_PRESALES.funded] }),
      "viewer-state-response",
      "private, no-store",
    );
    assert.deepEqual(state.backers, {
      [FEED_STORY_PRESALES.open]: {
        count: 1,
        accounts: [{ callsign: "kai", display_name: "Kai", avatar_url: null, verified: true, path: "/@kai", usd: "110.00" }],
      },
      [FEED_STORY_PRESALES.funded]: { count: 0, accounts: [] },
    });
    // Once Kai goes private, he is neither a public nor a followed backer.
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai]);
    const hidden = await itemOf(await item(story.ids.openOpened));
    assert.deepEqual(hidden.backers?.map((backer) => backer.callsign), ["nova", "mallory"]);
    const after = await ok<SocialViewerStateResponse>(
      await viewerState("nova", { backers_of: [FEED_STORY_PRESALES.open] }),
      "viewer-state-response",
      "private, no-store",
    );
    assert.deepEqual(after.backers, { [FEED_STORY_PRESALES.open]: { count: 0, accounts: [] } });
    // The list is bounded like the others.
    const many = Array.from({ length: 51 }, (_, n) => `0x${n.toString(16).padStart(64, "0")}`);
    await refused(await viewerState("nova", { backers_of: many }), 400, "invalid_request");
  }));

test("UI-03 (OA-8): verified means X linked, on items, for members and new accounts", { skip }, () =>
  withFixture(async ({ admin, story, item }) => {
    const kai = await itemOf(await item(story.ids.kaiWhyCommit));
    assert.equal((kai.actor as Extract<FeedItem["actor"], { type: "account" }>).verified, true);
    await admin.query("UPDATE social_accounts SET x_subject = NULL WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai]);
    const unlinked = await itemOf(await item(story.ids.kaiWhyCommit));
    assert.equal((unlinked.actor as Extract<FeedItem["actor"], { type: "account" }>).verified, false);
  }));

/**
 * T-043 hidden sales (`seedHiddenSales`): every entry of the excluded test
 * sale (no `presales` row, its activity kept) and of the sale with no coin
 * metadata, whatever its kind: named person entries, big ones, trades, an
 * unnamed big commit, the incomplete sale's lifecycle post and both sales'
 * milestone posts.
 */
test("T-043 hidden sales: no permalink, reaction or followed-backer face for a hidden sale's entry", { skip }, () =>
  withFixture(async ({ admin, item, react, viewerState }) => {
    const hidden = await seedHiddenSales(admin, { nowMs: NOW });
    for (const [name, entryId] of Object.entries(hidden.ids)) {
      for (const tradingVisible of [false, true]) {
        const response = await item(entryId, {}, !tradingVisible);
        assert.equal(response.status, 404, `${name} (trading ${tradingVisible ? "visible" : "hidden"}): ${await response.clone().text()}`);
        await refused(response, 404, "not_found");
      }
      await refused(await react("PUT", entryId, "rocket", "nova"), 404, "not_found");
      assert.deepEqual(await rows(admin, entryId), [], `${name}: nothing stored`);
    }
    // Nova follows Kai and Kai committed to both hidden sales: still no face, as for an unknown sale.
    await admin.query(
      "INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'account', $2, 'user')",
      [FEED_STORY_ACCOUNTS.nova, FEED_STORY_ACCOUNTS.kai],
    );
    const state = await ok<SocialViewerStateResponse>(
      await viewerState("nova", { backers_of: [FEED_STORY_HIDDEN.excluded, FEED_STORY_HIDDEN.incomplete, FEED_STORY_PRESALES.open] }),
      "viewer-state-response",
      "private, no-store",
    );
    assert.deepEqual(state.backers[FEED_STORY_HIDDEN.excluded], { count: 0, accounts: [] });
    assert.deepEqual(state.backers[FEED_STORY_HIDDEN.incomplete], { count: 0, accounts: [] });
    assert.equal(state.backers[FEED_STORY_PRESALES.open]?.accounts[0]?.callsign, "kai", "a shown sale's followed backer is unchanged");
  }));
