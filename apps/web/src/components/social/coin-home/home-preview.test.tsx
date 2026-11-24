import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import type { HomeTrader, HomeParticipant, HomeEvent } from "@blast/core/modules/social/contracts/home.ts";
import { TradersSection } from "./TradersSection";
import { recentEvents } from "./home-model";

const actor = { type: "account", callsign: "reader", display_name: "Reader", avatar_url: null, x_handle: null, verified: false, path: "/@reader" } as const;
const base: HomeTrader = { key: "reader", actor, followers: null, buys: null, sells: null, commits: null, claims: null, latest_ms: 1, latest_kind: "trade_buy", events_total: 1, coins: [], coins_total: 0, portfolio: { public: true, value_usd: "10.00", pnl_usd: "0.00" }, rank: 1, holdings: [{ presale_id: "coin", symbol: "TOKEN", icon_url: null, decimals: 9, balance: "1000000000", value_usd: "10.00", share_bps: 10000, pnl_usd: "0.00" }] };
function render(trader: HomeTrader) {
  const client = new QueryClient();
  try {
    const initial = { search: "", page: 1, limit: 5, total: 1, global_total: 1, traders: [trader], window: "24h" as const, clock_ms: 1, as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } };
    return renderToStaticMarkup(<QueryProvider client={client}><h2>PnL leaderboard</h2><TradersSection initial={initial} initialMs={Date.now()} window="24h" nowMs={1} /></QueryProvider>);
  } finally { client.clear(); }
}
test("trader summaries exclude private or missing PnL, preserve zero and gate holdings independently", () => {
  const publicRow = render(base);
  assert.match(publicRow, /<h2>PnL leaderboard<\/h2>/);
  assert.match(publicRow, /TOKEN/);
  assert.match(publicRow, /\$0/);
  assert.match(publicRow, /aria-expanded="false"/);
  assert.match(publicRow, /PnL · Since launch/);
  assert.doesNotMatch(publicRow, /Blast coins · All venues/);
  assert.match(publicRow, /aria-label="Realized plus unrealized USD PnL since launch on Blast-launched coins across all venues and linked wallets/);
  const hiddenHoldings = render({ ...base, holdings_public: false });
  assert.match(hiddenHoldings, /Private/);
  assert.doesNotMatch(hiddenHoldings, /TOKEN/);
  assert.match(hiddenHoldings, /\$0/);
  const hiddenPerformance = render({ ...base, performance_public: false });
  assert.match(hiddenPerformance, /<h2>PnL leaderboard<\/h2>/);
  assert.match(hiddenPerformance, /No traders with public PnL yet/);
  assert.doesNotMatch(hiddenPerformance, /TOKEN|Reader|Open Reader/);
  assert.doesNotMatch(hiddenPerformance, /\$0/);
  const missing = render({ ...base, rank: null, holdings: undefined, portfolio: { public: true, value_usd: null, pnl_usd: null } });
  assert.match(missing, /<h2>PnL leaderboard<\/h2>/);
  assert.match(missing, /No traders with public PnL yet/);
  assert.doesNotMatch(missing, /Reader|Open Reader/);
  assert.doesNotMatch(missing, /\$0/);
});

test("Home activity is five newest actual events, across participants, with no aggregate pseudo-events", () => {
  const event = (n: number): HomeEvent => ({ activity_id: String(n), entry_id: String(n), kind: "trade_buy", occurred_at_ms: n, digest: null, quote: null, tokens: "1", refund: null, has_why: false });
  const participant = (events?: HomeEvent[]): HomeParticipant => ({ ...base, events });
  const rows = recentEvents([participant([event(1), event(3), event(6)]), participant([event(2), event(4), event(5), event(7)]), participant()]);
  assert.deepEqual(rows.map(({ event }) => event.activity_id), ["7", "6", "5", "4", "3"]);
  assert.deepEqual(recentEvents([participant()]), []);
});

test("missing metrics stay visually quiet and keep an accessible explanation", async () => {
  const { Unknown } = await import("./MetricHelp");
  const html = renderToStaticMarkup(<Unknown why="Price unavailable" />);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector('[aria-hidden="true"]')?.textContent, "—");
  assert.equal(document.querySelector(".sr-only")?.textContent, "Price unavailable");
  assert.doesNotMatch(html, /<button/);
});
