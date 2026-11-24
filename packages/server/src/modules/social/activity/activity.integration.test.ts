import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainActivityRow, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { ACTIVITY_PAGE_SIZE, type SocialActivityEvent, type SocialActivityPage } from "@blast/core/modules/social/contracts/activity.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { readActivityPage } from "@blast/server/modules/social/activity/read.ts";
import { createSocialActivityRoute } from "@blast/server/modules/social/activity/route.ts";
import { hex, uuid } from "../../../../../core/test/kit.ts";

/**
 * R3-57's backend: `GET /api/social/activity` (Recent activity, the ticker's
 * read) over a disposable database with the fixture `chain_read_v1`, as
 * `blast_replica` (public, cached, watermark-bounded), as in production.
 *
 * The hidden sales are seeded the way blast-infra hides them: T-043's
 * excluded test sales are **absent** from `chain_read_v1.presales` while their
 * `activity` rows remain (the view is deliberately not filtered), and a sale
 * whose coin metadata has not arrived is in `presales` but not in
 * `SHOWN_PRESALES`.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-activity-app";
const PEPPER = "social-activity-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const PUBLIC = "public, s-maxage=10, stale-while-revalidate=20";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const USDC = `${hex("dba3")}::usdc::USDC`;
const SUI = `${hex("2")}::sui::SUI`;
const P = {
  tidal: hex("a4"), // open, USDC
  sable: hex("a5"), // open, SUI
  kestrel: hex("a1"), // trading
  halcyon: hex("c0"), // cancelled
  incomplete: hex("e1"), // in presales, coin metadata not arrived: not shown
  excluded: hex("e2"), // T-043: hidden by blast-infra, absent from the view
} as const;
const COIN = (id: string, symbol: string) => `${id}::coin::${symbol}`;
const W = { ana: hex("aa01"), ben: hex("aa02"), cy: hex("aa03"), anon: hex("bb01"), anon2: hex("bb02"), tester: hex("dd01") } as const;
const PEOPLE = [
  // callsign, display name, wallet, privacy, sharing (days ago)
  ["anapark", "Ana Park", W.ana, "public", 400],
  ["ben_priv", "Ben Hidden", W.ben, "private", 400],
  ["cy_late", null, W.cy, "public", 0.01], // started sharing 15 minutes ago
] as const;

function presale(id: string, symbol: string, name: string, lifecycle: ChainPresaleRow["lifecycle"], row: Partial<ChainPresaleRow> = {}): ChainPresaleRow {
  return {
    presale_id: id, sale_token: COIN(id, symbol), quote_type: USDC, sale_symbol: symbol, sale_name: name,
    sale_icon_url: `https://cdn.blast.fun/${symbol}.png`, sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle,
    start_ms: 0, end_ms: 0, raise_target: "100000000000", min_commitment: "10000000", wallet_cap: null, total_commitments: "0",
    participants: 0, venue: "cetus", pool_id: null, updated_checkpoint: 1, ...row,
  };
}

let checkpoint = 70_000;
function activity(kind: string, actor: string, presaleId: string | null, at: number, row: Partial<ChainActivityRow> = {}): ChainActivityRow {
  checkpoint += 1;
  return {
    checkpoint, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: at, digest: `Ac${checkpoint}`.padEnd(44, "2"), kind,
    product: kind.startsWith("trade") ? "market" : "presale", actor, tx_sender: actor, presale_id: presaleId, coin_type: null,
    quote_type: USDC, quote_amount: "0", coin_amount: null, quote_refund: null, usd_value: null, usd_price_as_of_ms: null, venue: null,
    participants_after: null, total_commitments_after: null, ...row,
  };
}
const commit = (actor: string, presaleId: string, dollars: number | null, at: number, row: Partial<ChainActivityRow> = {}) =>
  activity("presale_commit", actor, presaleId, at, {
    quote_amount: String(Math.round((dollars ?? 1) * 1e6)),
    usd_value: dollars === null ? null : dollars.toFixed(2),
    usd_price_as_of_ms: dollars === null ? null : at,
    ...row,
  });

type Fixture = Readonly<{
  admin: Pool;
  now: number;
  replica: ReadableDatabase;
  activity(options?: Readonly<{ trades?: boolean; query?: string; headers?: Record<string, string> }>): Promise<Response>;
}>;

async function withFixture(seed: (now: number) => ChainActivityRow[], run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const now = Date.now();
  checkpoint = 70_000;
  await seedChainRead(admin, {
    presales: [
      presale(P.tidal, "TIDE", "Tidal", "open", { start_ms: now - DAY, end_ms: now + DAY }),
      presale(P.sable, "SABL", "Sable", "open", { start_ms: now - DAY, end_ms: now + DAY, quote_type: SUI, quote_symbol: "SUI", quote_decimals: 9 }),
      presale(P.kestrel, "KSTL", "Kestrel", "migrated", { start_ms: now - 9 * DAY, end_ms: now - 6 * DAY }),
      presale(P.halcyon, "HLCN", "Halcyon", "cancelled", { start_ms: now - 9 * DAY, end_ms: now - 6 * DAY }),
      // The coin's metadata has not arrived: SHOWN_PRESALES leaves it out.
      presale(P.incomplete, "INC", "Incomplete", "open", {
        start_ms: now - DAY, end_ms: now + DAY, sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null,
      }),
    ],
    activity: seed(now),
  });
  await admin.query(advanceWatermark(checkpoint, -MINUTE, "presale"));
  await admin.query(advanceWatermark(checkpoint, -MINUTE, "market"));
  for (const [n, [callsign, displayName, wallet, privacy, days]] of PEOPLE.entries()) {
    const since = new Date(now - days * DAY).toISOString();
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, x_avatar_url, privacy, sharing_since, onboarded_at)
       VALUES ($1, $2, $3, $4, $5, $3, NULL, $6, $7, $8)`,
      [uuid(n + 1), `did:privy:activity-${callsign}`, callsign, displayName, `x-${callsign}`, privacy, privacy === "private" ? null : since, since],
    );
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [wallet, uuid(n + 1), new Date(now - 400 * DAY).toISOString()]);
  }

  const replicaPool = createRuntimePool(urlAs(database.url, "blast_replica"), POOL, "social-activity-replica");
  const webPool = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-activity-web");
  try {
    assert.equal((await replicaPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const replica = autocommitReader(replicaPool, "social");
    // Two kits: trades shown, and hidden as for an outsider while trading is off.
    const kitWith = (trading: boolean) => createSocialRouteKit({
      tradingVisible: () => trading,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
    });
    const common = { database: () => replica, now: () => now };
    const hidden = createSocialActivityRoute({ ...common, kit: kitWith(false) });
    const all = createSocialActivityRoute({ ...common, kit: kitWith(true) });
    await run({
      admin,
      now,
      replica,
      activity: (options = {}) =>
        (options.trades ? all : hidden).GET(
          new Request(`${ORIGIN}/api/social/activity${options.query ?? ""}`, { headers: { "x-forwarded-for": "203.0.113.9", ...options.headers } }), testClient("203.0.113.9")
        ),
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function pageOf(response: Response): Promise<SocialActivityPage> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("activity-page", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PUBLIC);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialActivityPage;
}

/** Every page from the newest, following `next_cursor`. */
async function everyPage(read: (query: string) => Promise<Response>): Promise<SocialActivityPage[]> {
  const pages: SocialActivityPage[] = [];
  let query = "";
  for (;;) {
    const page = await pageOf(await read(query));
    pages.push(page);
    if (page.next_cursor === null) return pages;
    query = `?before=${encodeURIComponent(page.next_cursor)}`;
  }
}

/** The story: one row of every kind and shape, plus the rows of sales the web must not show. */
function story(now: number): ChainActivityRow[] {
  return [
    // Hidden: T-043's excluded test sale (no presales row) and a sale not shown yet. Some are the newest rows.
    commit(W.tester, P.excluded, 500, now - 50 * MINUTE),
    commit(W.tester, P.incomplete, 600, now - 40 * MINUTE),
    commit(W.ana, P.tidal, 86, now - 30 * MINUTE),
    commit(W.ben, P.tidal, 200, now - 25 * MINUTE),
    // An unpriced commit in SUI: no USD, the quote amount instead.
    commit(W.anon, P.sable, null, now - 20 * MINUTE, { quote_type: SUI, quote_amount: "12500000000" }),
    commit(W.cy, P.tidal, 40.5, now - 5 * MINUTE),
    activity("presale_claim", W.ana, P.kestrel, now - 4 * MINUTE, { coin_amount: "45734000000000", quote_refund: "0" }),
    activity("presale_claim", W.anon2, P.halcyon, now - 3 * MINUTE, { coin_amount: "0", quote_refund: "250000000", usd_value: "250.00", usd_price_as_of_ms: now }),
    // Trades: a shown sale's coin, and the excluded sale's coin.
    activity("trade_buy", W.anon2, null, now - 2 * MINUTE, { coin_type: COIN(P.kestrel, "KSTL"), quote_amount: "757000000", coin_amount: "1200000000000", usd_value: "757.00", usd_price_as_of_ms: now }),
    activity("trade_sell", W.ana, null, now - 90_000, { coin_type: COIN(P.kestrel, "KSTL"), quote_amount: "120000000", coin_amount: "300000000000", usd_value: "120.00", usd_price_as_of_ms: now }),
    activity("trade_buy", W.tester, null, now - 80_000, { coin_type: COIN(P.excluded, "SALE_B"), quote_amount: "5000000", coin_amount: "1000000000", usd_value: "5.00", usd_price_as_of_ms: now }),
    commit(W.tester, P.excluded, 700, now - 70_000),
    commit(W.tester, P.incomplete, 800, now - 60_000),
  ];
}

const kinds = (events: readonly SocialActivityEvent[]) => events.map((event) => event.kind);
const sales = (events: readonly SocialActivityEvent[]) => events.map((event) => event.presale_id);

test("R3-57 backend: Recent activity is newest first, named at the event, with each kind's own figures", { skip }, () =>
  withFixture(story, async ({ activity }) => {
    const page = await pageOf(await activity());
    assert.equal(page.next_cursor, null);
    assert.deepEqual(kinds(page.events), ["presale_claim", "presale_claim", "presale_commit", "presale_commit", "presale_commit", "presale_commit"]);
    const [refund, claim, cy, anon, ben, ana] = page.events;
    // A refund: whole quote units and its USD.
    assert.deepEqual([refund!.presale_id, refund!.sale_name, refund!.symbol, refund!.refund, refund!.usd, refund!.tokens, refund!.quote], [P.halcyon, "Halcyon", "HLCN", "250", "250.00", null, null]);
    // A token claim: whole sale tokens, no USD.
    assert.deepEqual([claim!.sale_name, claim!.tokens, claim!.refund, claim!.usd], ["Kestrel", "45734", null, null]);
    assert.deepEqual(claim!.actor.type === "account" && [claim!.actor.callsign, claim!.actor.display_name], ["anapark", "Ana Park"]);
    // cy started sharing 15 minutes ago: its commit 5 minutes ago is named; it has no display name.
    assert.deepEqual(cy!.actor.type === "account" && [cy!.actor.callsign, cy!.actor.display_name], ["cy_late", null]);
    assert.deepEqual([cy!.usd, cy!.quote, cy!.quote_symbol], ["40.50", "40.5", "USDC"]);
    // Unpriced, in SUI: the quote amount only.
    assert.deepEqual(anon!.actor, { type: "address", address: W.anon, short: "0x0000…bb01" });
    assert.deepEqual([anon!.sale_name, anon!.usd, anon!.quote, anon!.quote_symbol], ["Sable", null, "12.5", "SUI"]);
    // A private account is a wallet only.
    assert.deepEqual(ben!.actor, { type: "address", address: W.ben, short: "0x0000…aa02" });
    assert.deepEqual([ana!.usd, ana!.quote, ana!.sale_name], ["86.00", "86", "Tidal"]);
    assert.ok(ana!.occurred_at_ms < ben!.occurred_at_ms);
  }));

test("R3-57 backend: a sale the web does not show never appears — T-043's excluded test sales, an incomplete sale, and their coins' trades", { skip }, () =>
  withFixture(story, async ({ activity }) => {
    for (const trades of [false, true]) {
      const page = await pageOf(await activity({ trades }));
      const text = JSON.stringify(page);
      assert.ok(sales(page.events).every((id) => [P.tidal, P.sable, P.kestrel, P.halcyon].includes(id as never)), text);
      assert.doesNotMatch(text, new RegExp(`${P.excluded.slice(2)}|${P.incomplete.slice(2)}|${W.tester.slice(2)}|SALE_B|INC`));
    }
    // With trading visible, the shown coin's trades read as that sale's, with the coin quantity.
    const all = await pageOf(await activity({ trades: true }));
    assert.deepEqual(kinds(all.events).slice(0, 2), ["trade_sell", "trade_buy"]);
    const [sell, buy] = all.events;
    assert.deepEqual([buy!.presale_id, buy!.sale_name, buy!.symbol, buy!.tokens, buy!.usd, buy!.quote], [P.kestrel, "Kestrel", "KSTL", "1200", "757.00", "757"]);
    assert.deepEqual([sell!.tokens, sell!.usd], ["300", "120.00"]);
    assert.equal(all.events.length, 8);
  }));

test("R3-57 backend: keyset pages of 30 cover every shown row once, in order, with hidden rows interleaved and never a short page", { skip }, () =>
  withFixture(
    (now) => {
      const rows: ChainActivityRow[] = [];
      // 70 shown commits; every third second a hidden one between them; ten share one millisecond (one checkpoint's events).
      for (let index = 0; index < 70; index += 1) {
        const at = index < 10 ? now - HOUR : now - HOUR + index * 1_000;
        rows.push(commit(index % 2 === 0 ? W.ana : W.anon, index % 3 === 0 ? P.sable : P.tidal, 10 + index, at));
        if (index % 3 === 0) rows.push(commit(W.tester, index % 2 === 0 ? P.excluded : P.incomplete, 999, at + 500));
      }
      // The newest 40 rows are all hidden.
      for (let index = 0; index < 40; index += 1) rows.push(commit(W.tester, P.excluded, 1, now - 10 * MINUTE + index));
      return rows;
    },
    async ({ activity }) => {
      const pages = await everyPage((query) => activity({ query }));
      assert.deepEqual(pages.map((page) => page.events.length), [ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE, 10]);
      const events = pages.flatMap((page) => page.events);
      assert.equal(new Set(events.map((event) => event.activity_id)).size, 70);
      assert.ok(events.every((event) => event.presale_id === P.tidal || event.presale_id === P.sable));
      const keyOf = (event: SocialActivityEvent) => [event.occurred_at_ms, ...event.activity_id.split(":").map(Number)];
      for (let index = 1; index < events.length; index += 1) {
        const [a, b] = [keyOf(events[index - 1]!), keyOf(events[index]!)];
        const order = a.findIndex((value, at) => value !== b[at]);
        assert.ok(order >= 0 && a[order]! > b[order]!, `${events[index - 1]!.activity_id} before ${events[index]!.activity_id}`);
      }
      // A cursor's page is the same answer every time (a CDN may serve it).
      const second = `?before=${encodeURIComponent(pages[0]!.next_cursor!)}`;
      assert.deepEqual((await pageOf(await activity({ query: second }))).events, pages[1]!.events);
    },
  ));

test("R3-57 backend: an empty log is an empty page; a bad `before` is 400; no readable watermark is 503", { skip }, () =>
  withFixture(() => [], async ({ admin, activity }) => {
    const empty = await pageOf(await activity());
    assert.deepEqual([empty.events, empty.next_cursor], [[], null]);
    for (const query of ["?before=1:2:3:4", "?before=abc", "?before=01:2:3:4:5", "?before=1:2:3:4:5&before=1:2:3:4:5", `?before=${"9".repeat(17)}:1:1:1:1`]) {
      const response = await activity({ query });
      assert.equal(response.status, 400, query);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_parameter");
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    // Other parameters are ignored.
    assert.deepEqual((await pageOf(await activity({ query: "?limit=5&kind=x" }))).events, []);
    await admin.query("DELETE FROM watermarks WHERE pipeline = 'presale'");
    const response = await activity();
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }));

test("R3-57 backend: the watermark bounds the page; a token or a wallet cookie changes nothing", { skip }, () =>
  withFixture(story, async ({ admin, activity, replica, now }) => {
    const plain = await pageOf(await activity());
    const withCredentials = await pageOf(await activity({ headers: { authorization: "Bearer not-a-token", cookie: "__Host-blast_wallet=x" } }));
    assert.deepEqual(withCredentials.events, plain.events);
    assert.doesNotMatch(JSON.stringify(plain), /"(viewer|follows_you|following)"/);
    // The presale pipeline committed only up to Ben's commit, ten minutes ago: nothing later is read.
    const cut = (await admin.query<{ c: string }>("SELECT checkpoint::text AS c FROM blast_infra_fixture.activity WHERE usd_value = 200")).rows[0]!.c;
    await admin.query(advanceWatermark(Number(cut), 10 * MINUTE, "presale"));
    const bounded = await readActivityPage(replica, { nowMs: now, before: null, hiddenKinds: [] });
    assert.deepEqual(bounded.events.map((event) => event.usd), ["200.00", "86.00"]);
  }));
