import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { installTestDom, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import type { HomeTrader, HomeTraderHolding, HomeTradersPage } from "@blast/core/modules/social/contracts/home.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TradersSection } = await import("./TradersSection");
const { tradersQuery } = await import("./home-client");

const traders: HomeTrader[] = Array.from({ length: 125 }, (_, i) => ({
  key: `c:trader${i}`, rank: i + 1,
  actor: { type: "account", callsign: `trader${i}`, display_name: `Trader ${i}`, path: `/@trader${i}`, avatar_url: null, x_handle: null, verified: false },
  followers: null, buys: null, sells: null, commits: null, claims: null, latest_ms: 0, latest_kind: "trade_buy", events_total: 0,
  coins: [], coins_total: 0, holdings: i === 0 ? [{ presale_id: null, launch_id: `0x${"c".repeat(64)}`, symbol: "CURVE", icon_url: null, decimals: 9, balance: "1000000000", value_usd: "1.00", share_bps: 10000, pnl_usd: "1.00" }] : [], portfolio: { public: true, value_usd: "0.00", pnl_usd: `${125 - i}.00` },
}));
const result = (search = "", page = 1, limit = 5): HomeTradersPage => {
  const filtered = search ? traders.filter((trader) => trader.key.includes(search)) : traders;
  return { search, page, limit, total: filtered.length, global_total: 125, window: "24h", clock_ms: 1,
    as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 }, traders: filtered.slice((page - 1) * limit, page * limit) };
};

test("traders search the server, preserve global ranks, paginate beyond ten, and recover from empty/error states", async t => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async input => {
    const url = new URL(String(input), "https://blast.fun");
    if (url.pathname !== "/api/social/home/traders") return Response.json({});
    requests.push(url);
    const search = url.searchParams.get("search") ?? "";
    return search === "error" ? Response.json({}, { status: 400 }) : Response.json(result(search, Number(url.searchParams.get("page")), Number(url.searchParams.get("limit"))));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); globalThis.fetch = originalFetch; });
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const click = async (selector: string) => { await act(async () => {
    const button = container.querySelector(selector);
    assert.ok(button, selector);
    button.dispatchEvent(testEvent("click", { detail: 1 }));
  }); await settle(); };
  const search = async (text: string) => {
    await act(async () => {
      const input = container.querySelector("input")!;
      setInputValue(input, text);
      input.dispatchEvent(testEvent("input"));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(testEvent("submit"));
    });
    await settle();
  };
  await act(async () => root.render(<QueryProvider client={client}><TradersSection initial={result()} initialMs={Date.now()} window="24h" nowMs={1} /></QueryProvider>));
  assert.ok(container.querySelector(`a[href="/coin/0x${"c".repeat(64)}"]`), "curve holdings link to the original launch");
  assert.equal(requests.length, 0, `server seed avoids a duplicate initial request: ${requests.map(String)}`);
  assert.equal(container.querySelectorAll('ol[aria-label="PnL leaderboard"] > li').length, 5);
  assert.doesNotMatch(container.textContent ?? "", /No holdings/);
  assert.equal(container.querySelectorAll('button[aria-label^="Open Trader"]').length, 1, "empty holdings have no disclosure");
  assert.equal(container.querySelector('input[type="search"]')?.getAttribute("aria-label"), "Name, handle or wallet");
  await click('[aria-label="Page 4"]');
  assert.match(container.textContent ?? "", /Trader 15/);
  assert.equal(requests.at(-1)?.searchParams.get("page"), "4");
  await search("trader124");
  assert.match(container.textContent ?? "", /1 trader found/);
  const single = container.querySelector('nav[aria-label="Pages of traders"]');
  assert.ok(single, "one page keeps the pager, as the Main board's ‹ 1 ›");
  assert.equal(single.textContent, "1");
  assert.equal(single.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')?.disabled, true);
  assert.equal(single.querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.disabled, true);
  assert.match(container.textContent ?? "", /Trader 124/);
  assert.equal(container.querySelector(".rank")?.textContent, "125");
  assert.equal(requests.at(-1)?.searchParams.get("page"), "1");
  await search("no-match");
  assert.match(container.textContent ?? "", /No matching traders/);
  assert.ok(container.querySelector("input"), "search remains available after no results");
  await search("error");
  assert.match(container.textContent ?? "", /Traders couldn’t load/);
  assert.ok(container.querySelector("input"), "search remains available after an error");
  await click('form button[type="button"]');
  assert.match(container.textContent ?? "", /125 traders ranked/);
  assert.equal((container.querySelector("input") as HTMLInputElement).value, "");
  await act(async () => root.render(<QueryProvider client={client}><TradersSection initial={result()} initialMs={Date.now()} window="1h" nowMs={1} /></QueryProvider>));
  assert.equal(requests.at(-1)?.searchParams.get("window"), "24h", "activity-window changes do not change lifetime leaderboard scope");
});

test("expanded holdings omit unknown metrics and keep known zero", async t => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });
  const holding: HomeTraderHolding = { presale_id: `0x${"a".repeat(64)}`, symbol: "TEST", icon_url: null, decimals: 9, balance: "1000000000", value_usd: null, share_bps: null, pnl_usd: null };
  async function render(value: HomeTraderHolding) {
    const trader = { ...traders[0]!, holdings_public: true, performance_public: true, holdings: [value] };
    const data = { ...result(), total: 1, traders: [trader] };
    await act(async () => {
      client.setQueryData(tradersQuery("24h").queryKey, data);
      root.render(<QueryProvider client={client}><TradersSection initial={data} initialMs={Date.now()} window="24h" nowMs={1} /></QueryProvider>);
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  }
  await render(holding);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Trader 0 holdings"]')!.click());
  let row = container.querySelector(".holdingRow")!;
  assert.equal(row.children.length, 4, "empty desktop cells preserve known columns");
  assert.equal(row.children[1]!.textContent, "");
  assert.equal(row.children[2]!.textContent, "");
  assert.equal(row.children[3]!.textContent, "");
  assert.doesNotMatch(container.textContent!, /unavailable|Unrealized PnL|Holdings share|Value · USD/);
  await render({ ...holding, value_usd: "0.00", share_bps: 0, pnl_usd: "0.00" });
  row = container.querySelector(".holdingRow")!;
  assert.equal(row.children[1]!.textContent, "$0");
  assert.equal(row.children[2]!.textContent, "0%");
  assert.equal(row.children[3]!.textContent, "$0");
});
