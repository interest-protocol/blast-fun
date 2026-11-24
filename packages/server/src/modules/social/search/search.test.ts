import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSearchQuery, peopleForViewer, socialSearchPath } from "@blast/core/modules/social/contracts/search.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { likeLiteral } from "@blast/server/modules/social/search/read.ts";
import { searchTermOf, termLengthLabel } from "@blast/server/modules/social/search/route.ts";
import { decodeWatchlistCursor, parseWatchlistQuery } from "@blast/server/modules/social/watchlist/route.ts";
import { encodeWatchlistCursor } from "@blast/server/modules/social/watchlist/store.ts";

test("UI-12 (§12): a term is trimmed, collapsed, lowercased, without a leading @ or $; at most 64 characters", () => {
  assert.equal(normalizeSearchQuery("  Luca   ROMANO "), "luca romano");
  assert.equal(normalizeSearchQuery("@lucaromano"), "lucaromano");
  assert.equal(normalizeSearchQuery("$MRDN"), "mrdn");
  assert.equal(normalizeSearchQuery("ｍｅ"), "me");
  assert.equal(normalizeSearchQuery("x".repeat(64)), "x".repeat(64));
  assert.equal(normalizeSearchQuery("x".repeat(65)), null);
  assert.equal(normalizeSearchQuery("@"), "");
  assert.equal(socialSearchPath(" Me "), "/api/social/search?q=me");
  assert.equal(socialSearchPath(""), "/api/social/search");
  assert.equal(socialSearchPath("a&b"), "/api/social/search?q=a%26b");
});

test("UI-12: LIKE wildcards in a term are literal; the metric names the length class, never the term", () => {
  assert.equal(likeLiteral("50%_off\\"), "50\\%\\_off\\\\");
  assert.equal(termLengthLabel(""), "none");
  assert.equal(termLengthLabel("m"), "1");
  assert.equal(termLengthLabel("me"), "2");
  assert.equal(termLengthLabel("meridian"), "3+");
});

test("UI-12: the route reads q once; two or a long one is invalid_parameter (q)", () => {
  assert.equal(searchTermOf(new URL("https://blast.fun/api/social/search?q=%40Luca")), "luca");
  assert.equal(searchTermOf(new URL("https://blast.fun/api/social/search")), "");
  for (const url of ["https://blast.fun/api/social/search?q=a&q=b", `https://blast.fun/api/social/search?q=${"y".repeat(70)}`]) {
    assert.throws(() => searchTermOf(new URL(url)), (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === "q");
  }
});

test("UI-12: the viewer is left out in the browser, five people at most", () => {
  const people = ["kai", "a", "b", "c", "d", "e"].map((callsign) => ({ callsign }));
  assert.deepEqual(peopleForViewer(people, "kai").map((p) => p.callsign), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(peopleForViewer(people, null).map((p) => p.callsign), ["kai", "a", "b", "c", "d"]);
});

test("UI-12 (OA-11): watchlist cursors round-trip exactly (microseconds); limit and cursor are checked", () => {
  const cursor = { atUs: "1791682351759123", presaleId: `0x${"ab".repeat(32)}`, followed: false };
  assert.deepEqual(decodeWatchlistCursor(encodeWatchlistCursor(cursor)), cursor);
  assert.deepEqual(parseWatchlistQuery(new URL("https://blast.fun/x")), { limit: 20, cursor: null, includeFollows: false });
  assert.equal(parseWatchlistQuery(new URL("https://blast.fun/x?limit=50")).limit, 50);
  for (const query of ["limit=0", "limit=51", "limit=1.5", "limit=1&limit=2", "cursor=nope", `cursor=${Buffer.from(JSON.stringify(["-1", cursor.presaleId])).toString("base64url")}`]) {
    assert.throws(() => parseWatchlistQuery(new URL(`https://blast.fun/x?${query}`)), (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter", query);
  }
});

test("UI-12b (OA-17): include=follows; a followed presale's cursor round-trips and needs it", () => {
  const followed = { atUs: "1791682351759123", presaleId: `0x${"cd".repeat(32)}`, followed: true };
  const raw = encodeWatchlistCursor(followed);
  assert.deepEqual(decodeWatchlistCursor(raw), followed);
  assert.deepEqual(parseWatchlistQuery(new URL(`https://blast.fun/x?include=follows&cursor=${raw}`)), { limit: 20, cursor: followed, includeFollows: true });
  assert.equal(parseWatchlistQuery(new URL("https://blast.fun/x?include=follows")).includeFollows, true);
  const bad = (parts: unknown[]) => Buffer.from(JSON.stringify(parts)).toString("base64url");
  for (const [query, parameter] of [
    [`cursor=${raw}`, "cursor"],
    ["include=stars", "include"],
    ["include=follows&include=follows", "include"],
    [`include=follows&cursor=${bad([followed.atUs, followed.presaleId, "x"])}`, "cursor"],
    [`include=follows&cursor=${bad([followed.atUs, followed.presaleId, "f", 1])}`, "cursor"],
  ] as const) {
    assert.throws(
      () => parseWatchlistQuery(new URL(`https://blast.fun/x?${query}`)),
      (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === parameter,
      query,
    );
  }
});
