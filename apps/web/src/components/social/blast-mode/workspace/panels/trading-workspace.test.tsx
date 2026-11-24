import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { fixtureCoinType, fixtureWallet } from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { createWorkspaceStore } from "../model";
import { walletBalance, coinFacts } from "./coin-facts";
import { counterFacts } from "./counter-facts";
import { CoinTradeFields } from "./CoinTradeFields";
import type { SocialWallet } from "@blast/core/modules/social/contracts/coins.ts";

test("ticket, position and payment balances distinguish confirmed zero, invalid and bounded missing balances", () => {
  const type = fixtureCoinType("KSTL");
  const wallet = fixtureWallet("sponsored", { kstl: 0n });
  const coin = fixtureWallet().coins!.find(c => c.coin_type === type)!;
  assert.equal(walletBalance(wallet, type), 0n);
  assert.equal(coinFacts(type, null, wallet, true).held, 0n);
  assert.equal(walletBalance({ ...wallet, coins: null }, type), null);
  const invalid = { ...wallet, coins: [{ ...coin, atoms: "invalid" }] };
  assert.equal(walletBalance(invalid, type), null);
  const absent = { ...wallet, coins: wallet.coins!.filter(c => c.coin_type !== type) };
  assert.equal(walletBalance(absent, type), 0n);
  const bounded = { ...absent, listing: { extra_coins: [], next_cursor: "more" } } as unknown as SocialWallet;
  assert.equal(walletBalance(bounded, type), null);
  const choice = { coin: { coinType: type, symbol: "KSTL", decimals: 9 } } as Parameters<typeof counterFacts>[0];
  assert.equal(counterFacts(choice, bounded).balance, null);
  assert.equal(counterFacts(choice, invalid).balance, null);
  const expanded = { ...bounded, listing: { ...bounded.listing!, extra_coins: [{ ...coin, atoms: "1000" }] } };
  assert.equal(walletBalance(expanded, type), 1000n);
  assert.equal(counterFacts(choice, expanded).balance, 1000n);
  assert.equal(walletBalance({ ...wallet, coins: [{ ...coin, coin_type: "0x2::coin::A", atoms: "3" }] }, `0x${"2".padStart(64,"0")}::coin::A`), 3n);
});

test("zero and unknown Sell balances disable every percentage without changing the draft", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("KSTL"), presale_id: null });
  const setup = store.getSnapshot().panels.A!.coin.trade;
  const trade = { ...setup, side: "sell" as const };
  const facts = coinFacts(fixtureCoinType("KSTL"), null, fixtureWallet(), true);
  let changes = 0;
  try {
    for (const held of [0n, null, 1000n]) {
      await act(async () => root.render(<CoinTradeFields trade={trade} facts={{ ...facts, held }} busy={false} walletReady authenticated hidden={false} change={() => changes++} />));
      const presets = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Share of available token balance"] button')];
      assert.equal(presets.length, 4);
      assert.ok(presets.every(button => button.disabled === (held === null || held === 0n)));
      if (held !== 1000n) {
        await act(async () => presets[1]!.click());
        assert.equal(changes, 0);
      }
    }
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
