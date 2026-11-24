import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { OperatorAuthenticator } from "../../mission-control/operator/auth.ts";
import {
  createCompetition,
  findCompetition,
  listCompetitions,
  readCompetitionBoard,
  readCompetitionViewerRank,
  readSwapCompetitions,
} from "./repository.ts";
import { competitionInput } from "@blast/core/modules/social/competitions/config.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createCompetitionRoutes } from "./route.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const SUI = `${hex(2)}::sui::SUI`;
const COIN = `${hex(3)}::coin::COIN`;
const OTHER = `${hex(4)}::coin::OTHER`;

test(
  "competition configuration and leaderboard over verified frontend receipts",
  { skip: !databaseUrl },
  async (t) => {
    const database = await freshTestDatabase();
    const admin = createPool(database.url, { max: 2 });
    const web = createPool(urlAs(database.url, "blast_web"), {
      max: 2,
    });
    t.after(async () => {
      await web.end();
      await admin.end();
      await database.drop();
    });
    const db = autocommitReader(web, "social");
    const start = Date.now() + 600_000;
    const input = competitionInput.parse({
      slug: "coin-week",
      name: "Coin week",
      coin_type: COIN,
      coin_symbol: "COIN",
      coin_icon_url: "https://example.com/coin.png",
      starts_at_ms: start,
      ends_at_ms: start + 60_000,
    });
    const token = "fixture-operator-token".repeat(3);
    const operator = new OperatorAuthenticator({
      operatorId: "fixture",
      tokenHash: createHash("sha256").update(token).digest("hex"),
    }).authenticate("fixture", token);
    const competition = await createCompetition(web, input, operator);
    const board = () => readCompetitionBoard(db, competition, 1, start + 90_000);
    const route = createCompetitionRoutes({
      kit: createSocialRouteKit({
        tradingVisible: () => true,
        expectedOrigin: "https://blast.fun",
        verifyAccessToken: async () => {
          throw new Error("Public read must not authenticate");
        },
        accounts: {
          resolve: async () => null,
          resolveWallet: async () => null,
        },
        limiter: {
          consume: async (bucket) => ({
            allowed: true,
            bucket,
            policyVersion: 1,
            retryAfterSeconds: 0,
          }),
        },
        primary: () => web,
        metricSampleRate: 0,
      }),
      database: () => db,
      now: () => start + 90_000,
    });
    await t.test(
      "anonymous API is uncached, validates parameters and safely answers missing events",
      async () => {
        const response = await route(
          new Request("https://blast.fun/api/social/competitions?slug=coin-week"), testClient()
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.deepEqual((await response.json()).members, []);
        for (const [query, status] of [
          ["page=0", 400],
          ["slug=missing-event", 404],
          ["slug=coin-week&slug=another", 400],
        ] as const) {
          assert.equal(
            (await route(new Request(`https://blast.fun/api/social/competitions?${query}`), testClient())).status,
            status,
          );
        }
      },
    );
    await t.test(
      "swap placement is live, deduplicated and excludes test markets without changing the directory",
      async () => {
        const first = { ...input, slug: "featured-one", feature_on_swap: true };
        await createCompetition(web, first, operator);
        await createCompetition(web, { ...first, slug: "featured-overlap" }, operator);
        const testCurve = `${hex(11)}::coin::TEST_CURVE`;
        await admin.query(
          "INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms) VALUES ($1, 'blast_curve', $2, $3, 'migrated', 900, $4)",
          [`blast_curve:${hex(12)}`, testCurve, CREATE_TEST_SUI_QUOTE_TYPE, start - 120_000],
        );
        await createCompetition(web, {
          ...first, slug: "featured-test-curve", coin_type: testCurve, coin_symbol: "TCURVE",
          starts_at_ms: start - 30_000, ends_at_ms: start + 180_000,
        }, operator);
        await createCompetition(web, {
          ...first, slug: "featured-test-sui", coin_type: CREATE_TEST_SUI_QUOTE_TYPE, coin_symbol: "TSUI",
          starts_at_ms: start - 30_000, ends_at_ms: start + 180_000,
        }, operator);
        await createCompetition(
          web,
          {
            ...first,
            slug: "featured-next",
            coin_type: OTHER,
            starts_at_ms: start + 60_000,
            ends_at_ms: start + 120_000,
          },
          operator,
        );
        assert.deepEqual((await readSwapCompetitions(db, start - 1)).competitions, []);
        assert.equal((await readSwapCompetitions(db, start - 1)).next_change_at_ms, start);
        const live = await readSwapCompetitions(db, start);
        assert.deepEqual(
          live.competitions.map((event) => event.slug),
          [first.slug],
        );
        assert.deepEqual(live.coins, [], "missing decimals never produce a selectable coin");
        await admin.query(
          "INSERT INTO blast_infra_fixture.coin_metadata (coin_type, symbol, name, decimals) VALUES ($1, 'COIN', 'Independent coin', 6)",
          [COIN],
        );
        const resolved = (await readSwapCompetitions(db, start)).coins;
        assert.equal(resolved[0]?.coin_type, COIN);
        assert.equal(resolved[0]?.decimals, 6);
        assert.equal(resolved[0]?.presale_id, null, "coins do not need a Blast presale");
        assert.equal(live.next_change_at_ms, start + 60_000);
        assert.equal(live.as_of_ms, start);
        assert.equal((await findCompetition(db, "featured-test-curve"))?.coin_type, testCurve);
        assert.deepEqual(
          (await readSwapCompetitions(db, start + 60_000)).competitions.map((event) => event.slug),
          ["featured-next"],
        );
        const ended = await readSwapCompetitions(db, start + 120_000);
        assert.deepEqual(ended.competitions, []);
        assert.equal(ended.next_change_at_ms, null);
        const publicRead = await route(
          new Request("https://blast.fun/api/social/competitions?placement=swap"), testClient()
        );
        assert.equal(publicRead.status, 200);
        assert.equal(publicRead.headers.get("cache-control"), "private, no-store");
        assert.deepEqual(
          (await publicRead.json()).competitions.map((event: { slug: string }) => event.slug),
          ["featured-next"],
        );
        for (const query of [
          "placement=unknown",
          "placement=swap&placement=swap",
          "placement=swap&page=1",
          "placement=swap&slug=coin-week",
          "placement=swap&period=current",
        ]) {
          assert.equal(
            (await route(new Request(`https://blast.fun/api/social/competitions?${query}`), testClient())).status,
            400,
          );
        }
        await admin.query("DELETE FROM social_competitions WHERE slug LIKE 'featured-%'");
        await admin.query("DELETE FROM blast_infra_fixture.coin_metadata WHERE coin_type = $1", [
          COIN,
        ]);
      },
    );
    await t.test(
      "archive applies the time boundary before pagination and keeps event links readable",
      async () => {
        assert.equal((await listCompetitions(db, 1, "current", start)).competitions.length, 1);
        assert.equal(
          (await listCompetitions(db, 1, "current", start + 60_000)).competitions.length,
          0,
        );
        assert.equal(
          (await listCompetitions(db, 1, "past", start + 60_000)).competitions.length,
          1,
        );
        assert.equal((await listCompetitions(db, 1, "past", start)).competitions.length, 0);
        const past = await route(
          new Request("https://blast.fun/api/social/competitions?period=past"), testClient()
        );
        assert.equal(past.status, 200);
        assert.equal((await past.json()).competitions[0].slug, input.slug);
        for (const period of ["unknown", "past&period=current"]) {
          assert.equal(
            (await route(new Request(`https://blast.fun/api/social/competitions?period=${period}`), testClient()))
              .status,
            400,
          );
        }
        for (let n = 0; n < 26; n++) {
          await createCompetition(
            web,
            {
              ...input,
              slug: `upcoming-${n}`,
              starts_at_ms: start + 120_000,
              ends_at_ms: start + 180_000,
            },
            operator,
          );
        }
        const pastPage = await listCompetitions(db, 1, "past", start + 60_000);
        assert.deepEqual(
          pastPage.competitions.map((event) => event.slug),
          [input.slug],
        );
        assert.equal(pastPage.has_more, false);
        const currentPage = await listCompetitions(db, 1, "current", start + 60_000);
        assert.equal(currentPage.competitions.length, 25);
        assert.equal(currentPage.has_more, true);
        assert.equal(
          (await listCompetitions(db, 2, "current", start + 60_000)).competitions.length,
          1,
        );
        assert.equal((await findCompetition(db, input.slug))?.coin_icon_url, input.coin_icon_url);
        await admin.query("DELETE FROM social_competitions WHERE slug LIKE 'upcoming-%'");
      },
    );
    const accounts: string[] = [];
    for (let n = 1; n <= 30; n++) {
      const id = randomUUID();
      accounts.push(id);
      await admin.query(
        `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, sharing_since)
      VALUES ($1, $2, $3, $3, to_timestamp($4 / 1000.0))`,
        [id, `did:privy:competition-${n}`, `member${n}`, start - 100_000],
      );
      await admin.query(
        `INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
        [hex(n + 100), id, start - 100_000],
      );
    }
    const alice = accounts[0]!;
    await admin.query(
      `INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, to_timestamp($3 / 1000.0))`,
      [hex(999), alice, start - 100_000],
    );
    async function receipt(
      n: number,
      usd: string | null,
      options: {
        at?: number;
        sender?: string;
        inCoin?: string;
        outCoin?: string;
        success?: boolean;
        account?: string;
        tracked?: boolean;
      } = {},
    ) {
      const id = randomUUID();
      const success = options.success ?? true;
      await admin.query(
        `INSERT INTO social_swap_intents
      (trade_id, account_id, idempotency_key, quote_digest, side, sender, in_coin, out_coin, amount_in, amount_out,
       min_out, slippage_bps, route, quote_expires_at_ms, usd_value, tx_bytes, digest, fee_payer, expires_at_ms, state, track_receipt)
      VALUES ($1, $2, $3, $4, 'buy', $5, $6, $7, 100, 200, 190, 100, '[{}]', $8, $9, $10, $11, 'wallet', $8, 'built', $12)`,
        [
          id,
          options.account ?? accounts[n - 1],
          randomUUID(),
          Buffer.alloc(32),
          options.sender ?? hex(n + 100),
          options.inCoin ?? SUI,
          options.outCoin ?? COIN,
          start + 100_000,
          usd,
          Buffer.from([1]),
          randomBytes(32).toString("hex").replaceAll("0", "a").replaceAll("l", "b").slice(0, 44),
          options.tracked ?? true,
        ],
      );
      await admin.query(
        `INSERT INTO social_swap_receipts (trade_id, timestamp_ms, checkpoint, success, amount_out) VALUES ($1, $2, 42, $3, $4)`,
        [id, options.at ?? start + 1000, success, success ? "200" : null],
      );
    }
    await t.test(
      "configuration is canonical, future-only, audited and immutable to the runtime",
      async () => {
        assert.deepEqual(await findCompetition(db, input.slug), competition);
        assert.equal((await listCompetitions(db, 1)).competitions.length, 1);
        assert.equal(
          (await admin.query("SELECT created_by FROM social_competitions")).rows[0].created_by,
          "operator:fixture",
        );
        await assert.rejects(
          createCompetition(web, { ...input, slug: "old-event", starts_at_ms: 1 }, operator),
        );
        await assert.rejects(
          web.query("UPDATE social_competitions SET ends_at_ms = ends_at_ms + 1"),
          { code: "42501" },
        );
        await assert.rejects(web.query("DELETE FROM social_competitions"), {
          code: "42501",
        });
        assert.equal(await findCompetition(db, "missing-event"), null);
      },
    );
    await t.test(
      "parity (0141): a structured prize round-trips in whole coins; the table refuses a partial or unruled one",
      async () => {
        assert.deepEqual([competition.prize_amount, competition.prize_coin_type, competition.prize_coin_symbol], [null, null, null]);
        const prized = await createCompetition(web, competitionInput.parse({
          ...input, slug: "prize-week", rules_url: "https://x.com/example/status/1",
          prize_amount: "25000.50", prize_coin_type: COIN, prize_coin_symbol: "COIN",
        }), operator);
        assert.deepEqual([prized.prize_amount, prized.prize_coin_type, prized.prize_coin_symbol], ["25000.5", COIN, "COIN"]);
        assert.deepEqual(await findCompetition(db, "prize-week"), prized);
        const insert = (slug: string, columns: string, values: string) => web.query(
          `INSERT INTO social_competitions (slug, name, coin_type, coin_symbol, starts_at_ms, ends_at_ms, created_by${columns})
           VALUES ($1, 'x', $2, 'COIN', $3, $4, 'operator:fixture'${values})`, [slug, COIN, start, start + 60_000]);
        await assert.rejects(insert("partial-prize", ", rules_url, prize_amount", ", 'https://x.com/a/status/1', 5"), { code: "23514" });
        await assert.rejects(insert("unruled-prize", ", prize_amount, prize_coin_type, prize_coin_symbol", `, 5, '${COIN}', 'COIN'`), { code: "23514" });
        await assert.rejects(insert("zero-prize", ", rules_url, prize_amount, prize_coin_type, prize_coin_symbol", `, 'https://x.com/a/status/1', 0, '${COIN}', 'COIN'`), { code: "23514" });
        await admin.query("DELETE FROM social_competitions WHERE slug = 'prize-week'");
      },
    );
    await t.test(
      "combines member wallets and buys/sells once, exact decimals, ties and unknown USD",
      async () => {
        await receipt(1, "0.10", { at: start });
        await receipt(1, "0.20", {
          sender: hex(999),
          inCoin: COIN,
          outCoin: SUI,
        });
        await receipt(1, null);
        await receipt(2, "0.30");
        await receipt(3, null);
        await receipt(4, "0.00");
        const rows = (await board()).members;
        assert.deepEqual(
          rows
            .slice(0, 2)
            .map((r) => [r.rank, r.volume_usd])
            .sort(),
          [
            [1, "0.30"],
            [1, "0.30"],
          ],
        );
        const member = rows.find((r) => r.account_id === alice)!;
        assert.deepEqual(
          [member.swaps, member.unpriced_swaps, member.addresses],
          [3, 1, [hex(101), hex(999)]],
        );
        assert.equal(rows.find((r) => r.account_id === accounts[2])?.rank, null);
        assert.equal(rows.find((r) => r.account_id === accounts[3])?.rank, 3);
      },
    );
    await t.test(
      "excludes end boundary, outside coin, failures, future receipts and pre-rollout swaps",
      async () => {
        await receipt(1, "900", { at: start - 1 });
        await receipt(1, "900", { at: start + 60_000 });
        await receipt(1, "900", { outCoin: OTHER });
        await receipt(1, "900", { success: false });
        await receipt(1, "900", { tracked: false });
        assert.equal(
          (await board()).members.find((r) => r.account_id === alice)?.volume_usd,
          "0.30",
        );
        assert.equal((await readCompetitionBoard(db, competition, 1, start - 1)).members.length, 0);
      },
    );
    await t.test("orders numeric USD totals rather than their display strings", async () => {
      await receipt(5, "10.00");
      await receipt(6, "2.00");
      const result = await board();
      assert.deepEqual(
        result.members.slice(0, 2).map((row) => row.volume_usd),
        ["10.00", "2.00"],
      );
    });
    await t.test(
      "live privacy, sharing/link times and recorded account prevent historical claims",
      async () => {
        await admin.query(
          "UPDATE social_accounts SET privacy = 'private', sharing_since = NULL WHERE account_id = $1",
          [alice],
        );
        assert.equal(
          (await board()).members.some((r) => r.account_id === alice),
          false,
        );
        await admin.query(
          "UPDATE social_accounts SET privacy = 'public', sharing_since = to_timestamp($2 / 1000.0) WHERE account_id = $1",
          [alice, start + 2000],
        );
        assert.equal(
          (await board()).members.some((r) => r.account_id === alice),
          false,
        );
        await receipt(5, "900", { account: accounts[1] }); // Wallet belongs to another member.
        await admin.query(
          "UPDATE social_account_wallets SET verified_at = to_timestamp($2 / 1000.0) WHERE account_id = $1",
          [accounts[1], start + 2000],
        );
        assert.equal(
          (await board()).members.some((r) => r.account_id === accounts[1]),
          false,
        );
      },
    );
    await t.test(
      "database pagination is stable across ties with no duplicated members",
      async () => {
        for (let n = 6; n <= 30; n++) await receipt(n, "1.00");
        const first = await board();
        const second = await readCompetitionBoard(db, competition, 2, start + 90_000);
        assert.equal(first.members.length, 25);
        assert.equal(first.has_more, true);
        assert.equal(second.has_more, false);
        // The "Traders" tile: every member the board counts, the same on each page and past the last.
        const total = first.members.length + second.members.length;
        assert.deepEqual([first.members_total, second.members_total], [total, total]);
        const past = await readCompetitionBoard(db, competition, 9, start + 90_000);
        assert.deepEqual([past.members, past.members_total, past.has_more], [[], total, false]);
        assert.equal((await readCompetitionBoard(db, competition, 1, start - 1)).members_total, 0, "before the start: nobody");
        const ids = [...first.members, ...second.members].map((r) => r.account_id);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(first.members[0]?.volume_usd, "10.00");
        assert.equal(first.members[2]?.rank, 3);
        assert.equal(second.members.at(-1)?.volume_usd, null);
        // Gap 15: a viewer's own row is the board's, past the first page too; off the board it is null.
        for (const member of [first.members[0]!, first.members[2]!, second.members.at(-1)!]) {
          const own = await readCompetitionViewerRank(db, competition, member.account_id, start + 90_000);
          assert.deepEqual(own.member, member);
          assert.equal(own.competition.slug, competition.slug);
          assert.equal(own.members_total, total);
        }
        const offBoard = await readCompetitionViewerRank(db, competition, alice, start + 90_000);
        assert.equal(offBoard.member, null, "alice's swaps predate her sharing: not on the board");
        assert.equal(offBoard.members_total, total, "the count does not depend on the viewer");
        assert.equal((await readCompetitionViewerRank(db, competition, "00000000-0000-4000-8000-00000000dead", start + 90_000)).member, null);
      },
    );
  },
);
