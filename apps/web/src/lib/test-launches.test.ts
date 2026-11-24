import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";
import type { DiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";
import type { HomeCoinsPage } from "@blast/core/modules/social/contracts/home.ts";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import type { SocialPresaleListPage } from "@blast/core/modules/social/contracts/presales.ts";
import { isTestQuoteType, readVisiblePage, testPresaleIds, withoutTestSearchPresales, withoutTestTradeCoins, withoutTestCoins, withoutTestHappening, withoutTestLaunches, withoutTestPosts, withoutTestPresalePage } from "./test-launches.ts";

const id = (n: number) => `0x${String(n).padStart(64, "0")}`;

test("Test SUI is recognised in any address spelling, and real quotes are not", () => {
  assert.equal(isTestQuoteType(CREATE_TEST_SUI_QUOTE_TYPE), true);
  const [address, ...rest] = CREATE_TEST_SUI_QUOTE_TYPE.split("::");
  assert.equal(isTestQuoteType(["0x" + address!.slice(2).toUpperCase(), ...rest].join("::")), true);
  assert.equal(isTestQuoteType(CREATE_SUI_QUOTE_TYPE), false);
  assert.equal(isTestQuoteType(null), false);
});

test("lists drop test launches and keep the rest", () => {
  const home = { coins: [{ quote: { type: CREATE_TEST_SUI_QUOTE_TYPE } }, { quote: { type: CREATE_SUI_QUOTE_TYPE } }], total: 9 } as unknown as HomeCoinsPage;
  assert.deepEqual(withoutTestCoins(home).coins.map((coin) => coin.quote.type), [CREATE_SUI_QUOTE_TYPE]);
  assert.equal(withoutTestCoins(home).total, 8);

  const feed = { items: [{ presale: { quote_symbol: "TSUI" } }, { presale: null }, { presale: { quote_symbol: "SUI" } }] };
  assert.equal(withoutTestPosts(feed).items.length, 2);

  const presales = { presales: [{ quote_type: CREATE_SUI_QUOTE_TYPE }, { quote_type: CREATE_TEST_SUI_QUOTE_TYPE }] } as unknown as SocialPresaleListPage;
  assert.deepEqual(withoutTestPresalePage(presales).presales.map((row) => row.quote_type), [CREATE_SUI_QUOTE_TYPE]);

  const discovery = { view: "new", section: { state: "available", data: { rows: [{ quoteType: CREATE_TEST_SUI_QUOTE_TYPE }, { quoteType: CREATE_SUI_QUOTE_TYPE }], nextCursor: null } } } as unknown as DiscoveryResponse;
  const kept = withoutTestLaunches(discovery).section;
  assert.ok(kept.state === "available");
  assert.deepEqual(kept.data.rows.map((row) => row.quoteType), [CREATE_SUI_QUOTE_TYPE]);
});

test("Home's live activity drops test sales, their tape rows and their top coins", () => {
  const sale = (n: number, quote: string) => ({ presale: { presale_id: id(n), coin_type: `${id(n)}::c::C`, quote_symbol: quote } });
  const read = {
    fastest: [sale(1, "TSUI"), sale(2, "SUI")],
    opening_soon: [],
    today: [sale(1, "TSUI")],
    recent_presales: [sale(1, "TSUI"), sale(2, "SUI"), sale(3, "TSUI")],
    tape: [
      { presale_id: id(1), quote_symbol: null },
      { presale_id: null, quote_symbol: "TSUI" },
      { presale_id: id(2), quote_symbol: "SUI" },
      { presale_id: id(3), quote_symbol: null },
    ],
    top_coins: { trending: [{ presale_id: id(1), coin_type: `${id(1)}::c::C` }, { presale_id: id(2), coin_type: `${id(2)}::c::C` }], gainers: [] },
  } as unknown as SocialHappeningResponse;
  const shown = withoutTestHappening(read);
  assert.deepEqual(shown.fastest.map(({ presale }) => presale.presale_id), [id(2)]);
  assert.deepEqual(shown.today, []);
  assert.deepEqual(shown.recent_presales?.map(({ presale }) => presale.presale_id), [id(2)]);
  assert.deepEqual(shown.tape.map((event) => event.presale_id), [id(2)]);
  assert.deepEqual(shown.top_coins?.trending.map((coin) => coin.presale_id), [id(2)]);
});

test("a page of only test launches reads on to the next page instead of showing empty", async () => {
  type Page = { rows: string[]; next: string | null };
  const pages: Record<string, Page> = { start: { rows: ["test"], next: "b" }, b: { rows: ["test", "real"], next: "c" } };
  const reads: (string | null)[] = [];
  const page = await readVisiblePage<Page>(
    null,
    async (cursor) => (reads.push(cursor), pages[cursor ?? "start"]!),
    (page) => ({ ...page, rows: page.rows.filter((row) => row !== "test") }),
    (page) => page.rows.length,
    (page) => page.next,
  );
  assert.deepEqual(reads, [null, "b"]);
  assert.deepEqual(page, { rows: ["real"], next: "c" });
});

test("trade rows of a migrated test sale are found by a cached by-id lookup", async () => {
  const read = {
    fastest: [], opening_soon: [], today: [],
    tape: [{ presale_id: id(7), quote_symbol: null }, { presale_id: id(8), quote_symbol: null }],
    top_coins: { trending: [{ presale_id: id(7), coin_type: null }], gainers: [] },
  } as unknown as SocialHappeningResponse;
  const asked: string[][] = [];
  const readCoins = async (ids: readonly string[]) => {
    asked.push([...ids]);
    return [{ presale_id: id(7), quote: { type: CREATE_TEST_SUI_QUOTE_TYPE } }, { presale_id: id(8), quote: { type: CREATE_SUI_QUOTE_TYPE } }];
  };
  const testIds = await testPresaleIds(read, readCoins);
  assert.deepEqual([...testIds], [id(7)]);
  const shown = withoutTestHappening(read, testIds);
  assert.deepEqual(shown.tape.map((event) => event.presale_id), [id(8)]);
  assert.deepEqual(shown.top_coins?.trending, []);
  await testPresaleIds(read, readCoins);
  assert.equal(asked.length, 1);
  // A failed lookup hides nothing and is retried next time.
  const fresh = { ...read, tape: [{ presale_id: id(9), quote_symbol: null }], top_coins: null } as unknown as SocialHappeningResponse;
  assert.equal((await testPresaleIds(fresh, async () => null)).size, 0);
});

test("coin pickers and search drop test sales, open ones by quote and migrated ones by a lookup", async () => {
  const readCoins = async (ids: readonly string[]) => ids.map((presale) => ({ presale_id: presale, quote: { type: presale === id(21) || presale === id(23) ? CREATE_TEST_SUI_QUOTE_TYPE : CREATE_SUI_QUOTE_TYPE } }));
  const page = {
    coins: [
      { presale_id: id(20), quote_type: CREATE_TEST_SUI_QUOTE_TYPE },
      { presale_id: id(21) },
      { presale_id: id(22) },
      { presale_id: null },
    ],
    next_cursor: null,
  };
  assert.deepEqual((await withoutTestTradeCoins(page, readCoins)).coins, [{ presale_id: id(22) }, { presale_id: null }]);
  const answer = { query: "x", presales: [{ presale_id: id(23) }, { presale_id: id(24) }], people: [] };
  assert.deepEqual((await withoutTestSearchPresales(answer, readCoins)).presales, [{ presale_id: id(24) }]);
});

test("pickers and search opening together share one lookup per presale", async () => {
  const reads: (readonly string[])[] = [];
  let answer: (() => void) | undefined;
  const readCoins = (ids: readonly string[]) => {
    reads.push(ids);
    return new Promise<readonly { presale_id: string; quote: { type: string } }[]>((resolve) => {
      answer = () => resolve(ids.map((presale) => ({ presale_id: presale, quote: { type: CREATE_TEST_SUI_QUOTE_TYPE } })));
    });
  };
  const picker = withoutTestTradeCoins({ coins: [{ presale_id: id(30) }], next_cursor: null }, readCoins);
  const search = withoutTestSearchPresales({ query: "x", presales: [{ presale_id: id(30) }], people: [] }, readCoins);
  answer!();
  assert.deepEqual((await picker).coins, []);
  assert.deepEqual((await search).presales, []);
  assert.deepEqual(reads, [[id(30)]]);
});

test("a failed lookup hides nothing and is asked again next time", async () => {
  let calls = 0;
  const readCoins = async (ids: readonly string[]) => {
    if (++calls === 1) throw new Error("offline");
    return ids.map((presale) => ({ presale_id: presale, quote: { type: CREATE_TEST_SUI_QUOTE_TYPE } }));
  };
  const page = { coins: [{ presale_id: id(31) }], next_cursor: null };
  assert.deepEqual((await withoutTestTradeCoins(page, readCoins)).coins, [{ presale_id: id(31) }]);
  assert.deepEqual((await withoutTestTradeCoins(page, readCoins)).coins, []);
  assert.equal(calls, 2);
});
