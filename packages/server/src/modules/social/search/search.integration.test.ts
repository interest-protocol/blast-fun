import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialSearchResponse } from "@blast/core/modules/social/contracts/search.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { PRESALE_STORY_ACCOUNTS, seedPresaleStory, type PresaleStory } from "../../../../../core/test/fixtures/modules/social/presales/presale-story.ts";
import { SOCIAL_PUBLIC_CACHE_CONTROL, createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialSearchRoutes } from "@blast/server/modules/social/search/route.ts";
import { readPresaleListPage } from "@blast/server/modules/social/presales/route.ts";
import { readTradeCoinPage } from "@blast/server/modules/social/trades/coin-list.ts";
import { uuid } from "../../../../../core/test/kit.ts";

/**
 * UI-12 (§12): the public search route over the design's sample sales and
 * people (`presale-story.ts`), plus Mission Control members with and without
 * an account row, a member whose Blast name replaced the profile's, and a
 * private account. Reads run as the replica role (`blast_replica`).
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 4, statementTimeoutMs: 5_000 };
const NOW = Date.UTC(2026, 9, 3, 18);
const validator = createSocialValidator();

const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** A Mission Control member's profile (an X account is required there, so members are verified). */
async function insertProfile(admin: Pool, n: number, callsign: string, displayName: string | null): Promise<string> {
  const profileId = uuid(0x7000 + n);
  await admin.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, display_name,
       disclosure_version, disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'fixture-v1', now())`,
    [profileId, `did:privy:search-member-${n}`, `x-search-${n}`, wallet(0x7000 + n), `wallet-${n}`, callsign, displayName],
  );
  return profileId;
}

type Fixture = Readonly<{ admin: Pool; story: PresaleStory; replicaDb: ReadableDatabase; search(query?: string): Promise<Response> }>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 5 });
  await admin.query(advanceWatermark(70_000, 0, "market"));
  await admin.query(`UPDATE watermarks SET timestamp_ms_hi_inclusive = ${NOW} WHERE pipeline IN ('market', 'presale')`);
  // A member who never opened Blast (no account row), one whose Blast name replaced the profile's, a private account.
  await insertProfile(admin, 1, "lucacrew", "Luca Crew");
  const renamed = await insertProfile(admin, 2, "novastar", "Old Name");
  await admin.query("INSERT INTO social_accounts (account_id, profile_id, display_name) VALUES ($1, $2, 'Nova Star')", [uuid(0x7102), renamed]);
  const hidden = await insertProfile(admin, 3, "lucahidden", "Luca Hidden");
  await admin.query("INSERT INTO social_accounts (account_id, profile_id, privacy) VALUES ($1, $2, 'private')", [uuid(0x7103), hidden]);
  await admin.query(
    "INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy) VALUES ($1, 'did:privy:search-private', 'lucasecret', 'Luca Secret', 'private')",
    [uuid(0x7104)],
  );
  // The operator's default follows: the suggestions when nothing is typed.
  await admin.query("INSERT INTO social_default_accounts (position, account_id) VALUES (1, $1), (2, $2)", [PRESALE_STORY_ACCOUNTS.mira, PRESALE_STORY_ACCOUNTS.luca]);
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-search-web");
  const replica = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-search-replica");
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: async () => {
        throw new Error("search never reads the caller");
      },
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: "social-search-pepper-0123456789abcdef0" }),
      accounts: new PostgresSocialAccounts(() => web),
      primary: () => web,
    });
    const replicaDb = autocommitReader(replica, "social");
    const routes = createSocialSearchRoutes({ kit, database: () => replicaDb, now: () => NOW });
    await run({
      admin,
      story,
      replicaDb,
      search: (query) =>
        routes.search.GET(new Request(`${ORIGIN}/api/social/search${query === undefined ? "" : `?${query}`}`, {
          headers: { "x-forwarded-for": "203.0.113.12", authorization: "Bearer ignored" },
        }), testClient("203.0.113.12")),
    });
  } finally {
    await Promise.all([admin.end(), web.end(), replica.end()]);
    await database.drop();
  }
}

async function answer(response: Response): Promise<SocialSearchResponse> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("search-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), SOCIAL_PUBLIC_CACHE_CONTROL);
  return body as SocialSearchResponse;
}

const names = (body: SocialSearchResponse) => body.presales.map((presale) => `${presale.name}:${presale.phase}`);
const callsigns = (body: SocialSearchResponse) => body.people.map((person) => person.callsign);

test("UI-12 (§12): presales by name or symbol, people by callsign or name, private accounts never", { skip }, () =>
  withFixture(async ({ admin, search }) => {
    // The design's keyboard shot: "me" finds Meridian (a prefix) before Lumen (inside the name).
    const me = await answer(await search("q=me"));
    assert.equal(me.query, "me");
    assert.deepEqual(names(me), ["Meridian:open", "Lumen:trading"]);

    // Symbols too, case and a leading "$" aside.
    assert.deepEqual(names(await answer(await search("q=%24kstl"))), ["Kestrel:trading"]);

    // "luca": callsign prefixes first (shortest first), then a name prefix; private accounts never.
    const luca = await answer(await search("q=Luca"));
    assert.deepEqual(callsigns(luca), ["lucacrew", "lucaromano"]);
    const crew = luca.people[0]!;
    assert.deepEqual(crew, { callsign: "lucacrew", display_name: "Luca Crew", avatar_url: null, verified: true });
    assert.equal(luca.people[1]!.display_name, "Luca Romano");

    // "@" before a callsign is dropped; an exact callsign leads.
    assert.deepEqual(callsigns(await answer(await search("q=%40lucaromano"))), ["lucaromano"]);
    // A name word in the middle ("romano").
    assert.deepEqual(callsigns(await answer(await search("q=romano"))), ["lucaromano"]);

    // A member's Blast name replaced the profile's: the new one finds it once, the old one never.
    const nova = await answer(await search("q=nova"));
    assert.deepEqual(nova.people, [{ callsign: "novastar", display_name: "Nova Star", avatar_url: null, verified: true }]);
    assert.deepEqual(callsigns(await answer(await search("q=old+name"))), []);

    // Private accounts (a member's and a new account's) are never answered, by name or callsign.
    for (const term of ["lucahidden", "luca+hidden", "lucasecret", "secret"]) {
      assert.deepEqual(callsigns(await answer(await search(`q=${term}`))), [], term);
    }

    // LIKE wildcards are literal: "_" and "%" match nothing here.
    const wild = await answer(await search("q=_"));
    assert.deepEqual([wild.presales.length, wild.people.length], [0, 0]);
    const percent = await answer(await search("q=%25"));
    assert.deepEqual([percent.presales.length, percent.people.length], [0, 0]);

    // No match: both groups empty (the sheet says "No presales or people match …").
    const none = await answer(await search("q=zzzz"));
    assert.deepEqual([none.presales, none.people], [[], []]);

    // A coin published with a blank name and logo still answers the search, found by its symbol.
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_name = '', sale_icon_url = '' WHERE sale_symbol = 'KSTL'");
    const bare = await answer(await search("q=kstl"));
    assert.deepEqual(bare.presales.map((presale) => [presale.symbol, presale.name, presale.icon_url]), [["KSTL", "", ""]]);
  }));

test("UI-12 (§12): suggestions without a term; at most five presales and six people; bad terms refused", { skip }, () =>
  withFixture(async ({ admin, search }) => {
    // Nothing typed: live by closing time (Tidal closes first), then upcoming by opening, then the latest to end.
    const empty = await answer(await search());
    assert.equal(empty.query, "");
    assert.deepEqual(names(empty), ["Tidal:open", "Meridian:open", "Sable:pending", "Ondine:pending", "Cobalt:funded"]);
    // People: the default follows in their order.
    assert.deepEqual(callsigns(empty), ["mirachen", "lucaromano"]);
    assert.deepEqual(callsigns(await answer(await search("q=+++"))), ["mirachen", "lucaromano"]);

    // A popular term: five presales, six people (one spare for the viewer to be dropped in the browser).
    for (let n = 0; n < 8; n += 1) {
      await admin.query(
        "INSERT INTO social_accounts (account_id, privy_did, callsign, display_name) VALUES ($1, $2, $3, 'Zed Many')",
        [uuid(0x7200 + n), `did:privy:search-many-${n}`, `zed_${n}x`],
      );
    }
    const zed = await answer(await search("q=zed"));
    assert.equal(zed.people.length, 6);
    assert.deepEqual(callsigns(zed), ["zed_0x", "zed_1x", "zed_2x", "zed_3x", "zed_4x", "zed_5x"]);
    assert.equal((await answer(await search("q=a"))).presales.length, 5);

    // Two terms, or one longer than 64 characters: invalid_parameter (q), never cached.
    for (const query of ["q=a&q=b", `q=${"x".repeat(65)}`]) {
      const refused = await search(query);
      assert.equal(refused.status, 400);
      assert.equal(refused.headers.get("cache-control"), "no-store");
      assert.deepEqual(((await refused.json()) as { error: { code: string; parameter: string } }).error.parameter, "q");
    }
  }));

test("UI-12: the people match goes through the trigram indexes (0072)", { skip }, () =>
  withFixture(async ({ admin }) => {
    await admin.query("SET enable_seqscan = off");
    const plan = await admin.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT callsign FROM social_account_search WHERE haystack LIKE '%romano%'`,
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(text, /social_accounts_search_trgm_idx/);
    assert.match(text, /social_profiles_search_trgm_idx/);
    await admin.query("RESET enable_seqscan");
  }));

test("public market reads exclude test quotes before limiting results or counting pages", { skip }, (t) =>
  withFixture(async ({ admin, story, replicaDb, search }) => {
    await admin.query(
      "UPDATE blast_infra_fixture.presales SET quote_type = $1, quote_symbol = 'TEST_SUI' WHERE presale_id = $2",
      [CREATE_TEST_SUI_QUOTE_TYPE, story.presaleIds.TIDE],
    );

    await t.test("presale search and suggestions skip a test sale before selecting results", async () => {
      assert.deepEqual(names(await answer(await search("q=tidal"))), []);
      const suggestions = await answer(await search());
      assert.equal(suggestions.presales.length, 5);
      assert.equal(suggestions.presales[0]?.name, "Meridian");
    });

    await t.test("presale tab counts and cursors describe visible markets", async () => {
      const page = await readPresaleListPage(replicaDb, { status: "live", sort: "ending", cursor: null, limit: 1 }, NOW);
      assert.deepEqual([page.status_counts?.live, page.next_cursor, page.presales.map((sale) => sale.presale_id)],
        [1, null, [story.presaleIds.MRDN]]);
    });

    await t.test("coin picker hides a test market in text and exact type lookups", async () => {
      const named = await readTradeCoinPage(replicaDb, { q: "tidal", cursor: null, limit: 1 }, NOW);
      assert.deepEqual(named, { coins: [], next_cursor: null });
      const exact = await readTradeCoinPage(replicaDb, { q: story.saleTokens.TIDE!, cursor: null, limit: 1 }, NOW);
      assert.deepEqual(exact, { coins: [], next_cursor: null });
    });
  }));
