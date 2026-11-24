import assert from "node:assert/strict";
import test from "node:test";

import { NO_COST_BASIS, NO_PORTFOLIO_TREND, type SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";

import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { shellPortfolioState, shellPortfolioSummary, shellPriceAsks, summaryFigures, summaryFromFigures } from "./use-shell-portfolio.ts";

const KSTL = "0x6b5f3e0c2a8d4e1f9b7c3a5d2e8f1c4b7a9d3e6f2c8b5a1d4e7f9c3b6a2d5e8f::kstl::KSTL";

/** The design's Kai: $860 USDC, 412.38 SUI ($1,410.34), $850 committed, $250 to claim, 600,000 KSTL ($1,260). */
const PORTFOLIO: SocialPortfolio = {
  balances: { usdc: { atoms: "860000000", usd: "860.00" }, sui: { atoms: "412380000000", usd: "1410.34" } },
  positions: [],
  commitments: { committed_usd: "850.00", claimable_usd: "250.00" },
  coins: [{ coin_type: KSTL, symbol: "KSTL", balance: "600000000000000", value_usd: "1260.00", ...NO_COST_BASIS }],
  vesting: null,
  totals: null,
  trend: NO_PORTFOLIO_TREND,
  prices_as_of_ms: null,
  unavailable: [],
};

/** A 24 h read in R3-20's shape. */
const price = (coinType: string, now: string, overrides: Partial<SocialPriceHistory> = {}): SocialPriceHistory => ({
  presale_id: null,
  coin_type: coinType,
  tier: "5m",
  from_ms: 0,
  points: [],
  price_usd: now,
  price_24h_usd: null,
  change_24h_bps: null,
  day_open_usd: null,
  day_open_ms: null,
  ...overrides,
});

const SUI = price(SUI_COIN_TYPE, "3.42", { change_24h_bps: 241 });
const KSTL_PRICE = price(KSTL, "0.0021", { day_open_usd: "0.001774", change_24h_bps: 1840 });

test("R3-73: the shell asks R3-20 for SUI and every sale coin held, by type; nothing before the portfolio answers", () => {
  assert.deepEqual(shellPriceAsks(PORTFOLIO), [SUI_COIN_TYPE, KSTL]);
  assert.deepEqual(shellPriceAsks({ ...PORTFOLIO, coins: [] }), [SUI_COIN_TYPE]);
  assert.deepEqual(shellPriceAsks(null), []);
  // Without the coins or the balances there is no today's move to compute, so nothing is asked.
  assert.deepEqual(shellPriceAsks({ ...PORTFOLIO, coins: null }), []);
  assert.deepEqual(shellPriceAsks({ ...PORTFOLIO, balances: null }), []);
});

test("R3-73-AC-2: the rail's figures are the gold card's total and the shared today model over the prices read", () => {
  const prices = new Map([
    [SUI_COIN_TYPE, SUI],
    [KSTL, KSTL_PRICE],
  ]);
  const summary = shellPortfolioSummary(PORTFOLIO, prices);
  assert.equal(summary.total_usd, 850 + 250 + 860 + 1_410.34 + 1_260);
  assert.deepEqual(summary.breakdown, { coins: 3530.34, committed: 850, claimable: 250 });
  assert.equal(summary.breakdown!.coins! + summary.breakdown!.committed! + summary.breakdown!.claimable!, summary.total_usd);
  // KSTL: 600,000 × (0.0021 − 0.001774); SUI: $1,410.34 at +2.41 % over 24 h.
  const kstl = (1_260 / 0.0021) * (0.0021 - 0.001774);
  const sui = 1_410.34 - 1_410.34 / 1.0241;
  assert.ok(Math.abs(summary.today!.usd - (kstl + sui)) < 1e-6);
  assert.ok(Math.abs(summary.today!.pct - ((kstl + sui) / (summary.total_usd! - kstl - sui)) * 100) < 1e-9);
});

test("R3-73-AC-2: a missing day-open price, SUI without its 24 h move, or a price still reading: no move, the total stays", () => {
  const total = 850 + 250 + 860 + 1_410.34 + 1_260;
  const noOpen = shellPortfolioSummary(PORTFOLIO, new Map([[SUI_COIN_TYPE, SUI], [KSTL, { ...KSTL_PRICE, day_open_usd: null }]]));
  assert.deepEqual(noOpen, { total_usd: total, breakdown: { coins: 3530.34, committed: 850, claimable: 250 }, today: null });
  assert.deepEqual(shellPortfolioSummary(PORTFOLIO, new Map([[SUI_COIN_TYPE, { ...SUI, change_24h_bps: null }], [KSTL, KSTL_PRICE]])), { total_usd: total, breakdown: { coins: 3530.34, committed: 850, claimable: 250 }, today: null });
  assert.deepEqual(shellPortfolioSummary(PORTFOLIO, new Map([[SUI_COIN_TYPE, SUI]])), { total_usd: total, breakdown: { coins: 3530.34, committed: 850, claimable: 250 }, today: null });
  assert.deepEqual(shellPortfolioSummary(PORTFOLIO, new Map([[SUI_COIN_TYPE, SUI], [KSTL, null]])), { total_usd: total, breakdown: { coins: 3530.34, committed: 850, claimable: 250 }, today: null });
  // Missing valuations are excluded from the header total; today's move still needs every price.
  assert.deepEqual(shellPortfolioSummary({ ...PORTFOLIO, commitments: { committed_usd: null, claimable_usd: "250.00" } }, new Map([[SUI_COIN_TYPE, SUI], [KSTL, KSTL_PRICE]])), {
    total_usd: null,
    known_value_usd: 3780.34,
    unpriced_assets: true,
    known_breakdown: { coins: 3530.34, committed: 0, claimable: 250 },
    breakdown: { coins: 3530.34, committed: null, claimable: 250 },
    today: null,
  });
});

test("UI-01: the shell's state shows the total once the read answers, and nothing on a refusal or an error", () => {
  const state = shellPortfolioState({ status: "ready", portfolio: { ...PORTFOLIO, coins: [] } });
  assert.deepEqual(state, { status: "ready", summary: { total_usd: 850 + 250 + 860 + 1_410.34 + 0, breakdown: { coins: 2270.34, committed: 850, claimable: 250 }, today: null } });
  assert.deepEqual(shellPortfolioState({ status: "refused", code: "account_required" }), { status: "unavailable" });
  assert.deepEqual(shellPortfolioState({ status: "error" }), { status: "unavailable" });
});

test("an unavailable token-holdings read never becomes a smaller balance in the account bar", () => {
  assert.deepEqual(shellPortfolioSummary({ ...PORTFOLIO, coins: null, unavailable: ["coins"] }, new Map()), {
    total_usd: null,
    breakdown: { coins: null, committed: 850, claimable: 250 },
    today: null,
  });
});

test("unpriced synced coins remain a ready portfolio, distinct from unavailable holdings", () => {
  const portfolio: SocialPortfolio = { ...PORTFOLIO, wallet_sync: {status:"ready",checkpoint:"10",as_of_ms:1},
    coins: [{...PORTFOLIO.coins![0]!,value_usd:null}] };
  assert.equal(shellPortfolioSummary(portfolio,new Map()).unpriced_assets,true);
  assert.equal(shellPortfolioSummary({...portfolio,unavailable:["coins"]},new Map()).unpriced_assets,undefined);
  assert.equal(shellPortfolioSummary({...portfolio,wallet_sync:{status:"syncing",checkpoint:null,as_of_ms:null}},new Map()).unpriced_assets,undefined);
});


test("the header sums priced holdings across cash, tokens and presales while excluding unpriced assets", () => {
  const portfolio: SocialPortfolio = { ...PORTFOLIO, wallet_sync: { status: "ready", checkpoint: "10", as_of_ms: 1 },
    coins: [...PORTFOLIO.coins!, { ...PORTFOLIO.coins![0]!, coin_type: "0x1::test::TEST_SUI", value_usd: null }] };
  const summary = shellPortfolioSummary(portfolio, new Map());
  assert.equal(summary.total_usd, null);
  assert.equal(summary.known_value_usd, 4630.34);
  assert.deepEqual(summary.breakdown, { coins: null, committed: 850, claimable: 250 });
  assert.equal(summary.unpriced_assets, true);
  // #601: the priced parts the header's breakdown shows, adding up to the priced subtotal.
  assert.deepEqual(summary.known_breakdown, { coins: 3530.34, committed: 850, claimable: 250 });
  assert.equal(summary.known_breakdown!.coins + summary.known_breakdown!.committed + summary.known_breakdown!.claimable, summary.known_value_usd);
  const unpricedCash = shellPortfolioSummary({ ...portfolio, balances: { usdc: { atoms: "0", usd: "0" }, sui: { atoms: "1000000000", usd: null } } }, new Map());
  assert.equal(unpricedCash.total_usd, null);
  assert.equal(unpricedCash.known_value_usd, 2360);
  const onlyUnpriced = shellPortfolioSummary({ ...portfolio, balances: { usdc: { atoms: "0", usd: "0" }, sui: { atoms: "0", usd: "0" } },
    coins: [{ ...portfolio.coins![1]!, value_usd: null }], commitments: { committed_usd: "0", claimable_usd: "0" } }, new Map());
  assert.equal(onlyUnpriced.total_usd, null);
  assert.equal(onlyUnpriced.known_value_usd, undefined);
  assert.equal(onlyUnpriced.unpriced_assets, true);
  assert.equal(shellPortfolioSummary({ ...portfolio, unavailable: ["coins"] }, new Map()).total_usd, null);
  assert.equal(shellPortfolioSummary({ ...portfolio, wallet_sync: { status: "syncing", checkpoint: null, as_of_ms: null } }, new Map()).total_usd, null);
});

test("compact portfolio summary preserves all-wallet figures and asks for no chart histories", () => {
  const compact = { ...PORTFOLIO, coins: [], coin_summary: { value_usd: "1260.00", known_value_usd: "1260.00", today: { usd: 12, pct: 0.25 } } };
  assert.deepEqual(shellPriceAsks(compact), []);
  const result = shellPortfolioSummary(compact, new Map());
  assert.equal(result.total_usd, shellPortfolioSummary(PORTFOLIO, new Map()).total_usd);
  assert.deepEqual(result.today, compact.coin_summary.today);
  assert.deepEqual(result.breakdown, { coins: 3530.34, committed: 850, claimable: 250 });
  const unpriced = shellPortfolioSummary({ ...compact, coin_summary: { ...compact.coin_summary, value_usd: null, today: null } }, new Map());
  assert.equal(unpriced.total_usd, null);
  assert.equal(unpriced.known_value_usd, result.total_usd);
  assert.equal(unpriced.unpriced_assets, true);
});

test("#601: the shell provides the summary it computed, the priced split included, after keeping it by value", () => {
  const unpriced: SocialPortfolio = { ...PORTFOLIO, wallet_sync: { status: "ready", checkpoint: "10", as_of_ms: 1 },
    coins: [...PORTFOLIO.coins!, { ...PORTFOLIO.coins![0]!, coin_type: "0x1::test::TEST_SUI", value_usd: null }] };
  for (const portfolio of [PORTFOLIO, unpriced, { ...PORTFOLIO, commitments: { committed_usd: null, claimable_usd: "250.00" } }]) {
    const summary = shellPortfolioSummary(portfolio, new Map([[SUI_COIN_TYPE, SUI], [KSTL, KSTL_PRICE]]));
    assert.deepEqual(summaryFromFigures(summaryFigures(summary)), summary);
  }
  assert.ok(summaryFromFigures(summaryFigures(shellPortfolioSummary(unpriced, new Map()))).known_breakdown);
});
