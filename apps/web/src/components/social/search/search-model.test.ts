import { QueryClient } from "@tanstack/react-query";
import assert from "node:assert/strict";
import test from "node:test";

import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import type { SocialSearchResponse } from "@blast/core/modules/social/contracts/search.ts";
import type { SocialTradeCoin } from "@blast/core/modules/social/contracts/trades.ts";

import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { createSearchClient, isSearchResponse } from "./search-client";
import {
  RECENTS_KEY,
  coinPriceAsk,
  listedCoins,
  moveHighlight,
  noCoinMatchText,
  noCoinMatches,
  noMatchText,
  noMatches,
  pricedCoins,
  readRecents,
  rememberRecent,
  searchGroups,
  searchHref,
} from "./search-model";

const AS_OF = { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 };
const sale = (name: string, symbol: string) => ({ presale_id: `0x${name.length.toString(16).padStart(64, "0")}`, name, symbol, icon_url: "", phase: "open" as const });
const person = (callsign: string) => ({ callsign, display_name: callsign, avatar_url: null, verified: false });
const ANSWER: SocialSearchResponse = {
  query: "",
  presales: [sale("Meridian", "MRDN"), sale("Tidal", "TIDE")],
  people: ["kaimoreno", "blast", "lucaromano", "mirachen", "theopark", "anasouza"].map(person),
  as_of: AS_OF,
};

test("a JustOneSui search result opens the indexed coin page", () => {
  const coinType = "0xaaffd090b57fcdcf293f7e7ec59c119acc910eeb5fc4aadfb4185fa56b6a2cb5::suipump::SUIPUMP";
  const listing = listedCoins("JustOneSui", [{
    coin_type: coinType, name: "JustOneSui", symbol: "ONE", decimals: 6,
    presale_id: null, icon_url: null, usd_price: null,
  }]);
  const [row] = searchGroups("JustOneSui", null, [], null, pricedCoins(listing, []))[0]!.rows;
  assert.equal(row?.kind === "coin" ? row.href : null, `/coin/${encodeURIComponent(coinType)}`);
});

function memoryStorage(initial: Record<string, string> = {}, refuse = false) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuse) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
  };
}

test("UI-12 (§12): recents are five per device, newest first, the prototype's key and JSON", () => {
  assert.deepEqual(readRecents(null), []);
  assert.deepEqual(readRecents(memoryStorage({ [RECENTS_KEY]: "not json" })), []);
  assert.deepEqual(readRecents(memoryStorage({ [RECENTS_KEY]: JSON.stringify({ a: 1 }) })), []);
  assert.deepEqual(readRecents(memoryStorage({ [RECENTS_KEY]: JSON.stringify(["Meridian", 4, "", "luca", "x".repeat(65)]) })), ["Meridian", "luca"]);
  const storage = memoryStorage();
  let recents: string[] = [];
  for (const term of ["a", "b", "c", "d", "e", "f", "c"]) recents = rememberRecent(storage, recents, term);
  assert.deepEqual(recents, ["c", "f", "e", "d", "b"]);
  assert.equal(storage.data.get(RECENTS_KEY), JSON.stringify(["c", "f", "e", "d", "b"]));
  // Storage refusing the write keeps them for the page's life.
  assert.deepEqual(rememberRecent(memoryStorage({}, true), ["a"], "b"), ["b", "a"]);
});

test("UI-12 (§12): the sheet's groups: Recent only while nothing is typed, Presales, People without the viewer, at most five", () => {
  const empty = searchGroups("", ANSWER, ["Meridian", "luca"], "kaimoreno");
  assert.deepEqual(empty.map((group) => [group.title, group.rows.length]), [["Recent", 2], ["Presales", 2], ["People", 5]]);
  const people = empty[2]!.rows.map((row) => (row.kind === "person" ? row.person.callsign : ""));
  assert.deepEqual(people, ["blast", "lucaromano", "mirachen", "theopark", "anasouza"]);
  // A visitor: the server's sixth person is dropped instead.
  assert.deepEqual(searchGroups("", ANSWER, [], null).map((group) => [group.title, group.rows.length]), [["Presales", 2], ["People", 5]]);
  // Typing hides Recent; a presale remembers its name, a person its callsign.
  const typed = searchGroups(" me ", { ...ANSWER, people: [person("lucaromano")] }, ["Meridian"], null);
  assert.deepEqual(typed.map((group) => group.title), ["Presales", "People"]);
  assert.deepEqual(typed.flatMap((group) => group.rows.map((row) => (row.kind === "recent" ? row.term : row.kind === "coin" ? row.coin.key : row.pick))), ["Meridian", "Tidal", "lucaromano"]);
  // Before any answer only Recent shows.
  assert.deepEqual(searchGroups("", null, ["a"], null).map((group) => group.id), ["recent"]);
});

test("UI-12 (§12): no matches, its copy, the wrapping highlight and where a row goes", () => {
  const none: SocialSearchResponse = { query: "zzzz", presales: [], people: [], as_of: AS_OF };
  assert.equal(noMatches("zzzz", none, searchGroups("zzzz", none, [], null)), true);
  assert.equal(noMatches("", none, []), false);
  assert.equal(noMatches("zzzz", null, []), false);
  // Only the viewer matched: nothing left to show.
  const onlyMe: SocialSearchResponse = { ...none, people: [person("kaimoreno")] };
  assert.equal(noMatches("kai", onlyMe, searchGroups("kai", onlyMe, [], "kaimoreno")), true);
  assert.equal(noMatchText("  ZZZZ "), "No coins, presales or people match “zzzz”.");
  assert.equal(moveHighlight(0, "ArrowDown", 3), 1);
  assert.equal(moveHighlight(2, "ArrowDown", 3), 0);
  assert.equal(moveHighlight(0, "ArrowUp", 3), 2);
  assert.equal(moveHighlight(0, "ArrowUp", 0), 0);
  const [presales, people] = searchGroups("x", { ...ANSWER, query: "x" }, [], null);
  const first = presales!.rows[0]!;
  const someone = people!.rows[0]!;
  assert.ok(first.kind === "presale" && someone.kind === "person");
  assert.equal(searchHref(first), `/presale/${ANSWER.presales[0]!.presale_id}`);
  assert.equal(searchHref(someone), "/@kaimoreno");
});

test("UI-12: the search read: the normalized term (one cached answer per term), no credentials, remembered, failures as null", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let now = 0;
  const answer = { ...ANSWER, query: "me" };
  const client = createSearchClient(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(answer);
  }, () => now, undefined, async () => []);
  assert.deepEqual(await client.search("  ME "), answer);
  assert.equal(calls[0]!.url, "/api/social/search?q=me");
  assert.equal(calls[0]!.init?.credentials, "same-origin");
  // The same term again within ten seconds: from memory, no request.
  assert.deepEqual(client.remembered("me"), answer);
  assert.deepEqual(await client.search("me"), answer);
  assert.equal(calls.length, 1);
  now = 10_001;
  assert.equal(client.remembered("me"), null);
  // Suggestions: no query string.
  await client.search("");
  assert.equal(calls.at(-1)!.url, "/api/social/search");
  // A refusal, a network failure, a malformed body and a too-long term all read as null.
  assert.equal(await createSearchClient(async () => new Response("{}", { status: 503 })).search("a"), null);
  assert.equal(await createSearchClient(async () => { throw new TypeError("offline"); }).search("a"), null);
  assert.equal(await createSearchClient(async () => Response.json({ query: "a", presales: [{}], people: [] })).search("a"), null);
  assert.equal(await createSearchClient(async () => Response.json(answer)).search("x".repeat(65)), null);
  assert.equal(isSearchResponse(answer), true);
});

const hex64 = (n: number) => n.toString(16).padStart(64, "0");
const tradeCoin = (n: number, name: string, symbol: string, usd: string | null): SocialTradeCoin => ({
  coin_type: `0x${hex64(n)}::${symbol.toLowerCase()}::${symbol}`,
  symbol,
  name,
  decimals: 9,
  icon_url: null,
  usd_price: usd,
  presale_id: `0x${hex64(n)}`,
});
const NIMBUS = tradeCoin(11, "Nimbus", "NIMB", "0.0031");
const KESTREL = tradeCoin(12, "Kestrel", "KSTL", null);
const history = (presaleId: string | null, coinType: string, usd: string | null, bps: number | null): SocialPriceHistory => ({
  presale_id: presaleId, coin_type: coinType, tier: "5m", from_ms: 0, points: [], price_usd: usd, price_24h_usd: null, change_24h_bps: bps, day_open_usd: null, day_open_ms: null,
});

test("R3-82-AC-1: typing a coin's name or ticker lists it under Coins, before Presales, with its price and 24-hour move", () => {
  // "nim": the coins route answered Nimbus; SUI does not match. Its price is the route's, its move R3-20's change_24h_bps.
  const listed = listedCoins("Nim", [NIMBUS]);
  assert.deepEqual(listed.map((coin) => coin.key), [NIMBUS.presale_id]);
  assert.deepEqual(coinPriceAsk(listed[0]!), { kind: "presale", id: NIMBUS.presale_id });
  const coins = pricedCoins(listed, [history(NIMBUS.presale_id, NIMBUS.coin_type, "0.0030", 3260)]);
  const answer: SocialSearchResponse = { ...ANSWER, query: "nim", presales: [sale("Nimbus", "NIMB")], people: [] };
  const groups = searchGroups("nim", answer, ["Meridian"], null, coins);
  assert.deepEqual(groups.map((group) => group.title), ["Coins", "Presales"]);
  const row = groups[0]!.rows[0]!;
  assert.ok(row.kind === "coin");
  assert.deepEqual(row.coin, { key: NIMBUS.presale_id, coinType: NIMBUS.coin_type, name: "Nimbus", symbol: "NIMB", iconUrl: null, presaleId: NIMBUS.presale_id, price: 0.0031, changePct: 32.6 });
  // A ticker, with the `$` a symbol search may carry: SUI is the browser's own row, priced by its coin type's read.
  const sui = listedCoins("$SU", [{ ...NIMBUS, coin_type: SUI_COIN_TYPE, symbol: "SUI", name: "Sui", presale_id: null }]);
  assert.deepEqual(sui.map((coin) => [coin.key, coin.name, coin.symbol]), [["sui", "Sui", "SUI"]], "the route's SUI row does not list SUI twice");
  assert.deepEqual(coinPriceAsk(sui[0]!), { kind: "coin", id: SUI_COIN_TYPE });
  // Ecosystem rows retain their own keys: `usdc` for USDC, the coin type for other coins.
  const wal = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
  assert.deepEqual(listedCoins("usd", [{ ...NIMBUS, coin_type: USDC_COIN_TYPE, symbol: "USDC", presale_id: null }, { ...NIMBUS, coin_type: wal, symbol: "WAL", presale_id: null }]).map((coin) => coin.key), ["usdc", wal]);
  const [suiRow] = pricedCoins(sui, [history(null, SUI_COIN_TYPE, "3.42", 241)]);
  assert.deepEqual([suiRow!.price, suiRow!.changePct], [3.42, 2.41]);
});

test("R3-82: the Coins group: SUI first, three with nothing typed and five with a term; unknown figures omitted, never made up", () => {
  const many = [1, 2, 3, 4, 5, 6].map((n) => tradeCoin(n, `Coin ${n}`, `C${n}`, "1.5"));
  assert.deepEqual(listedCoins("", many).map((coin) => coin.symbol), ["SUI", "C1", "C2"]);
  assert.deepEqual(listedCoins("c", many).map((coin) => coin.symbol), ["C1", "C2", "C3", "C4", "C5"]);
  assert.deepEqual(listedCoins("s", many).map((coin) => coin.symbol), ["SUI", "C1", "C2", "C3", "C4"]);
  // No coin read yet: no group (the presales answer lands with it).
  assert.deepEqual(listedCoins("", null), []);
  assert.deepEqual(searchGroups("", null, [], null, []).map((group) => group.id), []);
  // Kestrel without a fresh route price takes the prices read's; without any read, no price and no move.
  const listed = listedCoins("k", [KESTREL]);
  assert.deepEqual(pricedCoins(listed, [history(KESTREL.presale_id, KESTREL.coin_type, "0.0021", null)]).map((coin) => [coin.price, coin.changePct]), [[0.0021, null]]);
  assert.deepEqual(pricedCoins(listed, [undefined]).map((coin) => [coin.price, coin.changePct]), [[null, null]]);
  assert.deepEqual(pricedCoins(listedCoins("sui", []), [null]).map((coin) => [coin.price, coin.changePct]), [[null, null]]);
  // A falling coin keeps its sign.
  assert.equal(pricedCoins(listed, [history(KESTREL.presale_id, KESTREL.coin_type, null, -182)])[0]!.changePct, -1.82);
});

test("R3-82: no-match copy: when a coin matches, no \"No coins, presales or people match\" line", () => {
  const none: SocialSearchResponse = { query: "sui", presales: [], people: [], as_of: AS_OF };
  const coins = pricedCoins(listedCoins("sui", []), [null]);
  const groups = searchGroups("sui", none, [], null, coins);
  assert.deepEqual(groups.map((group) => group.id), ["coins"]);
  assert.equal(noMatches("sui", none, groups), false);
  assert.equal(noMatches("zzzz", none, searchGroups("zzzz", none, [], null, pricedCoins(listedCoins("zzzz", []), []))), true);
});

test("WS-4: a term that finds people but no coin says no coin matched, once the coins read is in", () => {
  const people: SocialSearchResponse = { query: "kai", presales: [], people: [person("kaimoreno")], as_of: AS_OF };
  const groups = searchGroups("kai", people, [], null, []);
  assert.equal(noCoinMatches("kai", true, groups), true);
  assert.equal(noCoinMatches("kai", false, groups), false, "not before the coins read answers");
  assert.equal(noCoinMatches("", true, groups), false);
  // A coin match, or nothing at all (the full no-match line covers that), shows no extra line.
  assert.equal(noCoinMatches("sui", true, searchGroups("sui", people, [], null, pricedCoins(listedCoins("sui", []), [null]))), false);
  assert.equal(noCoinMatches("zzzz", true, searchGroups("zzzz", { ...people, people: [] }, [], null, [])), false);
  assert.equal(noCoinMatchText(" Kai "), "No coins match “kai”.");
});

test("R3-82: the coins read: the coins route for the term five at most, no credentials, remembered, failures as none", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let now = 0;
  const client = createSearchClient(async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ coins: [NIMBUS], next_cursor: null });
  }, () => now, undefined, async () => []);
  assert.equal(client.rememberedCoins("nim"), null);
  assert.deepEqual(await client.coins("  $NIM "), [NIMBUS]);
  assert.equal(calls[0]!.url, "/api/social/trades/coins?q=nim&limit=5&include_launch=1");
  assert.equal(calls[0]!.init?.credentials, "same-origin");
  assert.deepEqual(client.rememberedCoins("nim"), [NIMBUS]);
  assert.deepEqual(await client.coins("nim"), [NIMBUS]);
  assert.equal(calls.length, 1);
  now = 10_001;
  assert.equal(client.rememberedCoins("nim"), null);
  // Nothing typed: the first coins, no q.
  await client.coins("");
  assert.equal(calls.at(-1)!.url, "/api/social/trades/coins?limit=5");
  // A refusal, a network failure and a malformed body list no coins; a term the route cannot read asks nothing.
  assert.deepEqual(await createSearchClient(async () => new Response("{}", { status: 503 })).coins("a"), []);
  assert.deepEqual(await createSearchClient(async () => { throw new TypeError("offline"); }).coins("a"), []);
  assert.deepEqual(await createSearchClient(async () => Response.json({ coins: [{ symbol: "X" }], next_cursor: null })).coins("a"), []);
  const before = calls.length;
  assert.deepEqual(await client.coins("x".repeat(513)), []);
  assert.deepEqual(client.rememberedCoins("x".repeat(513)), []);
  assert.equal(calls.length, before);
});

test("cached search failures preserve safe codes and support references without provider text", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const client = createSearchClient(async () => Response.json({ error: { code: "provider-secret", message: "private database credentials" } }, { status: 503, headers: { "x-request-id": "search-ref" } }), Date.now, cache);
  assert.equal(await client.search("meridian"), null);
  const failure = client.failure("meridian");
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /Code: service_unavailable.*Reference: search-ref/);
  assert.doesNotMatch(failure.message, /provider-secret|private|credentials/);
  cache.clear();
});


test("uncached search preserves safe failure diagnostics and clears them after a successful retry", async () => {
  let attempts = 0;
  const answer = { query: "diagnosticsearch", presales: [], people: [], as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } };
  const client = createSearchClient(async () => ++attempts === 1
    ? Response.json({ error: { code: "service_unavailable", message: "private search provider token" } }, { status: 503, headers: { "X-Request-ID": "palette-search-reference" } })
    : Response.json(answer));
  assert.equal(await client.search("diagnosticsearch"), null);
  const error = client.failure("diagnosticsearch");
  assert.ok(error instanceof Error);
  assert.match(error.message, /Code: service_unavailable\. Reference: palette-search-reference\./);
  assert.doesNotMatch(error.message, /private search provider token/);
  assert.deepEqual(await client.search("diagnosticsearch"), answer);
  assert.equal(attempts, 2, "a failure is not cached as an empty result");
  assert.equal(client.failure("diagnosticsearch"), undefined);
  assert.deepEqual(client.remembered("diagnosticsearch"), answer);
});
