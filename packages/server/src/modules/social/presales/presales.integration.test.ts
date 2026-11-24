import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import type { PresaleTerms } from "@blast/core/modules/presale/terms/index.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import type {
  SocialPresaleDetail,
  SocialPresaleListPage,
  SocialPresaleViewerResponse,
} from "@blast/core/modules/social/contracts/presales.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SOCIAL_PUBLIC_CACHE_CONTROL, createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { qsRaised, quoteOf } from "@blast/core/lib/format.ts";
import { PRESALE_STORY_ACCOUNTS, PRESALE_STORY_WALLETS, seedPresaleStory, type PresaleStory } from "../../../../../core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialPresaleRoutes } from "@blast/server/modules/social/presales/route.ts";
import { createPresaleFollowReader } from "@blast/server/modules/social/presales/follow-reader.ts";
import { readViewerPresales } from "@blast/server/modules/social/presales/viewer.ts";
import { createAdminPresaleRoute } from "@blast/server/modules/social/admin-presales/route.ts";
import { optionalSource } from "@blast/server/modules/social/optional-source.ts";
import { readHappening } from "@blast/server/modules/social/happening/read.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";
import { PRESALE_BACKER_SAMPLE_COMMITS, PRESALE_COMMIT_FIELDS_HEADER, PRESALE_LIST_SORTS } from "@blast/core/modules/social/contracts/presales.ts";
import { readBackerSamples } from "@blast/server/modules/social/presales/backer-sample.ts";

/**
 * UI-09/10: the presale list, sale and viewer routes over the design's sample
 * sales (`presale-story.ts`). Public reads run as the replica role
 * (`blast_replica`), the kit as the web role.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-presales-app";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.UTC(2026, 9, 3, 18);

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI = bearer("did:privy:presale-story-kai");
const STRANGER = bearer("did:privy:nobody-here");

/** Meridian's terms as the projection would answer them: 45% to buyers, 30% to the pool, 20% team, 5% treasury. */
function meridianTerms(presaleId: string): PresaleTerms {
  const team = `0x${"7ea".padStart(64, "0")}`;
  return {
    presaleId,
    raiseTarget: "250000000000",
    supply: {
      total: "1000000000000000000",
      participants: { bps: 4500, amount: "450000000000000000" },
      liquidity: { bps: 3000, amount: "300000000000000000" },
      recipients: [{ address: team, bps: 2000, amount: "200000000000000000" }, { address: `0x${"7eb".padStart(64, "0")}`, bps: 500, amount: "50000000000000000" }],
      protocol: { bps: 0, amount: "0" },
    },
    raise: { poolShare: "187500000000", recipients: [{ address: team, bps: 2300, amount: "57500000000" }], protocol: { bps: 200, amount: "5000000000" } },
    eligibility: { kind: "open" },
    burnable: false,
    hardCap: false,
    eligibleUncappedFromMs: NOW + 3_600_000,
    // Its Cetus pool's 0.25% tier, as blast-infra's `pool_tier.fee_rate` gives it.
    poolFeePpm: 2_500,
  };
}

type Fixture = Readonly<{
  admin: Pool;
  story: PresaleStory;
  list(query?: string): Promise<Response>;
  featured(): Promise<Response>;
  happening(): Promise<SocialHappeningResponse>;
  pin(id: string, pinned: boolean): Promise<Response>;
  adminList(query?: string): Promise<Response>;
  presale(id: string, extraHeaders?: Record<string, string>): Promise<Response>;
  viewer(token: string, body: unknown, extraHeaders?: Record<string, string>): Promise<Response>;
  termsCalls: string[];
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, seed: Readonly<{ sui?: boolean }> = {}): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 40, ...seed });
  await admin.query(advanceWatermark(70_000, 0, "market"));
  await admin.query(`UPDATE watermarks SET timestamp_ms_hi_inclusive = ${NOW} WHERE pipeline IN ('market', 'presale')`);
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-presales-web");
  const replica = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-presales-replica");
  const termsCalls: string[] = [];
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: "social-presales-pepper-0123456789abcdef" }),
      accounts: new PostgresSocialAccounts(() => web),
      primary: () => web,
    });
    const replicaDb = autocommitReader(replica, "social");
    const routes = createSocialPresaleRoutes({
      kit,
      database: () => replicaDb,
      followingDatabase: createPresaleFollowReader(replica, { fleetSlots: 1, processSlots: 1 }),
      config: async () => SOCIAL_CONFIG_DEFAULTS,
      terms: (presaleId) => optionalSource("presale_terms", async () => {
        termsCalls.push(presaleId);
        if (presaleId === story.presaleIds.HLCN) throw new Error("projection down");
        return presaleId === story.presaleIds.MRDN ? meridianTerms(presaleId) : null;
      }, null),
      now: () => NOW,
      blastWallet: async () => PRESALE_STORY_WALLETS.kai,
    });
    const headers = { "x-forwarded-for": "203.0.113.9" };
    const adminRoute = createAdminPresaleRoute(() => web, () => NOW);
    await run({
      admin,
      story,
      termsCalls,
      featured: () => routes.featured.GET(new Request(`${ORIGIN}/api/social/presales/featured`, { headers }), testClient()),
      happening: () => readHappening(replicaDb, { config: SOCIAL_CONFIG_DEFAULTS, nowMs: NOW, hiddenKinds: [] }),
      adminList: (query = "") => adminRoute(new Request(`${ORIGIN}/api/admin/presales${query}`)),
      pin: (id, pinned) => adminRoute(new Request(`${ORIGIN}/api/admin/presales`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ presale_id: id, pinned }),
      })),
      list: (query = "") => routes.list.GET(new Request(`${ORIGIN}/api/social/presales${query}`, { headers }), testClient()),
      presale: (id, extraHeaders) => routes.presale.GET(new Request(`${ORIGIN}/api/social/presales/${id}`, { headers: { ...headers, ...extraHeaders } }), testClient()),
      viewer: (token, body, extraHeaders) =>
        routes.viewer.POST(new Request(`${ORIGIN}/api/social/presales/viewer`, {
          method: "POST",
          headers: { ...headers, ...extraHeaders, authorization: token, "content-type": "application/json" },
          body: JSON.stringify(body),
        }), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), web.end(), replica.end()]);
    await database.drop();
  }
}

async function ok<T>(response: Response, schema: Parameters<typeof validator.validate>[0], cacheControl: string): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), cacheControl);
  return body as T;
}

async function refused(response: Response, status: number, code: string, parameter?: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string; parameter?: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  if (parameter) assert.equal(body.error.parameter, parameter);
  assert.ok(["no-store", "private, no-store"].includes(response.headers.get("cache-control") ?? ""));
}

async function paginatedPartnerIds(
  read: (query: string) => Promise<SocialPresaleListPage>,
  query: URLSearchParams,
  expectedCount: number,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    if (cursor) query.set("cursor", cursor);
    const page = await read(`?${query}`);
    ids.push(...page.presales.map((sale) => sale.presale_id));
    assert.ok(ids.length <= expectedCount, "pagination must not repeat or include a different partner");
    cursor = page.next_cursor;
  } while (cursor);
  return ids;
}

test("partner-filtered pages preserve all lifecycle/sort orders without other partners or null partners", { skip }, () =>
  withFixture(async ({ admin, list }) => {
    const partnerA = `0x${"a".repeat(64)}`;
    const partnerB = `0x${"b".repeat(64)}`;
    const selected = new Set<string>();
    const read = async (query: string) => ok<SocialPresaleListPage>(await list(query), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    for (const status of ["live", "upcoming", "ended"] as const) {
      const baseline = await read(`?status=${status}`);
      for (const [index, sale] of baseline.presales.entries()) {
        const partner = [partnerA, partnerB, null][index % 3];
        if (partner === partnerA) selected.add(sale.presale_id);
        await admin.query("UPDATE blast_infra_fixture.presales SET partner_id = $1 WHERE presale_id = $2", [partner, sale.presale_id]);
      }
      for (const sort of PRESALE_LIST_SORTS[status]) {
        const all = await read(`?status=${status}&sort=${sort}`);
        const expected = all.presales.filter((sale) => selected.has(sale.presale_id)).map((sale) => sale.presale_id);
        const query = new URLSearchParams({ status, sort, partner_id: partnerA, limit: "1" });
        const actual = await paginatedPartnerIds(read, query, expected.length);
        assert.deepEqual(actual, expected, `${status}/${sort}`);
      }
      assert.deepEqual((await read(`?status=${status}`)).presales.map((sale) => sale.presale_id), baseline.presales.map((sale) => sale.presale_id));
      const empty = await read(`?status=${status}&partner_id=0x${"f".repeat(64)}`);
      assert.deepEqual(empty.presales, []);
      assert.equal(empty.next_cursor, null);
    }
    for (const query of ["?partner_id=", "?partner_id=acme", `?partner_id=${partnerA}&partner_id=${partnerB}`]) {
      await refused(await list(query), 400, "invalid_parameter", "partner_id");
    }
  }),
);

test("gap 11: a facepile never names a private account or a wallet linked after its first commit", { skip }, () =>
  withFixture(async ({ admin }) => {
    const db = autocommitReader(admin, "social");
    const { rows: sales } = await admin.query<{ presale_id: string }>("SELECT presale_id FROM blast_infra_fixture.presales ORDER BY presale_id");
    const ids = sales.map((row) => row.presale_id);
    const faces = async () => new Set([...(await readBackerSamples(db, ids)).values()].flat().map((face) => face.callsign));
    const before = [...await faces()];
    assert.ok(before.length >= 2, "the story names at least two backers among the sales' latest commits");
    const [hidden, late] = before as [string, string];
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE callsign = $1", [hidden]);
    await admin.query(
      "UPDATE social_account_wallets SET verified_at = now() WHERE account_id = (SELECT account_id FROM social_accounts WHERE callsign = $1)",
      [late],
    );
    const after = await faces();
    assert.equal(after.has(hidden), false, "a private account");
    assert.equal(after.has(late), false, "a wallet linked after its first commit");
    assert.ok([...after].every((callsign) => before.includes(callsign)));
  }));

test("UI-09: each tab lists its sales in every server order, keyset paged and publicly cached", { skip }, () =>
  withFixture(async ({ list, admin }) => {
    const names = (page: SocialPresaleListPage) => page.presales.map((row) => row.name);
    const live = await ok<SocialPresaleListPage>(await list(), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.deepEqual(names(live), ["Tidal", "Meridian"]);
    // Gap 11: each card's facepile is the named people among the sale's latest commits, the latest first, one face each.
    for (const sale of live.presales) {
      const { rows } = await admin.query<{ callsign: string }>(
        `SELECT a.callsign FROM (
           SELECT c.actor, max(c.timestamp_ms) AS last_ms FROM (
             SELECT actor, timestamp_ms FROM blast_infra_fixture.activity
             WHERE presale_id = $1 AND kind = 'presale_commit' ORDER BY timestamp_ms DESC LIMIT $2
           ) c GROUP BY c.actor
         ) r JOIN social_account_wallets w ON w.address = r.actor JOIN social_accounts a ON a.account_id = w.account_id
         ORDER BY r.last_ms DESC, a.callsign LIMIT 3`,
        [sale.presale_id, PRESALE_BACKER_SAMPLE_COMMITS],
      );
      assert.deepEqual(sale.backers_sample?.map((backer) => backer.callsign), rows.map((row) => row.callsign), sale.name);
    }
    const tidal = live.presales[0];
    assert.equal(tidal.phase, "open");
    assert.equal(tidal.raised_usd, "398600.00");
    assert.equal(tidal.target_usd, "400000.00");
    assert.equal(tidal.fill_bps, 9965);
    assert.equal(names(await ok(await list("?status=live&sort=backed"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL)).length, 2);
    const fastest = await ok<SocialPresaleListPage>(await list("?sort=fastest"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.equal(fastest.presales.length, 2);

    const upcoming = await ok<SocialPresaleListPage>(await list("?status=upcoming"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.deepEqual(names(upcoming), ["Sable", "Ondine"]);
    assert.ok(upcoming.presales.every((row) => row.phase === "pending" && row.raised_usd === "0.00"));
    const interest = await ok<SocialPresaleListPage>(await list("?status=upcoming&sort=interest"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.equal(interest.presales.length, 2);

    // Ended, most recent first; then by multiple: Kestrel (4.2x) above Lumen (0.6x), unknown multiples last.
    const ended = await ok<SocialPresaleListPage>(await list("?status=ended"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.deepEqual(names(ended), ["Cobalt", "Halcyon", "Kestrel", "Lumen"]);
    const best = await ok<SocialPresaleListPage>(await list("?status=ended&sort=best"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.deepEqual(names(best).slice(0, 2), ["Kestrel", "Lumen"]);
    const kestrel = best.presales[0];
    assert.equal(kestrel.phase, "trading");
    assert.equal(kestrel.price_usd, "0.0021");
    assert.equal(Number(kestrel.presale_price_usd).toFixed(4), "0.0005");
    assert.equal(kestrel.multiple, "4.2");
    assert.equal(best.presales.find((row) => row.name === "Cobalt")?.phase, "funded");
    assert.equal(best.presales.find((row) => row.name === "Halcyon")?.phase, "cancelled");

    // Keyset: two pages of two hold the four ended sales once each, in order.
    const first = await ok<SocialPresaleListPage>(await list("?status=ended&limit=2"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.ok(first.next_cursor);
    const second = await ok<SocialPresaleListPage>(
      await list(`?status=ended&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`),
      "presale-list-page",
      SOCIAL_PUBLIC_CACHE_CONTROL,
    );
    assert.deepEqual([...names(first), ...names(second)], names(ended));
    assert.equal(second.next_cursor, null);

    await refused(await list("?status=soon"), 400, "invalid_parameter", "status");
    await refused(await list("?status=upcoming&sort=ending"), 400, "invalid_parameter", "sort");
    await refused(await list("?limit=0"), 400, "invalid_parameter", "limit");
    await refused(await list("?limit=51"), 400, "invalid_parameter", "limit");
    await refused(await list("?cursor=nope"), 400, "invalid_parameter", "cursor");
    await refused(await list("?status=live&status=ended"), 400, "invalid_parameter", "status");

    // Parity: every tab's count, on every page and cursor, under the page's own filters.
    for (const page of [live, upcoming, ended, first, second]) assert.deepEqual(page.status_counts, { live: 2, upcoming: 2, ended: 4 });
    await admin.query(
      "INSERT INTO social_sale_trust (presale_id, verified_team, verified_by, verified_at_ms, updated_at_ms) VALUES ($1, true, 'fixture', $2, $2)",
      [tidal.presale_id, NOW],
    );
    const trusted = await ok<SocialPresaleListPage>(await list("?status=ended&verified_team=true"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.deepEqual(trusted.status_counts, { live: 1, upcoming: 0, ended: 0 });

    // A sale shared with its start still ahead is open on chain but upcoming (pending) until the start, and live from it.
    const meridian = live.presales.find((row) => row.name === "Meridian")!;
    await admin.query("UPDATE blast_infra_fixture.presales SET start_ms = $2 WHERE presale_id = $1", [meridian.presale_id, NOW + 3_600_000]);
    const scheduled = await ok<SocialPresaleListPage>(await list("?status=upcoming"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.deepEqual(scheduled.presales.map((row) => [row.name, row.phase]), [["Meridian", "pending"], ["Sable", "pending"], ["Ondine", "pending"]]);
    assert.deepEqual(scheduled.status_counts, { live: 1, upcoming: 3, ended: 4 });
    assert.deepEqual(names(await ok<SocialPresaleListPage>(await list(), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL)), ["Tidal"]);
  }));

test("a sale names the original creator only while their creation is public", { skip }, () =>
  withFixture(async ({ admin, story, presale }) => {
    const read = async () => ok<SocialPresaleDetail>(await presale(story.presaleIds.MRDN), "presale-detail", "no-store");
    const named = await read();
    assert.equal(named.creator?.wallet, PRESALE_STORY_WALLETS.luca);
    assert.equal(named.creator?.account?.callsign, "lucaromano");
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [PRESALE_STORY_ACCOUNTS.luca]);
    assert.deepEqual((await read()).creator, { wallet: PRESALE_STORY_WALLETS.luca, account: null });
    await admin.query("UPDATE social_accounts SET privacy = 'public', sharing_since = $2 WHERE account_id = $1", [PRESALE_STORY_ACCOUNTS.luca, new Date(NOW).toISOString()]);
    assert.equal((await read()).creator?.account, null);
    await admin.query("UPDATE social_accounts SET sharing_since = $2 WHERE account_id = $1", [PRESALE_STORY_ACCOUNTS.luca, new Date(NOW - 60 * 86_400_000).toISOString()]);
    await admin.query("UPDATE social_account_wallets SET verified_at = $2 WHERE address = $1", [PRESALE_STORY_WALLETS.luca, new Date(NOW).toISOString()]);
    assert.equal((await read()).creator?.account, null);
    await admin.query("UPDATE blast_infra_fixture.presales SET creator = $2 WHERE presale_id = $1", [story.presaleIds.MRDN, `0x${"f".repeat(64)}`]);
    assert.deepEqual((await read()).creator, { wallet: `0x${"f".repeat(64)}`, account: null });
  }));

test("UI-10: a sale page reads its figures, momentum, named backers, theses, raise and terms", { skip }, () =>
  withFixture(async ({ story, presale, termsCalls }) => {
    const mrdn = await ok<SocialPresaleDetail>(await presale(story.presaleIds.MRDN), "presale-detail", "no-store");
    assert.equal(mrdn.presale.name, "Meridian");
    assert.equal(mrdn.presale.raised_usd, "184221.00");
    assert.equal(mrdn.presale.min_commitment_usd, "10.00");
    assert.equal(mrdn.presale.wallet_cap_usd, "25000.00");
    // Named backers are named; the crowd is not. Luca is the largest wallet.
    const luca = mrdn.backers.top.find((row) => row.wallet === PRESALE_STORY_WALLETS.luca);
    assert.equal(luca?.account?.callsign, "lucaromano");
    assert.equal(luca?.account?.verified, true);
    assert.match(luca?.why ?? "", /Stablecoin FX/);
    assert.ok(mrdn.backers.top.some((row) => row.account === null));
    assert.ok(mrdn.backers.top.length <= 25);
    assert.ok(mrdn.backers.top10_bps > 0);
    // Theses: largest commit first, each with its author.
    assert.deepEqual(mrdn.theses.slice(0, 2).map((row) => row.account.callsign), ["lucaromano", "mirachen"]);
    assert.ok(mrdn.theses.every((row) => row.rockets >= 2));
    // Momentum: Mira's commit 6 minutes ago is in the 1-hour window.
    assert.ok(mrdn.momentum["1h"].commits >= 2);
    assert.ok(mrdn.momentum["1d"].commits >= mrdn.momentum["4h"].commits);
    assert.ok(mrdn.momentum["1d"].commits >= mrdn.momentum["1h"].commits);
    // The raise rises to the total; Luca's big commit is marked and named.
    const last = mrdn.raise.points.at(-1);
    assert.equal(last?.[1], "184221.00");
    assert.ok(mrdn.raise.points.length <= 160);
    assert.ok(mrdn.raise.markers.some((marker) => marker.account?.callsign === "lucaromano" && marker.commit_usd === "15000.00"));
    // Activity: named commits with their whys.
    assert.ok(mrdn.activity.some((item) => item.kind === "presale_commit" && item.actor?.type === "account"));
    // Terms: presale price 250k / 450M = $0.000556, pool opens at 187.5k / 300M = $0.000625.
    assert.equal(Number(mrdn.terms?.presale_price_usd).toFixed(6), "0.000556");
    assert.equal(Number(mrdn.terms?.launch_price_usd).toFixed(6), "0.000625");
    assert.equal(mrdn.terms?.raise.pool_bps, 7500);
    assert.equal(mrdn.terms?.eligible_uncapped_from_ms, undefined);
    const commitRead = await presale(story.presaleIds.MRDN, { [PRESALE_COMMIT_FIELDS_HEADER]: "1" });
    assert.match(commitRead.headers.get("vary") ?? "", /x-blast-presale-commit-fields/i);
    assert.equal((await ok<SocialPresaleDetail>(commitRead, "presale-detail", "no-store")).terms?.eligible_uncapped_from_ms, NOW + 3_600_000);
    assert.ok(termsCalls.includes(story.presaleIds.MRDN));

    // A trading sale: multiple from its claims (no projection terms), vesting from its schedule.
    const kstl = await ok<SocialPresaleDetail>(await presale(story.presaleIds.KSTL), "presale-detail", "no-store");
    assert.equal(kstl.terms, null);
    assert.equal(kstl.presale.multiple, "4.2");
    assert.ok(kstl.vesting && kstl.vesting.end_ms > kstl.vesting.start_ms);
    assert.equal(kstl.momentum["1h"].commits, 0);

    // The projection failing leaves the terms out, nothing else.
    const hlcn = await ok<SocialPresaleDetail>(await presale(story.presaleIds.HLCN), "presale-detail", "no-store");
    assert.equal(hlcn.terms, null);
    assert.equal(hlcn.presale.phase, "cancelled");

    // An upcoming sale has no backers, momentum or raise yet.
    const sabl = await ok<SocialPresaleDetail>(await presale(story.presaleIds.SABL), "presale-detail", "no-store");
    assert.deepEqual([sabl.backers.top.length, sabl.theses.length, sabl.raise.points.length], [0, 0, 0]);

    await refused(await presale(`0x${"f".repeat(64)}`), 404, "not_found");
    await refused(await presale("0xNOTANID"), 400, "invalid_parameter", "presale_id");
  }));

test("0098: a why on a trade's entry (event_slot u32::MAX) stores the trade's sale; the sale page, its top backers and the viewer's network show commit whys only", { skip }, () =>
  withFixture(async ({ admin, story, presale, viewer }) => {
    // T-038 writes a trade found by balance changes at event_slot 4294967295; `::integer` could not hold it.
    const trade = {
      checkpoint: 69_990, tx_slot: 7, event_slot: 4_294_967_295, part: 0, timestamp_ms: NOW - 60_000, digest: "Trd0098".padEnd(44, "1"),
      kind: "trade_buy", product: "market" as const, actor: PRESALE_STORY_WALLETS.luca, tx_sender: PRESALE_STORY_WALLETS.luca,
      presale_id: story.presaleIds.KSTL, coin_type: story.saleTokens.KSTL, quote_type: `0x${"2".padStart(64, "0")}::sui::SUI`,
      quote_amount: "1000000000", coin_amount: "500000000000", quote_refund: null, usd_value: "3.50", usd_price_as_of_ms: NOW - 61_000,
      venue: "cetus", participants_after: null, total_commitments_after: null,
    };
    await seedChainRead(admin, { activity: [trade] });
    const entry = "a:69990:7:4294967295:0";
    await admin.query(
      "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ('00000000-0000-4000-8000-000000009801', $1, $2, 'Bought the dip.')",
      [entry, PRESALE_STORY_ACCOUNTS.luca],
    );
    const stored = await admin.query<{ presale_id: string | null }>("SELECT presale_id FROM social_whys WHERE entry_id = $1", [entry]);
    assert.deepEqual(stored.rows, [{ presale_id: story.presaleIds.KSTL }]);
    // The sale page's theses read every active why of the sale by its activity row, as `bigint`: the trade's
    // why no longer breaks the read, and a thesis is still a commit's why only.
    const kstl = await ok<SocialPresaleDetail>(await presale(story.presaleIds.KSTL), "presale-detail", "no-store");
    assert.ok(!kstl.theses.some((row) => row.text === "Bought the dip."));
    assert.ok(kstl.theses.some((row) => row.account.callsign === "lucaromano"));
    // Owner, 2026-10-06: a thesis is a commit's why. The trade's why is Luca's newest on the sale, yet his top-backer
    // "why" and the "why" Kai's network shows are still his commit's.
    const luca = kstl.backers.top.find((row) => row.wallet === PRESALE_STORY_WALLETS.luca);
    assert.match(luca?.why ?? "", /^Called it at the presale/);
    const network = await ok<SocialPresaleViewerResponse>(
      await viewer(KAI, { presale_ids: [story.presaleIds.KSTL] }), "presale-viewer-response", "private, no-store",
    );
    const followed = network.presales[story.presaleIds.KSTL]!.following.find((row) => row.account.callsign === "lucaromano");
    assert.match(followed?.why ?? "", /^Called it at the presale/);
    // With the commit's why deleted, Luca has no thesis on the sale: the trade's why never stands in.
    await admin.query(
      "UPDATE social_whys SET state = 'deleted', deleted_at = now() WHERE author_account_id = $1 AND presale_id = $2 AND entry_id <> $3",
      [PRESALE_STORY_ACCOUNTS.luca, story.presaleIds.KSTL, entry],
    );
    const without = await ok<SocialPresaleDetail>(await presale(story.presaleIds.KSTL), "presale-detail", "no-store");
    assert.equal(without.backers.top.find((row) => row.wallet === PRESALE_STORY_WALLETS.luca)?.why, null);
    const networkWithout = await ok<SocialPresaleViewerResponse>(
      await viewer(KAI, { presale_ids: [story.presaleIds.KSTL] }), "presale-viewer-response", "private, no-store",
    );
    assert.equal(networkWithout.presales[story.presaleIds.KSTL]!.following.find((row) => row.account.callsign === "lucaromano")?.why, null);
  }));

test("UI-10: a private or late-sharing backer is never named, and a privacy change shows on the next read", { skip }, () =>
  withFixture(async ({ admin, story, presale }) => {
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [PRESALE_STORY_ACCOUNTS.luca]);
    const mrdn = await ok<SocialPresaleDetail>(await presale(story.presaleIds.MRDN), "presale-detail", "no-store");
    const luca = mrdn.backers.top.find((row) => row.wallet === PRESALE_STORY_WALLETS.luca);
    assert.equal(luca?.account, null);
    assert.equal(luca?.why, null);
    assert.ok(!mrdn.theses.some((row) => row.account.callsign === "lucaromano"));
    assert.ok(!mrdn.raise.markers.some((marker) => marker.account?.callsign === "lucaromano"));
    // Sharing that starts after Mira's first commit leaves her position unnamed.
    await admin.query("UPDATE social_accounts SET sharing_since = now() WHERE account_id = $1", [PRESALE_STORY_ACCOUNTS.mira]);
    const again = await ok<SocialPresaleDetail>(await presale(story.presaleIds.MRDN), "presale-detail", "no-store");
    assert.equal(again.backers.top.find((row) => row.wallet === PRESALE_STORY_WALLETS.mira)?.account ?? null, null);
  }));

test("UI-10: the viewer read names the caller's followed backers and own position, privately", { skip }, () =>
  withFixture(async ({ story, viewer, admin }) => {
    const answer = await ok<SocialPresaleViewerResponse>(
      await viewer(KAI, { presale_ids: [story.presaleIds.MRDN, story.presaleIds.SABL] }),
      "presale-viewer-response",
      "private, no-store",
    );
    const mrdn = answer.presales[story.presaleIds.MRDN];
    // Kai follows Luca, Mira, Ana, Ivy, Omar, Theo and Nadia among Meridian's backers (not himself).
    assert.deepEqual(mrdn.following.map((row) => row.account.callsign), [
      "lucaromano", "mirachen", "anasouza", "nadiapetrova", "omarhaddad", "theopark", "ivylaurent",
    ]);
    assert.equal(mrdn.following_total_usd, "20100.00");
    assert.equal(mrdn.following[0].commits.length, 1);
    assert.equal(mrdn.mine?.commitment_usd, "100.00");
    assert.equal(mrdn.mine?.claim_wallet_commitment_atoms, undefined);
    const commitRead = await viewer(KAI, { presale_ids: [story.presaleIds.MRDN] }, { [PRESALE_COMMIT_FIELDS_HEADER]: "1" });
    const commitEntry = (await ok<SocialPresaleViewerResponse>(commitRead, "presale-viewer-response", "private, no-store")).presales[story.presaleIds.MRDN];
    assert.equal(commitEntry.mine?.claim_wallet_commitment_atoms, "100000000");
    const permit = await admin.connect();
    try {
      await permit.query("BEGIN");
      await permit.query("SELECT pg_advisory_xact_lock(hashtext('blast.presale_follow_read'), 0)");
      const partial = await viewer(KAI, { presale_ids: [story.presaleIds.MRDN] }, { [PRESALE_COMMIT_FIELDS_HEADER]: "1" });
      assert.equal(partial.headers.get("X-Blast-Presale-Following"), "unavailable");
      const answer = await ok<SocialPresaleViewerResponse>(partial, "presale-viewer-response", "private, no-store");
      assert.deepEqual(answer.presales[story.presaleIds.MRDN].following, []);
      assert.deepEqual(answer.presales[story.presaleIds.MRDN].mine, commitEntry.mine);
    } finally {
      try { await permit.query("ROLLBACK"); } finally { permit.release(); }
    }
    assert.equal(mrdn.mine?.claimed, false);
    assert.equal(mrdn.mine?.claimable_tokens, null, "the live allocation is not guessed from its price");
    assert.equal(mrdn.mine?.claimed_tokens, "0");
    assert.deepEqual(answer.presales[story.presaleIds.SABL], { following: [], following_total_usd: "0.00", following_total_atoms: "0", mine: null });
    assert.equal(answer.rows, null);

    // "Backed by people you follow" on the live tab: both live sales, Meridian (7) before Tidal (4).
    const backed = await ok<SocialPresaleViewerResponse>(await viewer(KAI, { status: "live" }), "presale-viewer-response", "private, no-store");
    assert.deepEqual(backed.rows?.map((row) => row.name), ["Meridian", "Tidal"]);

    // Unfollowing shows on the next read.
    await admin.query("DELETE FROM social_follows WHERE follower_account_id = $1 AND target_id = $2", [
      PRESALE_STORY_ACCOUNTS.kai, PRESALE_STORY_ACCOUNTS.luca,
    ]);
    const after = await ok<SocialPresaleViewerResponse>(await viewer(KAI, { presale_ids: [story.presaleIds.MRDN] }), "presale-viewer-response", "private, no-store");
    assert.equal(after.presales[story.presaleIds.MRDN].following.length, 6);

    await admin.query("INSERT INTO presale_embedded_wallets (privy_did, address) VALUES ($1, $2)", [
      "did:privy:presale-story-mira", PRESALE_STORY_WALLETS.mira,
    ]);
    const withSecondLink = await ok<SocialPresaleViewerResponse>(
      await viewer(KAI, { presale_ids: [story.presaleIds.MRDN] }), "presale-viewer-response", "private, no-store",
    );
    assert.deepEqual(withSecondLink, after, "the same wallet counts once and keeps its earliest link");
    await admin.query("UPDATE social_account_wallets SET verified_at = now() WHERE address = $1", [PRESALE_STORY_WALLETS.mira]);
    const lateLink = await ok<SocialPresaleViewerResponse>(
      await viewer(KAI, { presale_ids: [story.presaleIds.MRDN] }), "presale-viewer-response", "private, no-store",
    );
    assert.equal(lateLink.presales[story.presaleIds.MRDN].following.some((row) => row.account.callsign === "mirachen"), false);

    await refused(await viewer(KAI, {}), 400, "invalid_request");
    await refused(await viewer(KAI, { presale_ids: [] }), 400, "invalid_request");
    await refused(await viewer(KAI, { presale_ids: ["0x1"] }), 400, "invalid_request");
    await refused(await viewer(KAI, { status: "live", presale_ids: [story.presaleIds.MRDN] }), 400, "invalid_request");
    await refused(await viewer(KAI, { status: "soon" }), 400, "invalid_request");
    await refused(await viewer(STRANGER, { status: "live" }), 409, "account_required");
    await refused(await viewer("", { status: "live" }), 401, "unauthorized");
  }));

test("the viewer exposes the indexed claim quantity for the signing wallet before a market price or first claim exists", { skip }, () =>
  withFixture(async ({ admin, story, viewer }) => {
    const id = story.presaleIds.KSTL;
    await admin.query(`UPDATE blast_infra_fixture.presale_positions SET claim_digest = NULL, claimed_tokens = NULL, claimable_tokens = 440000000000000000 WHERE presale_id = $1 AND wallet = $2`, [id, PRESALE_STORY_WALLETS.kai]);
    const answer = await ok<SocialPresaleViewerResponse>(await viewer(KAI, { presale_ids: [id] }), "presale-viewer-response", "private, no-store");
    assert.equal(answer.presales[id].mine?.claimable_tokens, "440000000000000000");
    assert.equal(answer.presales[id].mine?.claimed_tokens, "0");
    assert.equal(answer.presales[id].mine?.claimed, false);
    await admin.query(`UPDATE blast_infra_fixture.presale_positions SET claim_digest = NULL, claimable_tokens = 990000000000000000 WHERE presale_id = $1 AND wallet = $2`, [id, PRESALE_STORY_WALLETS.luca]);
    const combined = await readViewerPresales(autocommitReader(admin, "social"), PRESALE_STORY_ACCOUNTS.kai, [PRESALE_STORY_WALLETS.kai, PRESALE_STORY_WALLETS.luca], [id], PRESALE_STORY_WALLETS.kai);
    assert.equal(combined.presales[id].mine?.claimable_tokens, "440000000000000000", "the claim quantity belongs to the signing wallet, even with multiple owned positions");
  }));

test("T-020 alignment: a sale blast-infra has not fully resolved is in no read; a claim-only position keeps no commit time", { skip }, () =>
  withFixture(async ({ admin, story, list, presale }) => {
    const names = (page: SocialPresaleListPage) => page.presales.map((row) => row.name);

    // A position known only from its claim has no commit time; the activity
    // view still names its owner, so the backer row keeps its account.
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET last_commit_ms = NULL WHERE presale_id = $1 AND wallet = $2", [
      story.presaleIds.MRDN, PRESALE_STORY_WALLETS.luca,
    ]);
    const mrdn = await ok<SocialPresaleDetail>(await presale(story.presaleIds.MRDN), "presale-detail", "no-store");
    const luca = mrdn.backers.top.find((row) => row.wallet === PRESALE_STORY_WALLETS.luca);
    assert.equal(luca?.last_commit_ms, null);
    assert.equal(luca?.account?.callsign, "lucaromano");

    // An allowlisted sale: the contract takes any positive amount (`min_commitment` 1)
    // and no wallet cap, because each wallet's cap is its allowlist leaf's.
    await admin.query("UPDATE blast_infra_fixture.presales SET min_commitment = 1, wallet_cap = NULL WHERE presale_id = $1", [story.presaleIds.CBLT]);
    const cblt = await ok<SocialPresaleDetail>(await presale(story.presaleIds.CBLT), "presale-detail", "no-store");
    assert.equal(cblt.presale.allowlisted, true);
    assert.equal(cblt.presale.min_commitment_usd, null);
    assert.equal(cblt.presale.wallet_cap_usd, null);

    // The sale coin's metadata not seen yet (`sale_*` NULL): no amount of the sale can be shown.
    await admin.query(
      "UPDATE blast_infra_fixture.presales SET sale_symbol = NULL, sale_name = NULL, sale_icon_url = NULL, sale_decimals = NULL WHERE presale_id = $1",
      [story.presaleIds.TIDE],
    );
    // A quote the engine's quote table does not list (`quote_*` NULL): nothing can be valued.
    await admin.query("UPDATE blast_infra_fixture.presales SET quote_symbol = NULL, quote_decimals = NULL WHERE presale_id = $1", [story.presaleIds.MRDN]);
    // A migration witness that is neither Cetus's nor Bluefin's (`venue` NULL): not a Blast sale.
    await admin.query("UPDATE blast_infra_fixture.presales SET venue = NULL WHERE presale_id = $1", [story.presaleIds.KSTL]);
    // R3-40-AC-7: decimals but no quote symbol: no figure could name its unit, so the sale is on no surface either.
    // The fixture (like blast-infra's view) delivers a quote's symbol and decimals together; that promise is
    // dropped here so the guard is proven on its own.
    await admin.query(`DO $$ DECLARE c text; BEGIN
      SELECT conname INTO c FROM pg_constraint
       WHERE conrelid = 'blast_infra_fixture.presales'::regclass AND pg_get_constraintdef(oid) LIKE '%quote_symbol%';
      EXECUTE format('ALTER TABLE blast_infra_fixture.presales DROP CONSTRAINT %I', c);
    END $$`);
    await admin.query("UPDATE blast_infra_fixture.presales SET quote_symbol = NULL WHERE presale_id = $1", [story.presaleIds.SABL]);

    assert.deepEqual(names(await ok<SocialPresaleListPage>(await list(), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL)), []);
    assert.deepEqual(
      names(await ok<SocialPresaleListPage>(await list("?status=ended"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL)),
      ["Cobalt", "Halcyon", "Lumen"],
    );
    assert.deepEqual(
      names(await ok<SocialPresaleListPage>(await list("?status=upcoming"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL)),
      ["Ondine"],
    );
    for (const gone of [story.presaleIds.TIDE, story.presaleIds.MRDN, story.presaleIds.KSTL, story.presaleIds.SABL]) {
      await refused(await presale(gone), 404, "not_found");
    }
  }));

const SUI_TYPE = `0x${"2".padStart(64, "0")}::sui::SUI`;
const SUI_AS_OF = NOW - 30_000;

/** Meridian as a SUI-quoted sale: the same whole-coin figures, in SUI's nine decimals (atoms × 1,000), and a SUI price row. */
async function meridianInSui(admin: Pool, presaleId: string): Promise<void> {
  await admin.query(
    `UPDATE blast_infra_fixture.presales SET quote_type = $2, quote_symbol = 'SUI', quote_decimals = 9,
       raise_target = raise_target * 1000, min_commitment = min_commitment * 1000, wallet_cap = wallet_cap * 1000, total_commitments = total_commitments * 1000
     WHERE presale_id = $1`,
    [presaleId, SUI_TYPE],
  );
  await admin.query("UPDATE blast_infra_fixture.presale_positions SET commitment = commitment * 1000, claimed_quote_refund = claimed_quote_refund * 1000 WHERE presale_id = $1", [presaleId]);
  await admin.query("UPDATE blast_infra_fixture.activity SET quote_type = $2, quote_amount = quote_amount * 1000, quote_refund = quote_refund * 1000, total_commitments_after = total_commitments_after * 1000 WHERE presale_id = $1", [presaleId, SUI_TYPE]);
  await admin.query("INSERT INTO blast_infra_fixture.prices (coin_type, usd_price, as_of_ms, source) VALUES ($1, 3.42, $2, 'pyth')", [SUI_TYPE, SUI_AS_OF]);
}

test("R3-40-AC-1/3: a SUI-quoted sale reads in its own coin's atoms and decimals on the list, the sale page and the viewer read; a USDC sale is unchanged", { skip }, () =>
  withFixture(async ({ admin, story, list, presale, viewer }) => {
    const before = await ok<SocialPresaleDetail>(await presale(story.presaleIds.TIDE), "presale-detail", "no-store");
    await meridianInSui(admin, story.presaleIds.MRDN);

    // The list: the sale's coin, its decimals, and its target and raise in exact atoms.
    const page = await ok<SocialPresaleListPage>(await list("?status=live"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    const listed = page.presales.find((row) => row.presale_id === story.presaleIds.MRDN)!;
    assert.deepEqual(
      [listed.quote_symbol, listed.quote_decimals, listed.target_atoms, listed.raised_atoms],
      ["SUI", 9, "250000000000000", "184221000000000"],
    );

    // The sale page: its minimum and cap, the raise's points and big-commit markers, the backers, the theses, momentum and terms, all in SUI atoms.
    const mrdn = await ok<SocialPresaleDetail>(await presale(story.presaleIds.MRDN), "presale-detail", "no-store");
    assert.deepEqual([mrdn.presale.min_commitment_atoms, mrdn.presale.wallet_cap_atoms], ["10000000000", "25000000000000"]);
    assert.deepEqual(mrdn.quote_price, { usd_price: "3.42", as_of_ms: SUI_AS_OF });
    assert.equal(mrdn.raise.points.at(-1)?.[2], "184221000000000");
    assert.ok(mrdn.raise.markers.some((marker) => marker.account?.callsign === "lucaromano" && marker.commit_atoms === "15000000000000"));
    const luca = mrdn.backers.top.find((row) => row.wallet === PRESALE_STORY_WALLETS.luca)!;
    assert.equal(BigInt(luca.commitment_atoms) % 1_000n, 0n, "Luca's commitment is in SUI's nine decimals");
    assert.ok(mrdn.theses.every((thesis) => thesis.commit_atoms === null || BigInt(thesis.commit_atoms) % 1_000n === 0n));
    assert.equal(mrdn.momentum["1d"].total_atoms, mrdn.momentum["1d"].total_atoms.replace(/\D/g, ""));
    // 250,000 SUI over 450M tokens; the pool's 75% over 300M — exact, from atoms, never through a float.
    assert.equal(mrdn.terms?.presale_price_quote, "0.000555555555556");
    assert.equal(mrdn.terms?.launch_price_quote, "0.000625");
    // Gap 12: every one of the 1B tokens at the opening price, in SUI.
    assert.equal(mrdn.terms?.launch_fdv_quote, "625000");
    // The Terms card's trading fee: the Cetus pool's 0.25% tier, in millionths.
    assert.equal(mrdn.terms?.trading_fee_ppm, 2_500);
    assert.equal(mrdn.presale.presale_price_quote, "0.000555555555556");

    // The viewer read: Kai's own commitment and his followed backers' total, in SUI atoms, one unit.
    const answer = await ok<SocialPresaleViewerResponse>(await viewer(KAI, { presale_ids: [story.presaleIds.MRDN] }), "presale-viewer-response", "private, no-store");
    const entry = answer.presales[story.presaleIds.MRDN];
    assert.equal(entry.mine?.commitment_atoms, "100000000000");
    assert.equal(entry.following_total_atoms, entry.following.reduce((sum, row) => sum + BigInt(row.commitment_atoms), 0n).toString());
    assert.equal(entry.following_total_atoms, "20100000000000");

    // A USDC sale beside it reads exactly as before, with no SUI price on its page.
    const after = await ok<SocialPresaleDetail>(await presale(story.presaleIds.TIDE), "presale-detail", "no-store");
    assert.deepEqual({ ...after, as_of: before.as_of }, before);
    assert.equal(after.presale.quote_symbol, "USDC");
    assert.equal(after.quote_price, null);
  }));

test("a USDsui presale reads at one dollar per USDsui without an indexed price", { skip }, () =>
  withFixture(async ({ admin, story, list, presale, viewer }) => {
    const presaleId = story.presaleIds.MRDN;
    await admin.query(
      "UPDATE blast_infra_fixture.presales SET quote_type = $2, quote_symbol = 'USDsui' WHERE presale_id = $1",
      [presaleId, "0x44f838219cf67b058f3b37907b655f226153c18e33dfcd0da559a844fea9b1c1::usdsui::USDSUI"],
    );
    const page = await ok<SocialPresaleListPage>(await list("?status=live"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    assert.equal(page.presales.find((row) => row.presale_id === presaleId)?.raised_usd, "184221.00");
    const detail = await ok<SocialPresaleDetail>(await presale(presaleId), "presale-detail", "no-store");
    assert.equal(detail.presale.min_commitment_usd, "10.00");
    const answer = await ok<SocialPresaleViewerResponse>(await viewer(KAI, { presale_ids: [presaleId] }), "presale-viewer-response", "private, no-store");
    assert.equal(answer.presales[presaleId]?.mine?.commitment_usd, "100.00");
  }));

test("R3-40-AC-4: the seeded SUI sale at 99.97% of its target lists as 99.9K SUI of 100K SUI, never its target", { skip }, () =>
  withFixture(async ({ story, list, presale }) => {
    const page = await ok<SocialPresaleListPage>(await list("?status=live"), "presale-list-page", SOCIAL_PUBLIC_CACHE_CONTROL);
    const drift = page.presales.find((row) => row.presale_id === story.presaleIds.DRFT)!;
    assert.deepEqual([drift.symbol, drift.quote_symbol, drift.quote_decimals, drift.raised_atoms, drift.target_atoms], ["DRFT", "SUI", 9, "99970000000000", "100000000000000"]);
    const quote = quoteOf(drift);
    assert.equal(qsRaised(quote, { usd: drift.raised_usd, atoms: drift.raised_atoms }, { usd: drift.target_usd, atoms: drift.target_atoms }), "99.9K SUI");
    const detail = await ok<SocialPresaleDetail>(await presale(story.presaleIds.DRFT), "presale-detail", "no-store");
    assert.deepEqual([detail.presale.min_commitment_atoms, detail.presale.wallet_cap_atoms], ["25000000000", "5000000000000"]);
    assert.equal(detail.quote_price?.usd_price, "3.42");
    // The option adds Driftwood to the eight; without it (every other suite) the story is unchanged.
    assert.equal(Object.keys(story.presaleIds).length, 9);
  }, { sui: true }));


test("admin Pin/Unpin drives Home and Featured from the same saved selection and the default live list while preserving chronological order", { skip }, () =>
  withFixture(async ({ admin, story, featured, happening, pin, list }) => {
    const readFeatured = async () => {
      const response = await featured();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), SOCIAL_PUBLIC_CACHE_CONTROL);
      return ((await response.json()) as { presales: SocialPresaleSummary[] }).presales;
    };
    const homeIds = async () => (await happening()).today.map((row) => row.presale.presale_id);
    const featuredIds = async () => (await readFeatured()).map((sale) => sale.presale_id);
    const ids = [story.presaleIds.SABL, story.presaleIds.MRDN];
    const initialList = (await (await list()).json() as SocialPresaleListPage).presales;
    assert.deepEqual(await featuredIds(), []);
    assert.deepEqual(await homeIds(), []);
    const last = initialList.at(-1)!.presale_id;
    assert.equal((await pin(last, true)).status, 200);
    assert.equal(((await (await list()).json()) as SocialPresaleListPage).presales[0]?.presale_id, last);
    assert.equal((await pin(last, false)).status, 200);
    for (const id of [...ids].reverse()) assert.equal((await pin(id, true)).status, 200);
    assert.deepEqual(await featuredIds(), ids);
    assert.deepEqual(await homeIds(), ids);
    const liveIds = initialList.map(sale => sale.presale_id);
    const pinned = ids.filter(id => liveIds.includes(id));
    const expected = [...pinned, ...liveIds.filter(id => !pinned.includes(id))];
    const read = async (query: string) => (await (await list(query)).json()) as SocialPresaleListPage;
    assert.deepEqual(await paginatedPartnerIds(read, new URLSearchParams({ limit: "1" }), expected.length), expected);
    assert.deepEqual((await read("?sort=ending")).presales, initialList);
    assert.equal((await pin(ids[1], true)).status, 200);
    assert.deepEqual(await featuredIds(), ids, "pinning twice never reorders the selection");
    assert.equal((await pin(story.presaleIds.HLCN, true)).status, 404);
    await admin.query("INSERT INTO social_presale_pins (presale_id) VALUES ($1)", [story.presaleIds.HLCN]);
    assert.deepEqual(await featuredIds(), ids, "ended pins are omitted everywhere");
    assert.deepEqual(await homeIds(), ids);
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_symbol = NULL, sale_name = NULL, sale_icon_url = NULL, sale_decimals = NULL WHERE presale_id = $1", [ids[0]]);
    assert.deepEqual(await featuredIds(), [ids[1]], "pins cannot bypass the shared visibility filter");
    assert.deepEqual(await homeIds(), [ids[1]]);
    for (const id of [...ids, story.presaleIds.HLCN]) assert.equal((await pin(id, false)).status, 200);
    assert.deepEqual(await featuredIds(), []);
    assert.deepEqual(await homeIds(), [], "removing the last pin leaves no automatic replacement");
    const unknown = `0x${"f".repeat(64)}`;
    assert.equal((await pin(unknown, true)).status, 404);
  }));

test("admin pin picker lists only pending and unexpired open sales, including ID lookups", { skip }, () =>
  withFixture(async ({ admin, story, adminList }) => {
    const ids = async (query = "") => {
      const response = await adminList(query);
      assert.equal(response.status, 200);
      return ((await response.json()) as { presales: { presale_id: string }[] }).presales.map((sale) => sale.presale_id);
    };
    assert.deepEqual(await ids(), [story.presaleIds.MRDN, story.presaleIds.TIDE, story.presaleIds.SABL, story.presaleIds.ONDN]);
    for (const symbol of ["CBLT", "KSTL", "LUMN", "HLCN"]) {
      assert.deepEqual(await ids(`?id=${story.presaleIds[symbol]}`), []);
    }
    await admin.query("UPDATE blast_infra_fixture.presales SET end_ms = $1 WHERE presale_id = $2", [NOW, story.presaleIds.TIDE]);
    assert.deepEqual(await ids(`?id=${story.presaleIds.TIDE}`), [], "an open sale is ineligible at its exact end time");
    assert.deepEqual(await ids(), [story.presaleIds.MRDN, story.presaleIds.SABL, story.presaleIds.ONDN]);
  }));

test("admin refuses new ended pins but can remove a pin after its sale ends", { skip }, () =>
  withFixture(async ({ admin, story, pin, adminList }) => {
    for (const symbol of ["CBLT", "KSTL", "LUMN", "HLCN"]) {
      assert.equal((await pin(story.presaleIds[symbol], true)).status, 404);
    }
    const id = story.presaleIds.MRDN;
    assert.equal((await pin(id, true)).status, 200);
    assert.equal((await pin(id, true)).status, 200, "eligible pins remain idempotent");
    await admin.query("UPDATE blast_infra_fixture.presales SET end_ms = $1 WHERE presale_id = $2", [NOW - 1, id]);
    const listing = await adminList(`?id=${id}`);
    assert.deepEqual(((await listing.json()) as { presales: unknown[] }).presales, []);
    assert.equal((await pin(id, true)).status, 404, "an existing saved pin cannot bypass eligibility");
    assert.equal((await pin(id, false)).status, 200);
    assert.equal((await pin(id, false)).status, 200, "unpin remains idempotent");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_presale_pins WHERE presale_id = $1", [id])).rows[0].n, 0);
  }));

test("admin pin pagination fills pages with eligible sales before applying the cursor", { skip }, () =>
  withFixture(async ({ admin, story, adminList }) => {
    const template = (await admin.query<ChainPresaleRow>("SELECT * FROM blast_infra_fixture.presales WHERE presale_id = $1", [story.presaleIds.SABL])).rows[0]!;
    const generated = Array.from({ length: 202 }, (_, index): ChainPresaleRow => ({
      ...template,
      presale_id: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      lifecycle: index % 2 === 0 ? "cancelled" : "pending",
    }));
    await seedChainRead(admin, { presales: generated });
    const read = async (query = "") => {
      const response = await adminList(query);
      assert.equal(response.status, 200);
      return await response.json() as { presales: { presale_id: string }[]; next_cursor: string | null };
    };
    const first = await read();
    assert.equal(first.presales.length, 100);
    assert.equal(first.next_cursor, first.presales.at(-1)?.presale_id);
    const second = await read(`?after=${first.next_cursor}`);
    assert.equal(second.presales.length, 5);
    assert.equal(second.next_cursor, null);
    assert.deepEqual([...first.presales, ...second.presales].map((sale) => sale.presale_id), [
      ...generated.filter((sale) => sale.lifecycle === "pending").map((sale) => sale.presale_id),
      story.presaleIds.MRDN, story.presaleIds.TIDE, story.presaleIds.SABL, story.presaleIds.ONDN,
    ]);
  }));

test("buyer totals include every schedule and personal releases use the claim wallet's exact schedule", { skip }, () =>
  withFixture(async ({ admin, story, presale, viewer }) => {
    const id = story.presaleIds.KSTL;
    const scheduleId = `0x${"ca1".padStart(64, "0")}`;
    const kai = PRESALE_STORY_WALLETS.kai;
    const total = 9007199254740993n;
    await admin.query(`INSERT INTO blast_infra_fixture.vesting_schedules
      (schedule_id, presale_id, beneficiary, total, claimed, start_ms, cliff_ms, end_ms, share, asset)
      SELECT '0x' || lpad(to_hex(n), 64, '0'), $1, $2, $3::numeric,
        CASE WHEN n % 2 = 0 THEN $3::numeric ELSE 1 END, $4, 0, $4::bigint + 604800000, 'participant', 'sale_token'
      FROM generate_series(10000, 10250) n`, [id, kai, total.toString(), NOW]);
    await seedChainRead(admin, { vesting_schedules: [{ schedule_id: scheduleId, presale_id: id, beneficiary: kai,
      total: total.toString(), claimed: "1234567890123456", start_ms: NOW, cliff_ms: "0", end_ms: String(NOW + 604800000), share: "participant", asset: "sale_token" }] });
    await admin.query(`UPDATE blast_infra_fixture.presale_positions SET claim_digest = 'vesting-claim', claimed_tokens = $3,
      claim_vesting_id = $4 WHERE presale_id = $1 AND wallet = $2`, [id, kai, total.toString(), scheduleId]);
    const publicRead = await ok<SocialPresaleDetail>(await presale(id), "presale-detail", "no-store");
    const claimed = 126n * total + 125n + 1234567890123456n;
    assert.deepEqual(publicRead.buyer_vesting, { schedules: 252, total: (252n * total).toString(), claimed: claimed.toString(), remaining: (252n * total - claimed).toString() });
    const personal = await ok<SocialPresaleViewerResponse>(await viewer(KAI, { presale_ids: [id] }), "presale-viewer-response", "private, no-store");
    assert.deepEqual(personal.presales[id].mine?.buyer_vesting, { schedule_id: scheduleId, beneficiary: kai, total: total.toString(), claimed: "1234567890123456", remaining: (total - 1234567890123456n).toString() });
    assert.equal(personal.presales[id].mine?.claim_wallet_claimed, true);
    const other = await readViewerPresales(autocommitReader(admin, "social"), PRESALE_STORY_ACCOUNTS.kai, [kai], [id], `0x${"ff".repeat(32)}`);
    assert.equal(other.presales[id].mine?.buyer_vesting, null);
    assert.equal(other.presales[id].mine?.claim_wallet_participated, false);
    await admin.query("UPDATE blast_infra_fixture.vesting_schedules SET claimed = total WHERE schedule_id = $1", [scheduleId]);
    const finished = await ok<SocialPresaleViewerResponse>(await viewer(KAI, { presale_ids: [id] }), "presale-viewer-response", "private, no-store");
    assert.equal(finished.presales[id].mine?.buyer_vesting?.remaining, "0");
  }));
