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
  const prices = new Map([[held.coin_type, { coin_type: held.coin_type, checkpoint: 11, as_of_ms: 2, usd_price: "3", trade: null }]]);
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

// Fails if the price stream follows sorted coin types instead of the rows on screen.
test("Home streams prices for the first 20 migrated coins by row order, not by sorted coin type", async () => {
  const { homePriceCoins } = await import("./use-home-prices");
  const hex = (index: number) => (0xff - index).toString(16).padStart(2, "0").repeat(32);
  // Row order runs against sorted order: the top row has the largest coin type.
  const rows = Array.from({ length: 25 }, (_, index) => ({ ...standalone(`C${index}`, "cetus"), coin_type: `0x${hex(index)}::coin::C${index}` }));
  const curve = { ...rows[0], coin_type: `0x${"0".repeat(64)}::coin::CURVE`, lifecycle: "opened" as const };
  const picked = homePriceCoins([curve, ...rows]);
  assert.equal(picked.length, 20);
  assert.deepEqual(new Set(picked), new Set(rows.slice(0, 20).map(coin => coin.coin_type)), "the top 20 rows, not a coin that is not migrated");
  assert.deepEqual(homePriceCoins([...rows.slice(0, 20)].reverse()), picked, "a reorder of the same rows keeps the subscription");

  // A poll swaps rows 20 and 21: the streamed set stays, so no tab resubscribes.
  const swapped = [...rows.slice(0, 19), rows[20], rows[19], ...rows.slice(21)];
  assert.deepEqual(homePriceCoins(swapped, picked), picked, "a swap across row 20/21 keeps the key");
  // A streamed coin leaves the page: its slot goes to the first unstreamed row, in row order.
  const left = swapped.filter(coin => coin !== rows[3]);
  const refilled = homePriceCoins(left, picked);
  assert.equal(refilled.length, 20);
  assert.equal(refilled.includes(rows[3].coin_type), false, "the coin that left is dropped");
  assert.equal(refilled.includes(rows[20].coin_type), true, "its slot goes to the next row");
  assert.equal(refilled.includes(rows[21].coin_type), false);
});

// Fails if a SUI move cues every row, if a trade inside a SUI move is lost, or if a trade's direction follows the quote.
test("a coin's trade follows only its own moves, not the quote's", async () => {
  const { observeFrame } = await import("./use-home-prices");
  const coins = Array.from({ length: 20 }, (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}::coin::C`);
  const frame = (checkpoint: number, at: number, price: (index: number) => string, only = coins) =>
    ({ checkpoint, prices: only.map((coin_type) => ({ coin_type, usd_price: price(coins.indexOf(coin_type)), as_of_ms: at })) });
  const start = observeFrame(new Map(), coins, frame(1, 100, index => `${index + 1}`));
  assert.equal(start.get(coins[3]!)?.trade, null, "a first price is no trade");

  // SUI up 0.5%: every coin moves by the same ratio, and coin 3 also sold 0.3%, still above its last price.
  const moved = observeFrame(start, coins, frame(2, 200, index => `${(index + 1) * 1.005 * (index === 3 ? 0.997 : 1)}`));
  assert.equal(moved.get(coins[0]!)?.trade, null, "a quote move is no trade");
  assert.equal(moved.get(coins[0]!)?.usd_price, "1.005", "while the price itself still moves");
  assert.deepEqual(moved.get(coins[3]!)?.trade, { at: 200, direction: -1 }, "a sell against a rising quote is down");

  // A frame with 6 of the 20 coins: 5 share a SUI dip, the quote move, and one buy stands apart.
  const minority = observeFrame(moved, coins, frame(3, 300, index => `${(index + 1) * 1.005 * (index === 9 ? 1.02 : 0.998)}`, coins.slice(4, 10)));
  assert.equal(minority.get(coins[4]!)?.trade, null, "a minority quote move is no trade");
  assert.deepEqual(minority.get(coins[9]!)?.trade, { at: 300, direction: 1 });
  assert.deepEqual(minority.get(coins[3]!)?.trade, { at: 200, direction: -1 }, "a coin not in the frame keeps its trade");
});
