import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { isTradingVisible } from "@blast/core/lib/social-flag.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainActivityRow, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { HAPPENING_TAPE_MAX, SOCIAL_HAPPENING_DISCOVER_PATH, SOCIAL_HAPPENING_PATH, type SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import type { SocialViewerStateResponse } from "@blast/core/modules/social/contracts/viewer-state.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialViewerStateRoute } from "@blast/server/modules/social/viewer-state/route.ts";
import { createSocialHappeningRoute } from "@blast/server/modules/social/happening/route.ts";
import { hex, uuid } from "../../../../../core/test/kit.ts";

/**
 * UI-05 backend (T-011 and the live tape) over a disposable database with the
 * fixture `chain_read_v1`: `GET /api/social/happening` as `blast_replica`
 * (public, cached, watermark-bounded) and viewer-state's `follows_you` as
 * `blast_web`, as in production.
 *
 * Hidden sales are seeded the way blast-infra hides them: T-043's excluded
 * test sale is **absent** from `chain_read_v1.presales` while its `activity`
 * rows remain (the view is deliberately not filtered), and a sale whose coin
 * metadata has not arrived is in `presales` but not in `SHOWN_PRESALES`.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-happening-app";
const PEPPER = "social-happening-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const PUBLIC = "public, s-maxage=10, stale-while-revalidate=20";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const QUOTE = `${hex("dba3")}::usdc::USDC`;
const P = {
  openSoon: hex("a0"), // closes in 2 h
  openLater: hex("a1"), // closes in a day, fills faster
  openPast: hex("a2"), // still "open" on chain but past its end
  pendingLater: hex("b0"),
  pendingSoon: hex("b1"),
  funded: hex("c0"),
  tradingNew: hex("d0"),
  tradingOld: hex("d1"),
  cancelled: hex("e0"),
} as const;
/** Sales the web never shows: T-043's excluded test sale (no `presales` row) and one with no coin metadata yet. */
const HIDDEN = { excluded: hex("e2"), incomplete: hex("e1") } as const;
const HIDDEN_COIN = `${hex("5650")}::sale_tokens::SALE_B`;
const W = { ana: hex("aa01"), ben: hex("aa02"), cy: hex("aa03"), anon: hex("bb01"), anon2: hex("bb02"), tester: hex("dd01") } as const;
const PEOPLE = [
  // callsign, wallet, privacy, sharing (days ago; null = never)
  ["ana_pub", W.ana, "public", 400],
  ["ben_priv", W.ben, "private", 400],
  ["cy_late", W.cy, "public", 0.01], // started sharing 15 minutes ago
] as const;
const did = (callsign: string) => `did:privy:happening-${callsign}`;

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

function presale(id: string, symbol: string, lifecycle: ChainPresaleRow["lifecycle"], row: Partial<ChainPresaleRow>): ChainPresaleRow {
  return {
    presale_id: id, sale_token: `${id}::coin::${symbol}`, quote_type: QUOTE, sale_symbol: symbol, sale_name: `Sale ${symbol}`,
    sale_icon_url: `https://cdn.blast.fun/${symbol}.png`, sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle,
    start_ms: 0, end_ms: 0, raise_target: "100000000000", min_commitment: "10000000", wallet_cap: null, total_commitments: "0",
    participants: 0, venue: "cetus", pool_id: null, updated_checkpoint: 1, ...row,
  };
}

let checkpoint = 50_000;
function activity(kind: string, actor: string, presaleId: string | null, at: number, row: Partial<ChainActivityRow> = {}): ChainActivityRow {
  checkpoint += 1;
  return {
    checkpoint, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: at, digest: `Hp${checkpoint}`.padEnd(44, "2"), kind,
    product: kind.startsWith("trade") ? "market" : "presale", actor, tx_sender: actor, presale_id: presaleId, coin_type: null,
    quote_type: QUOTE, quote_amount: "0", coin_amount: null, quote_refund: null, usd_value: null, usd_price_as_of_ms: null, venue: null,
    participants_after: null, total_commitments_after: null, ...row,
  };
}
const commit = (actor: string, presaleId: string, dollars: number | null, at: number) =>
  activity("presale_commit", actor, presaleId, at, { quote_amount: String(Math.round((dollars ?? 1) * 1e6)), usd_value: dollars === null ? null : dollars.toFixed(2) });

type Fixture = Readonly<{
  admin: Pool;
  now: number;
  happening(options?: Readonly<{ trades?: boolean; recent?: boolean | "legacy"; headers?: Record<string, string> }>): Promise<Response>;
  viewerState(callsign: string, body: unknown): Promise<Response>;
}>;

/** `hidden`: activity rows of the hidden sales, added to the story's. */
async function withFixture(run: (fixture: Fixture) => Promise<void>, hidden: (now: number) => ChainActivityRow[] = () => []): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const now = Date.now();
  checkpoint = 50_000;
  await seedChainRead(admin, {
    presales: [
      presale(P.openSoon, "OSN", "open", { start_ms: now - DAY, end_ms: now + 2 * HOUR, total_commitments: "40000000000", participants: 40 }),
      presale(P.openLater, "OLT", "open", { start_ms: now - DAY, end_ms: now + DAY, total_commitments: "20000000000", participants: 20, raise_target: "50000000000" }),
      presale(P.openPast, "OPS", "open", { start_ms: now - 2 * DAY, end_ms: now - MINUTE }),
      presale(P.pendingLater, "PLT", "pending", { start_ms: now + 3 * DAY, end_ms: now + 6 * DAY }),
      presale(P.pendingSoon, "PSN", "pending", { start_ms: now + DAY, end_ms: now + 4 * DAY }),
      presale(P.funded, "FND", "funded", { start_ms: now - 5 * DAY, end_ms: now - 3 * HOUR, total_commitments: "125000000000", venue: "bluefin" }),
      presale(P.tradingNew, "TNW", "migrated", { start_ms: now - 9 * DAY, end_ms: now - 6 * DAY }),
      presale(P.tradingOld, "TOL", "migrated", { start_ms: now - 60 * DAY, end_ms: now - 50 * DAY }),
      presale(P.cancelled, "CNL", "cancelled", { start_ms: now - 9 * DAY, end_ms: now - 6 * DAY }),
      // The coin's metadata has not arrived: SHOWN_PRESALES leaves it out of every list.
      presale(HIDDEN.incomplete, "INC", "open", {
        start_ms: now - DAY, end_ms: now + HOUR, sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null,
        total_commitments: "90000000000", participants: 90,
      }),
    ],
    presale_lifecycle: [
      { presale_id: P.tradingNew, state: "migrated", digest: "LcTnw".padEnd(44, "2"), timestamp_ms: now - 2 * DAY, checkpoint: 40_001 },
      { presale_id: P.tradingOld, state: "migrated", digest: "LcTol".padEnd(44, "2"), timestamp_ms: now - 45 * DAY, checkpoint: 40_002 },
    ],
    // The presale price is what buyers paid, from the claims: Ana's $620 for 1.24M TNW is 0.0005.
    presale_positions: [{
      presale_id: P.tradingNew, wallet: W.ana, commitment: "620000000", last_commit_ms: now - 8 * DAY, claim_digest: "ClTnw".padEnd(44, "2"),
      claimed_tokens: "1240000000000000", claimed_quote_refund: "0", claimed_ms: now - 3 * MINUTE,
    }],
    prices: [
      { coin_type: QUOTE, usd_price: "1", as_of_ms: now, source: "pyth" },
      { coin_type: `${P.tradingNew}::coin::TNW`, usd_price: "0.0021", as_of_ms: now, source: "pool" },
    ],
    activity: [
      // The last hour: four wallets (one unnamed, one priced at null), $350 priced.
      commit(W.ana, P.openSoon, 100, now - 59 * MINUTE),
      commit(W.ben, P.openSoon, 200, now - 30 * MINUTE),
      commit(W.anon, P.openLater, 50, now - 20 * MINUTE),
      commit(W.anon, P.openLater, null, now - 10 * MINUTE),
      commit(W.cy, P.openLater, null, now - 5 * MINUTE),
      // Not in the last hour: 61 minutes old; a claim; a trade.
      commit(W.ana, P.openSoon, 9_000, now - 61 * MINUTE),
      activity("presale_claim", W.ana, P.tradingNew, now - 3 * MINUTE, { coin_amount: "1240000000000000", quote_refund: "0" }),
      activity("presale_claim", W.anon2, P.cancelled, now - 2 * MINUTE, { coin_amount: "0", quote_refund: "250000000" }),
      activity("trade_buy", W.anon2, null, now - MINUTE, { coin_type: `${P.tradingNew}::coin::TNW`, quote_amount: "757000000", usd_value: "757.00" }),
      // The velocity window (6 h): OLT raised 30 of its 50 (0.6), OSN 20 of 100 (0.2).
      commit(W.anon2, P.openLater, 29_950, now - 5 * HOUR),
      commit(W.anon2, P.openSoon, 19_700, now - 5 * HOUR),
      commit(W.anon2, P.openSoon, 99_999, now - 7 * HOUR),
      ...hidden(now),
    ],
  });
  await admin.query(advanceWatermark(checkpoint, -MINUTE, "presale"));
  await admin.query(advanceWatermark(checkpoint, -MINUTE, "market"));
  for (const [n, [callsign, wallet, privacy, days]] of PEOPLE.entries()) {
    const since = new Date(now - days * DAY).toISOString();
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, x_avatar_url, privacy, sharing_since, onboarded_at)
       VALUES ($1, $2, $3, $4, $5, $3, NULL, $6, $7, $8)`,
      [uuid(n + 1), did(callsign), callsign, `Name ${callsign}`, `x-${callsign}`, privacy, privacy === "private" ? null : since, since],
    );
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [wallet, uuid(n + 1), new Date(now - 400 * DAY).toISOString()]);
  }
  // Follows: ben follows ana; ana and cy follow the pending sale PSN.
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES
     ($1::uuid, 'account', $2, 'user'), ($2::uuid, 'presale', $3, 'user'), ($4::uuid, 'presale', $3, 'user')`,
    [uuid(2), uuid(1), P.pendingSoon, uuid(3)],
  );

  const replicaPool = createRuntimePool(urlAs(database.url, "blast_replica"), POOL, "social-happening-replica");
  const webPool = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-happening-web");
  try {
    assert.equal((await replicaPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const replica = autocommitReader(replicaPool, "social");
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"), { now: () => 0 });
    // Trades shown, hidden as for an outsider while trading is off, and (viewer-state) the server's real flag.
    const kitWith = (tradingVisible: (request: Request) => boolean) => createSocialRouteKit({
      tradingVisible,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
    });
    const common = { database: () => replica, config: reader.getSocialConfig, now: () => now };
    const hidden = createSocialHappeningRoute({ ...common, kit: kitWith(() => false) });
    const all = createSocialHappeningRoute({ ...common, kit: kitWith(() => true) });
    const viewerState = createSocialViewerStateRoute({ kit: kitWith(() => isTradingVisible()) });
    await run({
      admin,
      now,
      happening: (options = {}) =>
        (options.trades ? all : hidden).GET(new Request(`${ORIGIN}${options.recent === "legacy" ? `${SOCIAL_HAPPENING_PATH}?recent_presales=1` : options.recent ? SOCIAL_HAPPENING_DISCOVER_PATH : SOCIAL_HAPPENING_PATH}`, { headers: { "x-forwarded-for": "203.0.113.7", ...options.headers } }), testClient("203.0.113.7")),
      viewerState: (callsign, body) =>
        viewerState.POST(new Request(`${ORIGIN}/api/social/viewer-state`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer(did(callsign)) },
          body: JSON.stringify(body),
        }), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function happeningOf(response: Response): Promise<SocialHappeningResponse> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("happening-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PUBLIC);
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialHappeningResponse;
}

const ids = (list: readonly { presale: { presale_id: string } }[]) => list.map((row) => row.presale.presale_id);

test("Home recap uses only eligible saved pins and expires them despite indexer lag", { skip }, () =>
  withFixture(async ({ admin, happening, now }) => {
    const before = await happeningOf(await happening());
    assert.deepEqual(ids(before.today), []);
    const coverKey = `sale-covers/${P.openLater}/${"a".repeat(64)}.webp`;
    await admin.query(`INSERT INTO social_sale_metadata (presale_id, cover_key, cover_url, cover_width, cover_height, updated_by_operator, updated_at_ms)
      VALUES ($1, $2, 'https://cdn.blast.fun/covers/project.webp', 1536, 512, 'fixture', 1)`, [P.openLater, coverKey]);
    await admin.query(`INSERT INTO social_presale_pins (presale_id, pinned_at) VALUES
      ($1, '2026-01-01'), ($2, '2026-01-02'), ($3, '2026-01-03'), ($4, '2026-01-04')`,
      [P.openSoon, P.openLater, HIDDEN.incomplete, HIDDEN.excluded]);
    await admin.query("INSERT INTO social_presale_pins (presale_id) VALUES ($1), ($2), ($3), ($4)", [P.openPast, P.funded, P.tradingOld, P.cancelled]);
    const pinned = await happeningOf(await happening());
    assert.deepEqual(ids(pinned.today), [P.openLater, P.openSoon]);
    // A cover stored without its upload's size (as before 0137) says so: `source` is null, never a guess.
    assert.deepEqual(pinned.today[0]?.cover, { url: "https://cdn.blast.fun/covers/project.webp", width: 1536, height: 512, source: null });
    assert.equal(pinned.today[1]?.cover, null);
    assert.ok(!JSON.stringify(pinned).includes(coverKey));
    assert.deepEqual(pinned.fastest, before.fastest);
    assert.deepEqual(pinned.opening_soon, before.opening_soon);
    await admin.query("UPDATE blast_infra_fixture.presales SET end_ms = $1 WHERE presale_id IN ($2, $3)", [now, P.openSoon, P.openLater]);
    await admin.query("UPDATE watermarks SET timestamp_ms_hi_inclusive = $1", [now - MINUTE]);
    const ended = await happeningOf(await happening());
    assert.equal(ended.clock_ms, now - MINUTE);
    assert.deepEqual(ids(ended.today), [], "uses wall clock even when the indexer watermark is behind");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_presale_pins")).rows[0].n, 8);
    await admin.query("DELETE FROM social_presale_pins");
    assert.deepEqual(ids((await happeningOf(await happening())).today), []);
  }));

test("T-011-AC-1 (AC-061): live presales only, each list in its order, with raised, timing and the post chip's fields", { skip }, () =>
  withFixture(async ({ admin, happening, now }) => {
    await admin.query("INSERT INTO social_presale_pins (presale_id) VALUES ($1)", [P.tradingNew]);
    const body = await happeningOf(await happening());
    assert.deepEqual(ids(body.today), []);
    assert.deepEqual(ids(body.opening_soon), [P.pendingSoon, P.pendingLater]);
    // Fastest: the 6 h window's raise ÷ target (OLT 0.6 before OSN 0.2), not the closing order.
    assert.deepEqual(ids(body.fastest), [P.openLater, P.openSoon]);
    const later = body.fastest[0]!;
    // Unpriced commits still count their quote amount ($1 each here).
    assert.equal(later.window_raised, String(29_950e6 + 50e6 + 2e6));
    assert.equal(later.presale.raised, "20000000000");
    assert.equal(later.presale.end_ms, now + DAY);
    assert.equal(later.presale.lifecycle, "open");
    // A saved migrated pin no longer appears on Home.
    // Interested = the presale's followers; the bell is the same state.
    assert.equal(body.opening_soon[0]!.interested, 2);
    assert.equal(body.opening_soon[1]!.interested, 0);
  }));

test("T-011-AC-2 (AC-062, AC-063, AC-047): last hour counts every wallet, USD only where priced, nothing 61 minutes old", { skip }, () =>
  withFixture(async ({ happening }) => {
    const body = await happeningOf(await happening());
    assert.deepEqual(body.last_hour, { wallets: 4, usd: "350.00", usd_complete: false });
  }));

test("Discover ranks live presales by the newest confirmed commit per sale, even beyond the tape", { skip }, () =>
  withFixture(async ({ happening, now }) => {
    assert.equal("recent_presales" in await happeningOf(await happening()), false);
    const body = await happeningOf(await happening({ recent: true }));
    assert.deepEqual(ids(body.fastest), [P.openLater, P.openSoon]);
    assert.deepEqual(body.recent_presales?.map(({ presale, last_commit_ms }) => [presale.presale_id, last_commit_ms]), [
      [P.openSoon, now - MINUTE],
      [P.openLater, now - 5 * MINUTE],
    ]);
    assert.deepEqual(body.recent_presales?.map(({ backers_1h, committed_1h }) => [backers_1h, committed_1h]), [[3, "308000000"], [2, "52000000"]]);
    const legacy = await happeningOf(await happening({ recent: "legacy" }));
    assert.equal("active_curves" in legacy, false);
    assert.deepEqual(legacy.recent_presales?.map(Object.keys), [["presale", "last_commit_ms"], ["presale", "last_commit_ms"]]);
    assert.ok(body.tape.every((event) => event.presale_id !== P.openLater));
  }, (now) => Array.from({ length: HAPPENING_TAPE_MAX }, (_, i) => commit(W.anon, P.openSoon, 1, now - MINUTE - i * 1_000))));

test("Discover keeps both a heavily backed sale and the newest commit beyond the old recency cap", { skip }, () =>
  withFixture(async ({ admin, happening, now }) => {
    const dust = Array.from({ length: 10 }, (_, index) => hex(`c2${index}`));
    const popular = hex("c3ff");
    const rows = [
      ...dust.map((id, index) => commit(W.ana, id, 0.01, now - 1_000 - index)),
      ...Object.values(W).map((wallet) => commit(wallet, popular, 1_000, now - 10 * MINUTE)),
    ];
    await seedChainRead(admin, {
      presales: [...dust, popular].map(id => presale(id, "SALE", "open", { start_ms: now - HOUR, end_ms: now + HOUR })),
      activity: rows,
    });
    await admin.query(advanceWatermark(rows.at(-1)!.checkpoint, 0, "presale"));
    const weighted = (await happeningOf(await happening({ recent: true }))).recent_presales ?? [];
    assert.equal(weighted.length, 10);
    assert.equal(weighted[0]?.presale.presale_id, dust[0]);
    assert.ok(weighted.some(row => row.presale.presale_id === popular && row.backers_1h === Object.keys(W).length));
    const legacy = (await happeningOf(await happening({ recent: "legacy" }))).recent_presales ?? [];
    assert.deepEqual(legacy.map(row => row.presale.presale_id), dust.slice(0, 5));
  }));

test("Discover finds confirmed activity on an old live curve beyond the catalog, once per wallet, a tiny trade adding volume only", { skip }, () =>
  withFixture(async ({ admin, happening, now }) => {
    const coin = `${hex("dce1")}::curve::CURVE`;
    const pool = `blast_curve:${hex("dce2")}`;
    const created = now - 10 * DAY;
    await admin.query(`INSERT INTO coins (coin_type, decimals, launcher, pool_key, created_checkpoint, created_at_ms, metadata)
      VALUES ($1, 9, $2, $3, 900, $4, '{"name":"The Curve","symbol":"CURVE"}')`, [coin, W.ana, pool, created]);
    await admin.query(`INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
      VALUES ($1, 'blast_curve', $2, $3, 'live', 900, $4)`, [pool, coin, QUOTE, created]);
    const trade = (kind: string, wallet: string, age: number, usd: string | null) =>
      activity(kind, wallet, null, now - age, { coin_type: coin, venue: "blast_curve", quote_amount: "4000000", usd_value: usd });
    const first = trade("trade_buy", W.ana, 10 * MINUTE, "4.00");
    const repeat = trade("trade_sell", W.ana, 8 * MINUTE, "3.00");
    const second = trade("trade_buy", W.ben, 5 * MINUTE, null);
    const tiny = trade("trade_buy", W.cy, 3 * MINUTE, "0.004");
    const old = trade("trade_buy", W.anon, 61 * MINUTE, "100.00");
    const uncommitted = trade("trade_buy", W.cy, MINUTE, "99.00");
    await seedChainRead(admin, { activity: [first, repeat, second, tiny, old, uncommitted] });
    await admin.query(advanceWatermark(old.checkpoint, 0, "market"));
    const body = await happeningOf(await happening({ trades: true, recent: true }));
    assert.deepEqual(body.active_curves, [{
      coin_type: coin, symbol: "CURVE", name: "The Curve", icon_url: null, verified_team: false,
      created_ms: created, participants: 2, last_action_ms: now - 5 * MINUTE, volume_usd: "7.004",
    }]);
    assert.deepEqual((await happeningOf(await happening({ recent: true }))).active_curves, []);
  }));

test("T-011-AC-3 (AC-124, AC-165, AC-042): public cache, no viewer field, replica, as_of; a token changes nothing", { skip }, () =>
  withFixture(async ({ happening, now }) => {
    const plain = await happeningOf(await happening());
    const withToken = await happeningOf(await happening({ headers: { authorization: bearer(did("ana_pub")), cookie: "__Host-blast_wallet=x" } }));
    assert.deepEqual(withToken, plain);
    assert.ok(plain.as_of.checkpoint > 0);
    assert.equal(plain.clock_ms, now);
    assert.doesNotMatch(JSON.stringify(plain), /"(viewer|follows_you|following|reactions)"/);
  }));

test("UI-05 tape: newest first, named by the naming rule at the event, claims in tokens or refund, trades only while visible", { skip }, () =>
  withFixture(async ({ happening }) => {
    const hidden = await happeningOf(await happening());
    assert.equal(hidden.tape.length, HAPPENING_TAPE_MAX);
    assert.deepEqual(hidden.tape.map((event) => event.kind).slice(0, 3), ["presale_claim", "presale_claim", "presale_commit"]);
    const [refund, claim, cy, anonNull, anon, ben, ana] = hidden.tape;
    assert.equal(refund!.refund, "250");
    assert.equal(refund!.tokens, null);
    assert.equal(refund!.symbol, "CNL");
    assert.equal(claim!.tokens, "1240000");
    assert.equal(claim!.actor.type, "account");
    // cy started sharing 15 minutes ago: its commit 5 minutes ago is named.
    assert.deepEqual(cy!.actor.type === "account" && [cy!.actor.callsign, cy!.actor.path], ["cy_late", "/@cy_late"]);
    assert.equal(cy!.usd, null);
    assert.deepEqual(anonNull!.actor, { type: "address", address: W.anon, short: "0x0000…bb01" });
    assert.equal(anon!.usd, "50.00");
    // A private account is a wallet only.
    assert.deepEqual(ben!.actor, { type: "address", address: W.ben, short: "0x0000…aa02" });
    assert.equal(ana!.actor.type, "account");
    const all = await happeningOf(await happening({ trades: true }));
    assert.equal(all.tape[0]!.kind, "trade_buy");
    assert.equal(all.tape[0]!.symbol, "TNW");
    assert.equal(all.tape[0]!.usd, "757.00");
    // A trade of a presale's coin links to the presale.
    assert.equal(all.tape[0]!.presale_id, P.tradingNew);
  }));

test("UI-05 watermark: activity past a pipeline's committed checkpoint is left out; the windows end at the chain clock", { skip }, () =>
  withFixture(async ({ admin, happening, now }) => {
    // The presale pipeline committed only up to the 61-minute-old commit, nine minutes ago.
    const cut = (await admin.query<{ c: string }>(
      "SELECT checkpoint::text AS c FROM blast_infra_fixture.activity WHERE usd_value = 9000",
    )).rows[0]!.c;
    await admin.query(advanceWatermark(Number(cut), 9 * MINUTE, "presale"));
    const body = await happeningOf(await happening({ trades: true, recent: true }));
    assert.ok(body.clock_ms >= now - 9 * MINUTE - 1_000 && body.clock_ms <= now - 9 * MINUTE + 30_000, String(body.clock_ms - now));
    // Only commits at or below the cut and before the clock count: Cy's (5 minutes ago) is past both; the
    // 61-minute-old one is inside the hour before the clock.
    assert.deepEqual(body.last_hour, { wallets: 3, usd: "9350.00", usd_complete: false });
    assert.deepEqual(body.recent_presales?.map(({ presale, last_commit_ms }) => [presale.presale_id, last_commit_ms]), [
      [P.openLater, now - 10 * MINUTE],
      [P.openSoon, now - 30 * MINUTE],
    ]);
    assert.ok(body.tape.every((event) => event.kind !== "presale_claim"));
    // The trade is past the clock, so it is left out too.
    assert.ok(body.tape.every((event) => event.kind !== "trade_buy"));
  }));

/**
 * The hidden sales' rows: in the last hour (a new wallet, and Anon2, whose
 * own commits are hours old, so each would add a wallet and dollars), a claim,
 * their coins' trades (unstamped, and stamped with the sale as T-038 does),
 * and then the `2 × HAPPENING_TAPE_MAX` newest rows of the whole log.
 */
function hiddenRows(now: number): ChainActivityRow[] {
  const rows = [
    commit(W.tester, HIDDEN.excluded, 500, now - 45 * MINUTE),
    commit(W.anon2, HIDDEN.excluded, 700, now - 15 * MINUTE),
    commit(W.tester, HIDDEN.incomplete, 600, now - 8 * MINUTE),
    activity("presale_claim", W.tester, HIDDEN.excluded, now - 4 * MINUTE, { coin_amount: "1000000000", quote_refund: "0" }),
    activity("trade_buy", W.tester, null, now - 90_000, { coin_type: HIDDEN_COIN, quote_amount: "5000000", usd_value: "5.00" }),
    activity("trade_sell", W.tester, HIDDEN.excluded, now - 80_000, { coin_type: HIDDEN_COIN, quote_amount: "4000000", usd_value: "4.00" }),
  ];
  for (let index = 0; index < 2 * HAPPENING_TAPE_MAX; index += 1) {
    const sale = index % 2 === 0 ? HIDDEN.excluded : HIDDEN.incomplete;
    const at = now - 50_000 + index * 1_000;
    rows.push(index % 3 === 0
      ? activity("presale_claim", W.tester, sale, at, { coin_amount: "0", quote_refund: "1000000" })
      : commit(W.tester, sale, 10, at));
  }
  return rows;
}

/** Each tape row as kind, symbol and USD: what Home shows. */
const shape = (body: SocialHappeningResponse) => body.tape.map((event) => [event.kind, event.symbol, event.usd]);
/** The eight newest rows of the shown sales (the UI-05 tape test's), trading hidden. */
const SHOWN_TAPE = [
  ["presale_claim", "CNL", null],
  ["presale_claim", "TNW", null],
  ["presale_commit", "OLT", null],
  ["presale_commit", "OLT", null],
  ["presale_commit", "OLT", "50.00"],
  ["presale_commit", "OSN", "200.00"],
  ["presale_commit", "OSN", "100.00"],
  ["presale_commit", "OSN", "9000.00"],
];
const SHOWN_SALES: readonly string[] = Object.values(P);
const HIDDEN_TEXT = new RegExp(`${HIDDEN.excluded.slice(2)}|${HIDDEN.incomplete.slice(2)}|${W.tester.slice(2)}|SALE_B|"INC"`);

test("T-043 hidden sales: a hidden sale's commit, claim or coin trade never reaches the tape or a list, trading hidden or visible", { skip }, () =>
  withFixture(async ({ happening }) => {
    for (const trades of [false, true]) {
      const body = await happeningOf(await happening({ trades, recent: true }));
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, HIDDEN_TEXT);
      assert.ok(body.tape.every((event) => event.presale_id !== null && SHOWN_SALES.includes(event.presale_id) && event.symbol !== ""), text);
      assert.deepEqual(ids(body.today), []);
      assert.deepEqual(ids(body.fastest), [P.openLater, P.openSoon]);
    }
    // With trading visible, the shown coin's trade leads, then the shown rows as before.
    const all = await happeningOf(await happening({ trades: true }));
    assert.deepEqual(shape(all), [["trade_buy", "TNW", "757.00"], ...SHOWN_TAPE.slice(0, HAPPENING_TAPE_MAX - 1)]);
  }, hiddenRows));

test("T-043 hidden sales: a tape whose newest rows are all hidden sales' is still the eight newest shown rows", { skip }, () =>
  withFixture(async ({ admin, happening }) => {
    // The log's newest rows, twice what the tape holds, are all the hidden sales'.
    const newest = await admin.query<{ presale_id: string }>(
      `SELECT presale_id FROM chain_read_v1.activity WHERE kind LIKE 'presale%' ORDER BY timestamp_ms DESC LIMIT ${2 * HAPPENING_TAPE_MAX}`,
    );
    assert.ok(newest.rows.every((row) => row.presale_id === HIDDEN.excluded || row.presale_id === HIDDEN.incomplete));
    // The tape is still full, and it is the tape of the same story with no hidden rows (the UI-05 tape test's).
    const body = await happeningOf(await happening());
    assert.equal(body.tape.length, HAPPENING_TAPE_MAX);
    assert.deepEqual(shape(body), SHOWN_TAPE);
  }, hiddenRows));

test("T-043 hidden sales: the last hour counts no hidden sale's wallet or dollar (T-011-AC-2's totals, unchanged)", { skip }, () =>
  withFixture(async ({ happening }) => {
    // Counting the hidden sales would give 6 wallets (Tester, and Anon2, whose shown commits are hours old) and $2,250.00.
    for (const trades of [false, true]) assert.deepEqual((await happeningOf(await happening({ trades }))).last_hour, { wallets: 4, usd: "350.00", usd_complete: false });
  }, hiddenRows));

test("UI-05 no readable watermark is 503 service_unavailable", { skip }, () =>
  withFixture(async ({ admin, happening }) => {
    await admin.query("UPDATE watermarks SET checkpoint_hi_inclusive = NULL, timestamp_ms_hi_inclusive = NULL WHERE pipeline = 'presale'").catch(async () => {
      await admin.query("DELETE FROM watermarks WHERE pipeline = 'presale'");
    });
    const response = await happening();
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }));

test("UI-05 viewer-state follows_you: which public accounts follow the caller, never a private follower or the caller itself", { skip }, () =>
  withFixture(async ({ admin, viewerState }) => {
    // ben (private) already follows ana; cy (public) follows her too.
    await admin.query("INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1::uuid, 'account', $2, 'user')", [uuid(3), uuid(1)]);
    const response = await viewerState("ana_pub", { callsigns: ["ben_priv"], follows_you: ["ben_priv", "cy_late", "ana_pub", "nobody_here"] });
    const body = (await response.json()) as SocialViewerStateResponse;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(validator.validate("viewer-state-response", body).errors, []);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(body.follows_you, { ben_priv: false, cy_late: true, ana_pub: false, nobody_here: false }, "a private follower is never named, even to the account it follows");
    assert.deepEqual(body.follows.accounts, { ben_priv: false });
    const bad = await viewerState("ana_pub", { follows_you: ["NOT A CALLSIGN"] });
    assert.equal(bad.status, 400);
  }));

test("Top coins uses fresh market data and followed buyers obey privacy and trading visibility", { skip }, () =>
  withFixture(async ({ admin, now, happening, viewerState }) => {
    const coin = `${P.tradingNew}::coin::TNW`;
    const clock = now - MINUTE;
    await seedChainRead(admin, {
      coin_balances: [W.ana, W.ben, W.cy].map((owner) => ({ coin_type: coin, owner, balance: "100", updated_checkpoint: 1 })),
      price_history: [{ coin_type: coin, resolution: "5m", bucket_ms: Math.floor((clock - DAY - MINUTE) / 300000) * 300000,
        usd_price: "0.001", as_of_ms: clock - DAY - MINUTE, source: "pool" }],
    });
    const read = await happeningOf(await happening({ trades: true }));
    assert.ok(read.top_coins);
    assert.equal(read.top_coins.trending[0]?.symbol, "TNW");
    assert.equal(read.top_coins.trending[0]?.buyers_24h, 3, "private and pre-sharing accounts count anonymously");
    assert.equal(read.top_coins.trending[0]?.holders, 3);
    assert.equal(read.top_coins.gainers[0]?.change_24h_bps, 11000);
    assert.equal((await happeningOf(await happening())).top_coins, null);
    const before = process.env.BLAST_TRADING_ENABLED;
    process.env.BLAST_TRADING_ENABLED = "true";
    try {
      const response = await viewerState("ben_priv", { buyers_of: [P.tradingNew] });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      const state: SocialViewerStateResponse = await response.json();
      assert.deepEqual(validator.validate("viewer-state-response", state).errors, []);
      assert.deepEqual(state.buyers?.[P.tradingNew]?.accounts.map((row) => row.callsign), ["ana_pub"]);
      await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1", [uuid(1)]);
      const after: SocialViewerStateResponse = await (await viewerState("ben_priv", { buyers_of: [P.tradingNew] })).json();
      assert.deepEqual(after.buyers?.[P.tradingNew], { count: 0, accounts: [] });
      process.env.BLAST_TRADING_ENABLED = "false";
      const disabled: SocialViewerStateResponse = await (await viewerState("ben_priv", { buyers_of: [P.tradingNew] })).json();
      assert.deepEqual(disabled.buyers?.[P.tradingNew], { count: 0, accounts: [] });
      assert.equal((await viewerState("ben_priv", { buyers_of: Array(51).fill(P.tradingNew) })).status, 400);
      await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1 WHERE coin_type = $2", [now - 121000, coin]);
      assert.deepEqual((await happeningOf(await happening({ trades: true }))).top_coins, { trending: [], gainers: [] });
    } finally {
      if (before === undefined) delete process.env.BLAST_TRADING_ENABLED;
      else process.env.BLAST_TRADING_ENABLED = before;
    }
  }, (now) => [
    activity("trade_buy", W.ana, null, now - 2 * MINUTE, { coin_type: `${P.tradingNew}::coin::TNW`, usd_value: "10.00" }),
    activity("trade_buy", W.ben, null, now - 3 * MINUTE, { coin_type: `${P.tradingNew}::coin::TNW`, usd_value: "20.00" }),
    activity("trade_buy", W.cy, null, now - HOUR, { coin_type: `${P.tradingNew}::coin::TNW`, usd_value: "30.00" }),
  ]));
