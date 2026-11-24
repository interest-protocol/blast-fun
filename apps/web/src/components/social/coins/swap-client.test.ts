import assert from "node:assert/strict";
import test from "node:test";

import { fetchTradeCoins, isTradeCoinPage, presaleCoinView } from "./swap-client";

/**
 * Social feed R3-33: the picker's read of `GET /api/social/trades/coins` is
 * public and CDN-cached, so it sends no credentials (no Authorization header,
 * no cookie, OA-16); a malformed or failed answer is null and the picker
 * lists the wallet's coins alone.
 */

const COIN = {
  coin_type: `0x${"5".repeat(64)}::coin::KSTL`,
  symbol: "KSTL",
  name: "Kestrel",
  decimals: 9,
  icon_url: null,
  usd_price: "0.0021",
  presale_id: `0x${"1".repeat(64)}`,
};

test("public coin metadata preserves identity and trading status without inventing a balance", () => {
  const sale = { presale_id: COIN.presale_id, sale_token: COIN.coin_type, sale_decimals: COIN.decimals, name: COIN.name, symbol: COIN.symbol, icon_url: "", price_usd: COIN.usd_price, phase: "trading", venue: "cetus", multiple: "4.2" };
  const coin = presaleCoinView({ presale: sale }, COIN.presale_id);
  assert.ok(coin);
  assert.equal(coin.key, COIN.presale_id);
  assert.equal(coin.coinType, COIN.coin_type);
  assert.equal(coin.atoms, 0n);
  assert.equal(coin.presale?.trading, true);
  assert.equal(coin.presale?.multiple, 4.2);
  assert.equal(presaleCoinView({ presale: { ...sale, phase: "funded" } }, COIN.presale_id)?.presale?.trading, false);
  for (const invalid of [{ ...sale, presale_id: `0x${"2".repeat(64)}` }, { ...sale, sale_decimals: 256 }, { ...sale, sale_token: "bad" }, { ...sale, phase: "unknown" }, { ...sale, icon_url: false }]) {
    assert.equal(presaleCoinView({ presale: invalid }, COIN.presale_id), null);
  }
  assert.equal(presaleCoinView({}, COIN.presale_id), null);
  for (const quote_symbol of ["USDC", "SUI", "TSUI"]) assert.equal(presaleCoinView({ presale: { ...sale, phase: "open", quote_symbol } }, COIN.presale_id)?.presale?.inPresale, true);
});

test("the page is checked coin by coin", () => {
  assert.equal(isTradeCoinPage({ coins: [COIN], next_cursor: null }), true);
  assert.equal(isTradeCoinPage({ coins: [{ ...COIN, decimals: 255 }], next_cursor: null }), true);
  assert.equal(isTradeCoinPage({ coins: [], next_cursor: "abc" }), true);
  for (const broken of [{ ...COIN, decimals: 256 }, { ...COIN, usd_price: 0.0021 }, { ...COIN, presale_id: "kstl" }, { ...COIN, coin_type: "KSTL" }, { ...COIN, symbol: "" }]) {
    assert.equal(isTradeCoinPage({ coins: [broken], next_cursor: null }), false);
  }
  assert.equal(isTradeCoinPage({ coins: null, next_cursor: null }), false);
});

test("a standalone coin response keeps its canonical identity without a presale binding", async () => {
  const standalone = { ...COIN, presale_id: null };
  const page = { coins: [standalone], next_cursor: null };
  assert.deepEqual(await fetchTradeCoins({ q: COIN.coin_type }, undefined, async () => Response.json(page)), page);
  assert.equal(isTradeCoinPage({ ...page, coins: [{ ...standalone, decimals: null }] }), false);
  assert.equal(isTradeCoinPage({ ...page, coins: [{ ...standalone, presale_id: false }] }), false);
});

test("the read sends no credentials, names its search, and preserves safe failure diagnostics", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const answer = (status: number, body: unknown) => async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return Response.json(body, { status });
  };
  assert.deepEqual(await fetchTradeCoins({ q: "kst" }, undefined, answer(200, { coins: [COIN], next_cursor: null }) as typeof fetch), { coins: [COIN], next_cursor: null });
  assert.equal(seen[0]!.url, "/api/social/trades/coins?q=kst");
  assert.equal(seen[0]!.init?.credentials, "same-origin");
  assert.equal(seen[0]!.init?.headers, undefined, "no Authorization header is built");
  await assert.rejects(fetchTradeCoins({}, undefined, answer(503, { error: { code: "service_unavailable" } }) as typeof fetch), /Code: service_unavailable/);
  await assert.rejects(fetchTradeCoins({}, undefined, answer(200, { coins: [{ nope: true }] }) as typeof fetch), /Code: invalid_response/);
  await assert.rejects(fetchTradeCoins({}, undefined, (async () => { throw new TypeError("offline"); }) as typeof fetch), /Code: network_unavailable/);
  assert.equal(seen[1]!.url, "/api/social/trades/coins");
});

test("coin picker reads preserve a server reference and redact private error copy", async () => {
  const request = async () => Response.json({ error: { code: "PRIVATE_PROVIDER_SECRET", message: "PRIVATE_PROVIDER_SECRET" } }, { status: 503, headers: { "x-request-id": "coin-picker-safe-ref" } });
  await assert.rejects(fetchTradeCoins({}, undefined, request), (error: Error) => /Code: service_unavailable.*Reference: coin-picker-safe-ref/.test(error.message) && !error.message.includes("PRIVATE_PROVIDER_SECRET"));
});
