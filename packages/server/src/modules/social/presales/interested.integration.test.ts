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
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import type {
  PresaleListStatus,
  SocialPresaleDetail,
  SocialPresaleListPage,
  SocialPresaleSummary,
  SocialPresaleViewerResponse,
} from "@blast/core/modules/social/contracts/presales.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialFollowRoutes } from "@blast/server/modules/social/follows/route.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { PRESALE_STORY_ACCOUNTS, seedPresaleStory, type PresaleStory, type PresaleStoryPerson } from "../../../../../core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialPresaleRoutes } from "@blast/server/modules/social/presales/route.ts";
import { readSummaries } from "@blast/server/modules/social/presales/summary.ts";

/**
 * R3-29: the interested count. `interested` is a sale's current presale
 * follows, one per account (the follows primary key), in the public presale
 * payload of every lifecycle: the list (`GET /api/social/presales`) and the
 * sale (`GET /api/social/presales/{id}`). The follows are written through the
 * real follow routes on the primary (`blast_web`); the presale routes read on
 * the replica role (`blast_replica`), as in production.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-interested-app";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 10_000 };
const NOW = Date.UTC(2026, 9, 3, 18);
/** The public reads' header, spelled out so a change to the shared constant fails here too (AC-5). */
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=20";
/** The gate's seeded figure (`4,020 interested`), here as real follows. */
const CROWD = 4_020;

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}
const as = (person: PresaleStoryPerson) => bearer(`did:privy:presale-story-${person}`);
const crowdId = (n: number) => `00000000-0000-4000-8000-${(0x50000 + n).toString(16).padStart(12, "0")}`;

type Fixture = Readonly<{
  admin: Pool;
  story: PresaleStory;
  replica: ReadableDatabase;
  /** A public read, as a visitor (no token) or with a signed-in account's token. */
  list(query: string, token?: string): Promise<Response>;
  presale(id: string, token?: string): Promise<Response>;
  viewer(token: string, body: unknown): Promise<Response>;
  follow(method: "PUT" | "DELETE", presaleId: string, token: string): Promise<void>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 12 });
  await admin.query(advanceWatermark(70_000, 0, "market"));
  await admin.query(`UPDATE watermarks SET timestamp_ms_hi_inclusive = ${NOW} WHERE pipeline IN ('market', 'presale')`);
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-interested-web");
  const replicaPool = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-interested-replica");
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: "social-interested-pepper-0123456789abcdef" }),
      accounts: new PostgresSocialAccounts(() => web),
      primary: () => web,
    });
    const replica = autocommitReader(replicaPool, "social");
    const presales = createSocialPresaleRoutes({
      kit,
      database: () => replica,
      config: async () => SOCIAL_CONFIG_DEFAULTS,
      terms: async () => null,
      now: () => NOW,
    });
    const follows = createSocialFollowRoutes({ kit });
    const headers = (token?: string): Record<string, string> =>
      token ? { "x-forwarded-for": "203.0.113.29", authorization: token } : { "x-forwarded-for": "203.0.113.29" };
    await run({
      admin,
      story,
      replica,
      list: (query, token) => presales.list.GET(new Request(`${ORIGIN}/api/social/presales${query}`, { headers: headers(token) }), testClient()),
      presale: (id, token) => presales.presale.GET(new Request(`${ORIGIN}/api/social/presales/${id}`, { headers: headers(token) }), testClient()),
      viewer: (token, body) =>
        presales.viewer.POST(new Request(`${ORIGIN}/api/social/presales/viewer`, {
          method: "POST",
          headers: { ...headers(token), "content-type": "application/json" },
          body: JSON.stringify(body),
        }), testClient()),
      async follow(method, presaleId, token) {
        const response = await follows.presale[method](
          new Request(`${ORIGIN}/api/social/follows/presale/${presaleId}`, { method, headers: headers(token) }), testClient()
        );
        assert.equal(response.status, 204, `${method} follow: ${await response.text()}`);
      },
    });
  } finally {
    await Promise.all([admin.end(), web.end(), replicaPool.end()]);
    await database.drop();
  }
}

/** A public 200: schema-valid, with the public read's cache header (AC-3, AC-5). */
async function publicBody<T>(response: Response, schema: "presale-list-page" | "presale-detail"): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), schema === "presale-detail" ? "no-store" : PUBLIC_CACHE);
  assert.equal(response.headers.get("set-cookie"), null);
  return body as T;
}

/** A body without its one read-time field (`as_of.lag_ms`, the watermark's age when read). */
function settled<T extends { as_of: { lag_ms: number } }>(body: T): T {
  return { ...body, as_of: { ...body.as_of, lag_ms: 0 } };
}

/** Every sale of a tab, by name. */
async function tab(fixture: Fixture, status: PresaleListStatus, token?: string): Promise<Map<string, SocialPresaleSummary>> {
  const page = await publicBody<SocialPresaleListPage>(await fixture.list(`?status=${status}&limit=50`, token), "presale-list-page");
  return new Map(page.presales.map((row) => [row.name, row]));
}

async function interestedOf(fixture: Fixture, presaleId: string, token?: string): Promise<{ list: number; sale: number }> {
  const sale = await publicBody<SocialPresaleDetail>(await fixture.presale(presaleId, token), "presale-detail");
  const statuses: PresaleListStatus[] = ["live", "upcoming", "ended"];
  const rows = (await Promise.all(statuses.map((status) => tab(fixture, status, token)))).flatMap((rows) => [...rows.values()]);
  const row = rows.find((candidate) => candidate.presale_id === presaleId);
  assert.ok(row, `${presaleId} is in a tab`);
  return { list: row.interested, sale: sale.presale.interested };
}

test("R3-29-AC-1: three followers read 3, one unfollow reads 2, none reads 0; every lifecycle carries an integer", { skip }, () =>
  withFixture(async (fixture) => {
    const { story, follow } = fixture;
    // Every sale of every tab, before anyone new follows: Kai follows Meridian (open) and Cobalt (funded) in the story.
    const expected: Record<string, number> = { Tidal: 0, Meridian: 1, Sable: 0, Ondine: 0, Cobalt: 1, Kestrel: 0, Lumen: 0, Halcyon: 0 };
    const phases = new Set<string>();
    for (const status of ["live", "upcoming", "ended"] as const) {
      for (const [name, row] of await tab(fixture, status)) {
        assert.ok(Number.isInteger(row.interested) && row.interested >= 0, `${name}: ${String(row.interested)}`);
        assert.equal(row.interested, expected[name], name);
        phases.add(row.phase);
      }
    }
    assert.deepEqual([...phases].sort(), ["cancelled", "funded", "open", "pending", "trading"]);

    const sable = story.presaleIds.SABL;
    assert.deepEqual(await interestedOf(fixture, sable), { list: 0, sale: 0 });
    for (const person of ["luca", "mira", "ana"] as const) await follow("PUT", sable, as(person));
    // One row per account per sale: a repeated follow changes nothing.
    await follow("PUT", sable, as("luca"));
    assert.deepEqual(await interestedOf(fixture, sable), { list: 3, sale: 3 });

    // An unfollow between two reads decrements; a repeated unfollow changes nothing.
    await follow("DELETE", sable, as("mira"));
    assert.deepEqual(await interestedOf(fixture, sable), { list: 2, sale: 2 });
    await follow("DELETE", sable, as("mira"));
    assert.deepEqual(await interestedOf(fixture, sable), { list: 2, sale: 2 });

    // Served for every lifecycle, not only pending: a trading and a cancelled sale count their follows too.
    await follow("PUT", story.presaleIds.KSTL, as("theo"));
    await follow("PUT", story.presaleIds.HLCN, as("theo"));
    await follow("PUT", story.presaleIds.HLCN, as("omar"));
    assert.deepEqual(await interestedOf(fixture, story.presaleIds.KSTL), { list: 1, sale: 1 });
    assert.deepEqual(await interestedOf(fixture, story.presaleIds.HLCN), { list: 2, sale: 2 });
  }));

test("R3-29: 4,020 follows read 4,020 and lead the upcoming tab's interest order; a follow never outlives its account", { skip }, () =>
  withFixture(async (fixture) => {
    const { admin, story, follow } = fixture;
    const ondine = story.presaleIds.ONDN;
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign)
       SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(${0x50000} + n), 12, '0'))::uuid, 'did:privy:interested-' || n, 'interested_' || n
       FROM generate_series(1, ${CROWD}) n`,
    );
    await admin.query(
      `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
       SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(${0x50000} + n), 12, '0'))::uuid, 'presale', $1, 'user'
       FROM generate_series(1, ${CROWD}) n`,
      [ondine],
    );
    await follow("PUT", story.presaleIds.SABL, as("luca"));
    assert.deepEqual(await interestedOf(fixture, ondine), { list: CROWD, sale: CROWD });
    const byInterest = await publicBody<SocialPresaleListPage>(await fixture.list("?status=upcoming&sort=interest"), "presale-list-page");
    assert.deepEqual(byInterest.presales.map((row) => [row.name, row.interested]), [["Ondine", CROWD], ["Sable", 1]]);

    // No account can be deleted while it follows (the follows' foreign key), so a deleted
    // account's follow is never counted; its follows go first, and the count drops with them.
    await assert.rejects(admin.query("DELETE FROM social_accounts WHERE account_id = $1", [crowdId(1)]), {
      code: "23503",
      constraint: "social_follows_follower_account_id_fkey",
    });
    await admin.query("DELETE FROM social_follows WHERE follower_account_id = $1", [crowdId(1)]);
    await admin.query("DELETE FROM social_accounts WHERE account_id = $1", [crowdId(1)]);
    assert.deepEqual(await interestedOf(fixture, ondine), { list: CROWD - 1, sale: CROWD - 1 });
  }));

test("R3-29-AC-2/AC-5: a visitor and a signed-in reader get the same public body, naming no additional follower", { skip }, () =>
  withFixture(async (fixture) => {
    const { story, follow, presale, list, viewer } = fixture;
    const sable = story.presaleIds.SABL;
    const before = settled(await publicBody<SocialPresaleDetail>(await presale(sable), "presale-detail"));
    const upcomingBefore = await (await list("?status=upcoming")).text();
    for (const person of ["luca", "mira", "ana"] as const) await follow("PUT", sable, as(person));

    // The same figure, and the same bytes, for a visitor, a follower and an account that does not follow.
    const visitor = settled(await publicBody<SocialPresaleDetail>(await presale(sable), "presale-detail"));
    assert.equal(visitor.presale.interested, 3);
    for (const token of [as("luca"), as("kai")]) {
      assert.deepEqual(settled(await publicBody<SocialPresaleDetail>(await presale(sable, token), "presale-detail")), visitor);
    }
    for (const query of ["?status=upcoming", "?status=upcoming&sort=interest", "?status=live", "?status=ended"]) {
      const anonymous = settled(await publicBody<SocialPresaleListPage>(await list(query), "presale-list-page"));
      for (const token of [as("luca"), as("kai")]) {
        assert.deepEqual(settled(await publicBody<SocialPresaleListPage>(await list(query, token), "presale-list-page")), anonymous, query);
      }
    }

    // The follows add a number and nothing else: no handle, avatar, account id or viewer part.
    assert.deepEqual({ ...visitor, presale: { ...visitor.presale, interested: 0 } }, before);
    const upcoming = await (await list("?status=upcoming")).text();
    const sale = await (await presale(sable)).text();
    for (const person of ["luca", "mira", "ana"] as const) {
      for (const identity of [PRESALE_STORY_ACCOUNTS[person], `did:privy:presale-story-${person}`]) {
        assert.ok(!upcoming.includes(identity) && !sale.includes(identity), identity);
      }
    }
    for (const callsign of ["lucaromano", "mirachen", "anasouza"]) {
      // Public creator handles may already be present; following adds no identities.
      assert.equal(upcoming.split(callsign).length, upcomingBefore.split(callsign).length, callsign);
      assert.equal(sale.split(callsign).length, JSON.stringify(before).split(callsign).length, callsign);
    }

    // The viewer's own follow state is not in the personal presale read either; it stays in viewer-state.
    const mine = await viewer(as("luca"), { presale_ids: [sable] });
    const personal = (await mine.json()) as SocialPresaleViewerResponse;
    assert.equal(mine.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(personal.presales[sable], { following: [], following_total_usd: "0.00", following_total_atoms: "0", mine: null });
  }));

test("R3-29-AC-4: the count reads the follows by social_follows_target_idx, inside the one summary statement", { skip }, () =>
  withFixture(async ({ admin, story, replica }) => {
    const statements: { text: string; values: readonly unknown[] }[] = [];
    const capturing: ReadableDatabase = {
      read: (text, values = []) => {
        statements.push({ text, values });
        return replica.read(text, values);
      },
    } as ReadableDatabase;
    const rows = await readSummaries(capturing, Object.values(story.presaleIds));
    assert.equal(rows.length, Object.keys(story.presaleIds).length);
    assert.equal(statements.length, 1, "one statement for every sale's row and count");
    const client = await admin.connect();
    try {
      // The fixture is tiny, so the planner would scan it whole; at scale the index is the only sane path.
      await client.query("SET enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${statements[0]!.text}`, [...statements[0]!.values]);
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
      assert.match(text, /Index (Only )?Scan using social_follows_target_idx on social_follows/);
    } finally {
      client.release();
    }
  }));
