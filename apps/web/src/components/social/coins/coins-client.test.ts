import assert from "node:assert/strict";
import test from "node:test";

import type { SocialWallet } from "@blast/core/modules/social/contracts/coins.ts";
import { PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { walletCoinList, walletListParams } from "@blast/server/modules/social/coins/coin-list.ts";
import { walletCoinViews } from "./coin-model";
import { fetchWallet } from "./coins-client";

const emptyWallet: SocialWallet = {
  address: `0x${"1".padStart(64, "0")}`, signer: "wallet", fee: "wallet", as_of_ms: 1,
  coins: PREFERRED_COINS.map(coin => ({
    coin_type: coin.coinType, symbol: coin.symbol, name: coin.name, decimals: coin.decimals,
    atoms: "0", usd_price: null, value_usd: "0.00", icon_url: coin.logoUrl, presale: null,
  })),
};
const symbols = ["SUI", "USDC", "USDsui"];
const getAccessToken = async () => "test-token";

test("the unpaginated wallet accepts preferred coins with zero balances", async () => {
  const result = await fetchWallet({ getAccessToken, fetch: async () => Response.json(emptyWallet) });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") assert.fail("valid zero balances must load");
  assert.deepEqual(walletCoinViews(result.body).map(coin => [coin.symbol, coin.atoms, coin.amount]),
    symbols.map(symbol => [symbol, 0n, 0]));
});

for (const mode of ["all", "deposit", "withdraw"]) {
  for (const hideSmall of [false, true]) {
    test(`${mode} wallet listing keeps zero preferred balances with hide_small=${hideSmall}`, async () => {
      const result = await fetchWallet({ getAccessToken, fetch: async input => {
        const params = walletListParams(new URL(String(input), "https://blast.test").href);
        assert.ok(params);
        assert.equal(params.mode, mode);
        assert.equal(params.hideSmall, hideSmall);
        return Response.json(walletCoinList(emptyWallet, params));
      } }, { page: 1, mode, hide_small: hideSmall });
      assert.equal(result.status, "ok");
      if (result.status !== "ok") assert.fail("valid zero balances must load");
      assert.deepEqual(result.body.coins?.map(coin => [coin.symbol, coin.atoms]), symbols.map(symbol => [symbol, "0"]));
      assert.equal(result.body.listing?.total, 3);
      assert.deepEqual(result.body.listing?.extra_coins.map(coin => coin.symbol), symbols);
      assert.equal(walletCoinViews(result.body).length, 3, "extra coins do not duplicate visible rows");
    });
  }
}

test("search retains zero preferred coins outside the visible page for selection", async () => {
  const result = await fetchWallet({ getAccessToken, fetch: async input => {
    const params = walletListParams(new URL(String(input), "https://blast.test").href);
    assert.ok(params);
    return Response.json(walletCoinList(emptyWallet, params));
  } }, { page: 1, q: "no matching coin" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") assert.fail("zero extra coins must load independently of visible rows");
  assert.deepEqual(result.body.coins, []);
  assert.equal(result.body.listing?.total, 0);
  assert.deepEqual(walletCoinViews(result.body).map(coin => [coin.symbol, coin.atoms]), symbols.map(symbol => [symbol, 0n]));
});

for (const location of ["coins", "extra_coins"]) {
  test(`malformed amounts in ${location} still reject the wallet response`, async () => {
    for (const atoms of ["-1", "0.0", "00", ""]) {
      const coins = [{ ...emptyWallet.coins![0]!, atoms }];
      const body = location === "coins" ? { ...emptyWallet, coins } : {
        ...emptyWallet, coins: [], listing: { page: 1, page_size: 20, total: 0, value_usd: "0.00", extra_coins: coins },
      };
      const result = await fetchWallet({ getAccessToken, fetch: async () => Response.json(body) });
      assert.equal(result.status, "error", `${location} must reject ${JSON.stringify(atoms)}`);
      if (result.status !== "error") assert.fail("malformed amounts must not load");
      assert.equal(result.code, "invalid_response");
    }
  });
}
