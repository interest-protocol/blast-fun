import assert from "node:assert/strict";
import test from "node:test";

import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useLiveCoins } = await import("./use-live-coins");

function standalone(symbol: string, venue: "cetus" | "bluefin"): HomeCoin {
  return {
    presale_id: null, coin_type: `0x1::coin::${symbol}`, symbol, name: symbol, icon_url: null,
    decimals: 9, lifecycle: "migrated", venue, tradable: true, opened_ms: null, launched_ms: null, launch_id: null,
    quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 }, sale: null,
    price_usd: "1", price_as_of_ms: 1, change_24h_bps: null, holders: null,
    holders_as_of_ms: null, fdv_usd: null, spark: [],
    activity: { scope: "pool", window: "24h", from_ms: 0, to_ms: 1, participants: 0, events: 0,
      buyers: 0, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null, preview: [] },
    top_holders: { holders: [], share_bps: null }, discussion: { posts: 0 }, rank: { score: 0, why: "" },
  };
}

test("standalone coins keep distinct rows and prices when restoring history across a ranking change", async t => {
  const tide = standalone("TIDE", "cetus");
  const orbit = standalone("ORBIT", "bluefin");
  const original = [tide, orbit];
  const refreshed = [{ ...orbit, price_usd: "3" }, { ...tide, price_usd: "2" }];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); });
  function List({ coins }: Readonly<{ coins: readonly HomeCoin[] | undefined }>) {
    const live = useLiveCoins(coins, "coins:discover");
    return <ol>{live.map(coin => <li key={coin.coin_type}>{coin.symbol}:{coin.price_usd}</li>)}</ol>;
  }
  window.history.replaceState({ blastListContent: { "coins:discover": original } }, "", "/");
  const entry = structuredClone(window.history.state);
  await act(async () => root.render(<List coins={undefined} />));
  const rows = () => Array.from(container.querySelectorAll("li"), row => row.textContent);
  assert.deepEqual(rows(), ["TIDE:1", "ORBIT:1"], "cached native coins render before the network read");
  await act(async () => root.render(<List coins={refreshed} />));
  assert.deepEqual(rows(), ["ORBIT:3", "TIDE:2"], "fresh prices and ranking update without collapsing native rows");
  await act(async () => {
    window.history.replaceState(entry, "", "/");
    window.dispatchEvent(new window.PopStateEvent("popstate", { state: entry }));
  });
  assert.deepEqual(rows(), ["TIDE:2", "ORBIT:3"], "back restores both native identities while retaining fresh prices");
});

test("a held coin retains its streamed price until a newer read actually includes that coin", async t => {
  const { newerHomePrice } = await import("./use-home-prices");
  const first = standalone("FIRST", "cetus");
  const held = { ...standalone("HELD", "cetus"), coin_type: `0x${"1".repeat(64)}::coin::HELD` };
  const incoming = standalone("NEW", "cetus");
  const prices = new Map([[held.coin_type, { coin_type: held.coin_type, checkpoint: 11, as_of_ms: 2, usd_price: "3" }]]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(() => root.unmount()); container.remove(); window.history.replaceState(null, "", "/"); });

  function List({ coins, checkpoint }: Readonly<{ coins: readonly HomeCoin[]; checkpoint: number }>) {
    const shown = useLiveCoins(coins, "newest:held", { checkpoint, holdIncoming: true });
    return <ol>{shown.map(coin => <li key={coin.coin_type}>
      {newerHomePrice(prices, coin, coin.readCheckpoint ?? 0)?.usd_price ?? coin.price_usd}
    </li>)}</ol>;
  }
  const render = (coins: readonly HomeCoin[], checkpoint: number) => act(() => root.render(<List coins={coins} checkpoint={checkpoint} />));
  const texts = () => [...container.querySelectorAll("li")].map(row => row.textContent);
  await render([first, held], 10);
  assert.deepEqual(texts(), ["1", "3"]);
  await render([incoming, { ...first, price_usd: "2" }], 12);
  assert.deepEqual(texts(), ["2", "3"], "an unrelated page checkpoint cannot roll the held coin back");
  await render([first, { ...held, price_usd: "4" }], 12);
  assert.deepEqual(texts(), ["1", "4"], "a read containing that coin supersedes the older stream frame");
});
