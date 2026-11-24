import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AllCoins } from "./CoinSheet";

import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";

/**
 * R3-10's favourites and All coins: the markup of each state, rendered as
 * the server would (the reads themselves are browser-only, so nothing here
 * is in the public HTML).
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]!);

test("R3-10 §14.2: the All-coins screen — the favourites row, the section line, and a star per coin", () => {
  const none = renderToStaticMarkup(<AllCoins coins={FIXTURE_COINS} hidden={false} onOpen={() => undefined} pins={[]} />);
  // Nothing starred yet: no favourites row, and the section line says what the star is for.
  assert.doesNotMatch(none, /coinFavs/);
  assert.match(text(none), /^All coins/);
  assert.deepEqual(labels(none), ["Search your coins", "Pin SUI to favourites", "Pin Kestrel to favourites", "Pin USDC to favourites", "Pin Lumen to favourites"]);
  assert.equal(none.match(/aria-pressed="false"/g)?.length, 4);
  assert.doesNotMatch(none, /disabled/);

  const some = renderToStaticMarkup(<AllCoins coins={FIXTURE_COINS} hidden={false} onOpen={() => undefined} pins={["lumn", "usdc"]} />);
  // The favourites row: the coin and its value, nothing more, in pin order.
  assert.match(some, /<div aria-label="Favourites" class="coinFavs" role="group">/);
  assert.match(text(some), /^LUMN \$130 USDC \$860 All coins/);
  // A favourite chip names its coin and value for a screen reader; the chip itself shows the ticker and the value.
  assert.deepEqual(labels(some).slice(0, 2), ["Favourites", "Lumen, $130"]);
  assert.match(some, /aria-label="Unpin Lumen" aria-pressed="true"/);
  assert.match(some, /aria-label="Pin SUI to favourites" aria-pressed="false"/);
  // Holdings follow USD value. Pinning leaves that order unchanged.
  // Each row's bare `<b>` is its name; the figures carry `class="num"`.
  const list = some.slice(some.indexOf('class="coinList'));
  assert.deepEqual([...list.matchAll(/<b>([^<]+)<\/b>/g)].map((match) => match[1]!), ["SUI", "Kestrel", "USDC", "Lumen"]);
  assert.deepEqual([...none.matchAll(/<b>([^<]+)<\/b>/g)].map((match) => match[1]!), ["SUI", "Kestrel", "USDC", "Lumen"]);
  assert.equal([...some.matchAll(/class="[^"]*coinPinrow[^"]*on[^"]*"/g)].length, 2, "two rows read as starred");
});

test("R3-10: the sixth star is disabled and says the limit", () => {
  const five = ["usdc", "sui", "kstl", "lumn", "spare"];
  const coins = [...FIXTURE_COINS, { ...FIXTURE_COINS[2]!, key: "spare", name: "Spare", symbol: "SPR" }, { ...FIXTURE_COINS[2]!, key: "sixth", name: "Sixth", symbol: "SIX" }];
  const html = renderToStaticMarkup(<AllCoins coins={coins} hidden={false} onOpen={() => undefined} pins={five} />);
  assert.match(html, /aria-label="Up to 5 favourites" aria-pressed="false"[^>]*disabled/);
  assert.equal(html.match(/disabled/g)?.length, 1, "only the unstarred coin's star is disabled");
  assert.match(text(html), /All coins/);
});
