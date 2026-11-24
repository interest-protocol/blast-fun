import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { notifyShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { waitFor } from "#web/test/fixtures/social/test-dom.ts";
import type { CoinTradeListener, MarketTrade } from "#web/components/launchpad/market-stream-hub.ts";
import { TradeReads } from "#web/components/launchpad/trade-reads.ts";
import { compactPnl, createCoinPnlReader, currentPnl, ownTrade, type CoinPnl } from "./coin-pnl";
import { CoinPnlMetric } from "./CoinPnlMetric";

const asset = { chain: "sui", network: "mainnet", coin_type: "0x2::test::TEST", presale_id: null } as const;
const profit: CoinPnl = { basis_usd: "1000.00", basis_complete: true, pnl_usd: "260.00", pnl_multiple: "1.2600" };

test("current PnL preserves signed precision and never treats unknown acquisition cost as break-even", () => {
  assert.deepEqual(currentPnl(profit), { amount: "+$260", percent: "+26%", tone: "up" });
  assert.deepEqual(currentPnl({ ...profit, pnl_usd: "-125.00", pnl_multiple: "0.8750" }), { amount: "−$125", percent: "−12.5%", tone: "down" });
  assert.deepEqual(currentPnl({ ...profit, pnl_usd: "-0.00", pnl_multiple: "1.0000" }), { amount: "$0", percent: "0%", tone: "flat" });
  assert.equal(currentPnl({ ...profit, pnl_usd: "0.00000001" })?.amount, "+$0.00000001");
  assert.equal(currentPnl({ ...profit, pnl_usd: "9007199254740993.01" })?.amount, "+$9,007,199,254,740,993.01");
  for (const value of [null, { ...profit, basis_complete: false }, { ...profit, basis_usd: null }, { ...profit, basis_usd: "0.00" }, { ...profit, pnl_usd: null }, { ...profit, pnl_usd: "NaN" }]) assert.equal(currentPnl(value), null);
});

test("compact PnL keeps signs, nonzero dust and exact inspection separate from row figures", () => {
  assert.deepEqual(compactPnl(profit), { amount: "+$260", percent: "+26%", tone: "up" });
  assert.deepEqual(compactPnl({ ...profit, pnl_usd: "-125.00", pnl_multiple: "0.8750" }), { amount: "−$125", percent: "−12.5%", tone: "down" });
  assert.deepEqual(compactPnl({ ...profit, pnl_usd: "-0.00", pnl_multiple: "1.0000" }), { amount: "$0", percent: "0%", tone: "flat" });
  assert.deepEqual(compactPnl({ ...profit, pnl_usd: "9007199254740993.01", pnl_multiple: "90071992547410.9301" }), { amount: "+$9007.2T", percent: "+9007.2T%", tone: "up" });
  assert.deepEqual(compactPnl({ ...profit, pnl_usd: "0.00000001", pnl_multiple: "1.0000000001" }), { amount: "+$0.0₇1", percent: "+0.0₇1%", tone: "up" });
  assert.deepEqual(compactPnl({ ...profit, pnl_usd: "-0.00000001", pnl_multiple: "0.9999999999" }), { amount: "−$0.0₇1", percent: "−0.0₇1%", tone: "down" });
  assert.deepEqual(compactPnl({ ...profit, pnl_usd: "+260.00", pnl_multiple: null }), { amount: "+$260", percent: null, tone: "up" });
  for (const [multiple, percent] of [["13.3456", "+1.23K%"], ["12346.6789", "+1.23M%"], ["12345679.9", "+1.23B%"]] as const) {
    assert.equal(compactPnl({ ...profit, pnl_multiple: multiple })?.percent, percent);
  }
  for (const value of [null, { ...profit, basis_complete: false }, { ...profit, basis_usd: "0" }, { ...profit, pnl_usd: "NaN" }]) assert.equal(compactPnl(value), null);
  assert.equal(currentPnl({ ...profit, pnl_usd: "9007199254740993.01" })?.amount, "+$9,007,199,254,740,993.01");
});

test("reader requests the shared authenticated full portfolio, matches canonical identity and rejects incomplete wallet sync", async t => {
  let coin = { ...profit, coin_type: String(asset.coin_type), symbol: "TEST", balance: "1", value_usd: "1260.00" };
  let sync = "ready", failed = false;
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async (path: RequestInfo | URL, init?: RequestInit) => {
    fetches++;
    assert.equal(path, "/api/social/me/portfolio");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer owner-token");
    return failed ? new Response("unavailable", { status: 503 }) : Response.json({ balances: null, positions: [], commitments: null, coins: [{ ...coin, coin_type: "0x4::other::TEST", pnl_usd: "99999999.00" }, coin], vesting: null, totals: null, trend: null, prices_as_of_ms: null, unavailable: [], wallet_sync: { status: sync, checkpoint: null, as_of_ms: null } });
  });
  const client = new QueryClient();
  const read = createCoinPnlReader(client, async () => "owner-token");
  assert.equal((await read(asset))?.pnl_usd, "260.00");
  assert.equal((await read({ ...asset, coin_type: "0x4::other::TEST" }))?.pnl_usd, "99999999.00");
  assert.equal(fetches, 1, "every coin panel shares one fresh portfolio read");
  client.clear(); sync = "syncing"; assert.equal(await read(asset), null);
  client.clear(); sync = "ready"; coin = { ...coin, coin_type: "0x3::test::TEST" }; assert.equal(await read(asset), null);
  client.clear(); failed = true; await assert.rejects(read(asset), /could not load/);
  assert.equal(await read({ ...asset, network: "testnet" }), null);
});

test("PnL clears on account changes, protects hidden amounts and supports pending, error and retry", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const client = new QueryClient();
  let state = "ready", calls = 0;
  const pnl = async () => { calls++; if (state === "pending") return new Promise<never>(() => {}); if (state === "error") throw new Error("unavailable"); return state === "unknown" ? null : state === "zero" ? { ...profit, pnl_usd: "0", pnl_multiple: "1" } : profit; };
  const render = (actor = "A", visible = true, authenticated = true) => act(async () => root.render(<QueryProvider client={client}><dl><CoinPnlMetric asset={asset} visible={visible} actions={{ authenticated, actor_key: actor, pnl, trade: null, signIn: () => {} }} /></dl></QueryProvider>));
  const shows = (pattern: RegExp) => waitFor(() => pattern.test(document.body.textContent!), `PnL shows ${pattern}`);
  const loading = () => document.querySelector('[aria-label="Loading current PnL"]');
  try {
    await render(); await shows(/\+\$260/);
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "hidden"); notifyShellPrefs(); });
    assert.doesNotMatch(document.body.textContent!, /260|26%/); assert.equal(document.querySelector('[aria-label*="Inspect full current unrealized"]'), null);
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "shown"); notifyShellPrefs(); });
    state = "pending"; await render("B"); assert.ok(loading()); assert.doesNotMatch(document.body.textContent!, /260/);
    state = "error"; await render("C"); await waitFor(() => document.querySelector('[aria-label="Retry current PnL"]'), "PnL offers a retry");
    state = "ready"; await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Retry current PnL"]')!.click()); await shows(/\+\$260/);
    state = "unknown"; await render("D"); await waitFor(() => !loading(), "unknown PnL settles"); assert.equal(document.querySelector("dt"), null); assert.doesNotMatch(document.body.textContent!, /Unavailable|Unrealized PnL/);
    state = "zero"; await render("zero"); await shows(/Unrealized PnL\$0/);
    const before = calls; await render("E", false); await render("guest", true, false); assert.equal(calls, before); assert.doesNotMatch(document.body.textContent!, /260/);
  } finally { await act(async () => root.unmount()); client.clear(); dom.window.close(); }
});

test("current PnL re-reads only for the viewer's own trades", () => {
  const mine = `0x${"a".repeat(64)}`;
  const theirs = `0x${"b".repeat(64)}`;
  const reads: (number | null)[] = [];
  const timers: (() => void)[] = [];
  let listener: CoinTradeListener | null = null;
  const reader = new TradeReads(
    { minGapMs: 0, fallbackMs: () => null, initial: false, accept: ownTrade(["0x" + "A".repeat(64)]), read: (at) => reads.push(at) },
    {
      observe: (value) => { listener = value; return () => {}; },
      now: () => 0,
      schedule: (run) => { timers.push(run); return () => {}; },
      random: () => 0,
      visible: () => true,
      onVisibilityChange: () => () => {},
    },
  );
  reader.start();
  const trade = (checkpoint: number, trader: string | null) => ({ poolKey: `blast_curve:0x${"1".repeat(64)}`, checkpoint, summary: null, trade: { trader } as MarketTrade["trade"] });
  for (const [checkpoint, trader] of [[1, theirs], [2, null], [3, theirs]] as const) listener!.trade(trade(checkpoint, trader));
  assert.equal(timers.length, 0);
  listener!.trade(trade(4, mine));
  timers.splice(0).forEach((run) => run());
  assert.deepEqual(reads, [4]);
});
