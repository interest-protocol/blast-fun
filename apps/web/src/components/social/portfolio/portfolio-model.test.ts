import assert from "node:assert/strict";
import test from "node:test";

import { NO_COST_BASIS, type SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import type { SocialMePresales } from "@blast/core/modules/social/contracts/profile-page.ts";

import type { HoldingCoin } from "../profile/profile-model";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { allocationShares, coinRowTarget, pageCoins, portfolioCoverage, pricedFigures, walletCoins, walletAmount, coinRow, heroFigures, portfolioFigures, priceAskOf, todayChange, totalParts } from "./portfolio-model";
import { PORTFOLIO_TABS, portfolioTabs, portfolioTabAt, isPortfolioTab } from "#web/components/blast-ui/portfolio-navigation.ts";
import { PORTFOLIO_TAB_KEY, readPortfolioTab } from "./portfolio-tab";
import { dockToday } from "./today-model";

/** The design's sample account as `/me/portfolio` answers it (the gate's `PORTFOLIOS.kai`). */
const PORTFOLIO: SocialPortfolio = {
  balances: { usdc: { atoms: "860000000", usd: "860.00" }, sui: { atoms: "412380000000", usd: "1410.34" } },
  positions: [],
  commitments: { committed_usd: "850.00", claimable_usd: "250.00" },
  coins: [
    { coin_type: "0x1::kstl::KSTL", symbol: "KSTL", balance: "1", value_usd: "1260.00", ...NO_COST_BASIS },
    { coin_type: "0x1::lumn::LUMN", symbol: "LUMN", balance: "1", value_usd: "130.00", ...NO_COST_BASIS },
  ],
  vesting: null,
  totals: null,
  trend: null,
  prices_as_of_ms: 0,
  unavailable: [],
};

const price = (over: Partial<SocialPriceHistory>): SocialPriceHistory => ({
  presale_id: null, coin_type: "x", tier: "5m", from_ms: 0, points: [], price_usd: null, price_24h_usd: null, change_24h_bps: null, day_open_usd: null, day_open_ms: null, ...over,
});

test("R3-74: the three figures add up to the total, as the gate's do", () => {
  const figures = portfolioFigures(PORTFOLIO);
  assert.deepEqual(figures, { total: 4760.34, coins: 3660.34, committed: 850, claimable: 250 });
  assert.deepEqual(totalParts(figures.total, false), { whole: "$4,760", cents: ".34" });
  assert.deepEqual(heroFigures(figures, false).map((f) => [f.key, f.label, f.value]), [["coins", "Coins", "$3,660"], ["presales", "In presales", "$850"], ["claim", "To claim", "$250"]]);
  assert.deepEqual(heroFigures(figures, true).map((f) => f.value), ["••••", "••••", "••••"]);
  // The Portfolio page's tiles write cents (the board's "$8,986.11").
  assert.deepEqual(heroFigures(figures, false, true).map((f) => f.value), ["$3,660.34", "$850.00", "$250.00"]);
  assert.deepEqual(totalParts(figures.total, true), { whole: "$••••••", cents: "" });
});

test("the allocation bar shares the three known figures and draws nothing for a partial or empty valuation", () => {
  const figures = portfolioFigures(PORTFOLIO);
  const shares = allocationShares(figures);
  assert.deepEqual(shares.map((share) => share.key), ["coins", "presales", "claim"]);
  assert.equal(Math.round(shares.reduce((sum, share) => sum + share.share, 0) * 1e9) / 1e9, 1);
  assert.deepEqual(allocationShares({ ...figures, claimable: 0 }).map((share) => share.key), ["coins", "presales"]);
  assert.deepEqual(allocationShares({ ...figures, coins: null }), []);
  assert.deepEqual(allocationShares({ total: 0, coins: 0, committed: 0, claimable: 0 }), []);
});

test("with some holding unpriced, the priced parts are each figure's known part and sum to the priced subtotal", () => {
  // SUI and one coin without a price; the claims partly priced; the summary view's coin aggregate.
  const unpriced: SocialPortfolio = {
    ...PORTFOLIO,
    balances: { ...PORTFOLIO.balances!, sui: { atoms: "1", usd: null } },
    commitments: { committed_usd: "850.00", claimable_usd: null, known_claimable_usd: "40.00" },
    coins: [{ ...PORTFOLIO.coins![0]!, value_usd: null }, PORTFOLIO.coins![1]!],
  };
  assert.equal(portfolioFigures(unpriced).total, null);
  assert.deepEqual(pricedFigures(unpriced), { total: 1880, coins: 990, committed: 850, claimable: 40 });
  assert.deepEqual(portfolioCoverage(unpriced), { knownUsd: 1880 });
  const summary: SocialPortfolio = { ...unpriced, coins: [], coin_summary: { value_usd: null, known_value_usd: "130.00", today: null } };
  assert.deepEqual(pricedFigures(summary), { total: 1880, coins: 990, committed: 850, claimable: 40 });
  const shares = allocationShares(pricedFigures(unpriced)!);
  assert.deepEqual(shares.map((share) => [share.key, Math.round(share.share * 1000) / 1000]), [["coins", 0.527], ["presales", 0.452], ["claim", 0.021]]);
  // A complete total, or a holding not read yet, has no priced parts: the bar keeps the complete figures or draws nothing.
  assert.equal(pricedFigures(PORTFOLIO), null);
  assert.equal(pricedFigures({ ...unpriced, unavailable: ["coins"] }), null);
  assert.equal(pricedFigures(null), null);
});

test("presale claims stay scoped when native vesting has an available unpriced amount", () => {
  const portfolio = { ...PORTFOLIO, commitments: { committed_usd: "0.00", claimable_usd: "0.00" }, vesting: { has_schedule: true, href: "/portfolio/vestings" } };
  const figures = portfolioFigures(portfolio);
  const holdings = { positions: [], watchlist: [], coins: [], created: [], vestings: [{ claimable: "81297878.320681999", claimable_usd: null }] } as unknown as SocialMePresales;
  assert.deepEqual(heroFigures(figures, false).find(row => row.key === "claim"), { key: "claim", label: "To claim", value: "$0" });
  assert.equal(holdings.vestings[0]!.claimable, "81297878.320681999");
  assert.equal(holdings.vestings[0]!.claimable_usd, null);
  assert.equal(heroFigures(portfolioFigures({ ...portfolio, commitments: null }), false).some(row => row.key === "claim"), false);
});

test("R3-74: an unread or unpriced part is unknown, never a smaller number", () => {
  assert.deepEqual(portfolioFigures(null), { total: null, coins: null, committed: null, claimable: null });
  const unpriced = portfolioFigures({ ...PORTFOLIO, balances: { ...PORTFOLIO.balances!, sui: { atoms: "1", usd: null } } });
  assert.equal(unpriced.coins, null);
  assert.equal(unpriced.total, null);
  assert.equal(totalParts(null, false), null);
  assert.deepEqual(heroFigures(unpriced, false).map((f) => f.value), ["$850", "$250"]);
  // A category without a priced part shows no price. A priced part keeps its value.
  const priced = { total: 1_100, coins: 0, committed: 850, claimable: 250 };
  assert.deepEqual(heroFigures(unpriced, false, true, priced).map((f) => f.value), ["No price", "$850.00", "$250.00"]);
  assert.deepEqual(heroFigures(unpriced, false, true, { ...priced, coins: 600 }).map((f) => f.value), ["$600.00", "$850.00", "$250.00"]);
  assert.deepEqual(heroFigures(unpriced, true, true, priced).map((f) => f.value), ["••••", "••••", "••••"]);
  assert.deepEqual(portfolioFigures({ ...PORTFOLIO, coins: null, unavailable: ["coins"] }), {
    total: null, coins: null, committed: 850, claimable: 250,
  });
});

test("R3-74: today's line is the shared today model's, omitted when unknown, 'Hidden' when hidden", () => {
  const sale = [
    price({ coin_type: "0x1::kstl::KSTL", price_usd: "0.0021", day_open_usd: String(0.0021 / 1.184) }),
    price({ coin_type: "0x1::lumn::LUMN", price_usd: "0.0013", day_open_usd: String(0.0013 / 0.969) }),
  ];
  const move = dockToday(PORTFOLIO, sale, price({ change_24h_bps: 241 }));
  assert.deepEqual(todayChange(move, false), { text: "+$224.84 (+4.96%)", tone: "up" });
  assert.deepEqual(todayChange(move, true), { text: "Hidden", tone: null });
  assert.deepEqual(todayChange({ usd: -12.5, pct: -0.26 }, false), { text: "−$12.50 (−0.26%)", tone: "down" });
  // The Portfolio board's line: the sign on the dollars, the percentage bare.
  assert.deepEqual(todayChange(move, false, true), { text: "+$224.84 (4.96%)", tone: "up" });
  assert.deepEqual(todayChange({ usd: -12.5, pct: -0.26 }, false, true), { text: "−$12.50 (0.26%)", tone: "down" });
  // One held coin without a day open: no line at all.
  assert.equal(todayChange(dockToday(PORTFOLIO, sale.slice(0, 1), price({ change_24h_bps: 241 })), false), null);
});

test("R3-74: a coin row — 'Sui', the ticker after the amount, the 24 h move, 'Cash' for USDC, nothing without a price", () => {
  const coin = (key: string, name: string, symbol: string, usd: number | null, quantity: number | null, presaleId: string | null = null): HoldingCoin =>
    ({ key, name, symbol, presaleId, icon: "", round: presaleId === null, usd, quantity });
  const usdc = coinRow(coin("usdc", "USDC", "USDC", 860, 860), undefined, false);
  // Values to the cent, as the Portfolio board writes them.
  assert.deepEqual([usdc.name, usdc.amount, usdc.value, usdc.change, usdc.label], ["USDC", "860 USDC", "$860.00", "cash", "USDC, 860 USDC, $860.00"]);
  const sui = coinRow(coin("sui", "SUI", "SUI", 1410.34, 412.38), price({ change_24h_bps: 241 }), false);
  assert.deepEqual([sui.name, sui.amount, sui.value, sui.change], ["Sui", "412.38 SUI", "$1,410.34", { text: "+2.41%", tone: "up" }]);
  assert.equal(sui.label, "Sui, 412.38 SUI, $1,410.34, +2.41% today");
  // A nonzero holding under a cent never reads as zero.
  assert.equal(coinRow(coin("0xd", "Dust", "DST", 0.001, 1, "0xd"), null, false).value, "<$0.01");
  const lumn = coinRow(coin("0xl", "Lumen", "LUMN", 130, 100_000, "0xl"), price({ change_24h_bps: -310 }), true);
  assert.deepEqual([lumn.amount, lumn.value, lumn.change], ["••••", "••••", { text: "−3.1%", tone: "down" }]);
  assert.equal(coinRow(coin("0xk", "Kestrel", "KSTL", null, null, "0xk"), null, false).change, null);
  // No price, no value: the row shows the amount alone, never a dash.
  assert.equal(coinRow(coin("0xk", "Kestrel", "KSTL", null, null, "0xk"), null, false).value, null);
  assert.equal(priceAskOf(coin("usdc", "USDC", "USDC", 1, 1), "0x2::sui::SUI"), null);
  assert.deepEqual(priceAskOf(coin("sui", "SUI", "SUI", 1, 1), "0x2::sui::SUI"), { coin: "0x2::sui::SUI" });
  assert.deepEqual(priceAskOf(coin("0xk", "Kestrel", "KSTL", 1, 1, "0xk"), "x"), { presaleId: "0xk" });
});

test("R3-74: the holdings tab kept on the device (blast.pfTab2), Coins when missing or malformed", () => {
  const store = (raw: string | null) => ({ getItem: (key: string) => (key === PORTFOLIO_TAB_KEY ? raw : null), setItem: () => undefined });
  assert.equal(PORTFOLIO_TAB_KEY, "blast.pfTab2");
  assert.equal(readPortfolioTab(store('"claims"')), "claims");
  // A choice kept under an old tab name opens Claims, which replaced it.
  assert.equal(readPortfolioTab(store('"vestings"')), "claims");
  assert.equal(readPortfolioTab(store('"calls"')), "coins");
  assert.equal(readPortfolioTab(store("{")), "coins");
  assert.equal(readPortfolioTab(null), "coins");
  assert.ok(isPortfolioTab("presales") && !isPortfolioTab("cash"));
});


test("unlisted TEST_SUI stays visible without a price and quantities retain exact atoms", () => {
  const coinType = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";
  const coins = walletCoins({ ...PORTFOLIO, coins: [{
    coin_type: coinType, symbol: "TSUI", name: "TEST_SUI", decimals: 9, presale_id: null, icon_url: null,
    balance: "10000000000000000", value_usd: null, ...NO_COST_BASIS,
  }] });
  const held = coins.find((coin) => coin.key === coinType)!;
  const row = coinRow(held, null, false);
  assert.equal(row.name, "Test SUI");
  assert.equal(row.amount, "10,000,000 TSUI");
  assert.equal(row.value, null);
  assert.equal(coinRow(held, null, true).amount, "••••");
  assert.equal(walletAmount("123456789123456789123456789", 9), "123,456,789,123,456,789.123456789");
  assert.equal(walletAmount("1", 9), "0.000000001");
  assert.equal(walletAmount("123", null), "123\u00a0base units");
});


test("valuation coverage separates the known subtotal from an incomplete total", () => {
  const partial = { ...PORTFOLIO, commitments: { committed_usd: null, claimable_usd: "250.00" }, coins: [{ ...PORTFOLIO.coins![0]!, value_usd: null }] };
  assert.equal(portfolioFigures(partial).total, null);
  assert.deepEqual(portfolioCoverage(partial), { knownUsd: 2520.34 });
  assert.equal(portfolioCoverage({ ...partial, coins: null }), null);
  assert.equal(portfolioCoverage({ ...partial, wallet_sync: { status: "syncing", checkpoint: null, as_of_ms: null } }), null);
  assert.equal(portfolioCoverage(PORTFOLIO), null);
});

test("TS-5: three holdings tabs; the old Vestings, Rewards and Launches links open Claims", () => {
  assert.deepEqual(portfolioTabs().map(([key]) => key), ["coins", "presales", "claims"]);
  assert.equal(portfolioTabs(), PORTFOLIO_TABS);
  for (const old of ["/portfolio/vestings", "/portfolio/rewards", "/portfolio/launches"]) assert.equal(portfolioTabAt(old), "claims");
  assert.equal(portfolioTabAt("/portfolio", "?tab=rewards"), "claims");
  assert.equal(portfolioTabAt("/portfolio/claims"), "claims");
  assert.equal(portfolioTabAt("/portfolio", "?tab=cash"), "coins");
});

test("a zero balance is not evidence of price coverage", () => {
  const zero = {
    ...PORTFOLIO,
    balances: { sui: { atoms: "0", usd: null }, usdc: { atoms: "0", usd: "0.00" } },
    commitments: { committed_usd: "0.00", claimable_usd: "0.00" },
    coins: [{ ...PORTFOLIO.coins![0]!, balance: "0", value_usd: null }],
  };
  assert.equal(portfolioFigures(zero).total, 0);
  const unpriced = { ...zero, coins: [...zero.coins, { ...zero.coins[0]!, balance: "100" }] };
  assert.equal(portfolioFigures(unpriced).total, null);
  assert.equal(portfolioCoverage(unpriced), null);
  assert.equal(portfolioCoverage({ ...unpriced, coins: [], coin_summary: { value_usd: null, known_value_usd: "0.00", today: null } }), null);
  const dust = { ...unpriced, coins: [...unpriced.coins, { ...unpriced.coins[1]!, value_usd: "0.00", value_usd_exact: "0.000001" }] };
  assert.deepEqual(portfolioCoverage(dust), { knownUsd: 0.000001 });
});

test("a priced SUI balance smaller than a cent contributes to the valuation", () => {
  const portfolio = {
    ...PORTFOLIO,
    balances: { sui: { atoms: "1", usd: "0.00", usd_subcent: 0.000000003 }, usdc: { atoms: "0", usd: "0.00" } },
    commitments: { committed_usd: "0.00", claimable_usd: "0.00" },
    coins: [],
  };
  assert.deepEqual(totalParts(portfolioFigures(portfolio).total, false), { whole: "<$0.01", cents: "" });
  assert.deepEqual(portfolioCoverage({ ...portfolio, coins: [{ ...PORTFOLIO.coins![0]!, value_usd: null }] }), { knownUsd: 0.000000003 });
});

test("an explicit zero price on a holding is enough to report a priced subtotal", () => {
  const unpriced = { ...PORTFOLIO.coins![0]!, value_usd: null };
  const pricedAtZero = { ...PORTFOLIO.coins![1]!, value_usd: "0.00" };
  const portfolio = {
    ...PORTFOLIO,
    balances: { sui: { atoms: "0", usd: null }, usdc: { atoms: "0", usd: "0.00" } },
    commitments: { committed_usd: "0.00", claimable_usd: "0.00" },
    coins: [unpriced, pricedAtZero],
  };
  assert.deepEqual(portfolioCoverage(portfolio), { knownUsd: 0 });
  assert.deepEqual(portfolioCoverage({ ...portfolio, coins: [], coin_summary: { value_usd: null, known_value_usd: "0.00", has_priced_holdings: true, today: null } }), { knownUsd: 0 });
});

test("each Coins row opens by its kind: presale page, coin page, coin sheet, or nothing for spam", () => {
  const presale = `0x${"1".repeat(64)}`;
  const launch = `0x${"2".repeat(64)}`;
  const row = (coin_type: string, over: object = {}) => ({ coin_type, symbol: "X", name: null, decimals: 9, balance: "1", value_usd: null, icon_url: null, presale_id: null, ...over });
  const coins = pageCoins({ total: 6, page: 1, page_size: 20, coins: [
    row("0x9::sale::SALE", { presale_id: presale, value_usd: "3.00" }),
    row("0x9::meme::MEME", { launch_id: launch }),
    row(SUI_COIN_TYPE, { value_usd: "1.00" }),
    row("0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL"),
    row("0x9::other::OTHER", { value_usd: "2.00", launch_id: null }),
    row("0x9::spam::SPAM"),
  ] });
  assert.deepEqual(coins.map((coin) => [coin.key, coinRowTarget(coin)]), [
    [presale, { kind: "page", href: `/presale/${presale}` }],
    ["0x9::meme::MEME", { kind: "page", href: "/coin/0x9%3A%3Ameme%3A%3AMEME" }],
    ["sui", { kind: "sheet" }],
    // A curated coin opens its sheet even before a price lands, keyed by its type as Search keys it.
    ["0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", { kind: "sheet" }],
    ["0x9::other::OTHER", { kind: "sheet" }],
    ["0x9::spam::SPAM", null],
  ]);
});
