import assert from "node:assert/strict";
import test from "node:test";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import { NO_COST_BASIS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { summarizePortfolio } from "@blast/server/modules/social/portfolio/summary.ts";
import { valueCommitments } from "@blast/server/modules/social/portfolio/position-value.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { isSocialPortfolio } from "#web/components/social/portfolio-client.ts";
import { portfolioCoverage, portfolioFigures } from "#web/components/social/portfolio/portfolio-model.ts";
import { shellPortfolioSummary } from "#web/components/social/use-shell-portfolio.ts";

const portfolio: SocialPortfolio = {
  balances: { sui: { atoms: "1000000000", usd: "4.00" }, usdc: { atoms: "10000000", usd: "10.00" } },
  positions: [], commitments: { committed_usd: "0.00", claimable_usd: "0.00" },
  coins: [{ coin_type: "test", symbol: "TEST", balance: "100", value_usd: "20.01", ...NO_COST_BASIS }],
  vesting: null, totals: null, trend: null, prices_as_of_ms: 1000, unavailable: ["vesting", "totals", "trend"],
};

test("summary keeps exact totals and whole-wallet daily change without chart series", async () => {
  const calls: string[] = [];
  const db = { read: async (sql: string) => {
    calls.push(sql);
    return { rows: [
      { ord: 1, price_usd: "4", at_24h: "0 2", at_day_open: "0 2" },
      { ord: 2, price_usd: "2", at_24h: "0 1", at_day_open: "0 1" },
    ] };
  } } as unknown as ReadableDatabase;
  const result = await summarizePortfolio(db, portfolio, 1000);
  assert.deepEqual(result.coins, []);
  assert.equal(result.coin_summary?.value_usd, "20.01");
  assert.equal(result.coin_summary?.known_value_usd, "20.01");
  assert.equal(result.coin_summary?.today?.usd, 12.005);
  assert.ok(Math.abs(result.coin_summary!.today!.pct - 12.005 / 22.005 * 100) < 1e-10);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.includes("at_day_open"));
});

test("an unpriced coin preserves known cents, omits daily change, and avoids history reads", async () => {
  const db = { read: () => { throw new Error("No history read expected"); } } as unknown as ReadableDatabase;
  const result = await summarizePortfolio(db, { ...portfolio, coins: [...portfolio.coins!, { ...portfolio.coins![0]!, coin_type: "unknown", value_usd: null }] }, 1000);
  assert.deepEqual(result.coin_summary, { value_usd: null, known_value_usd: "20.01", has_priced_holdings: true, today: null });
  const missing = await summarizePortfolio(db, { ...portfolio, coins: null }, 1000);
  assert.equal(missing.coins, null);
  assert.equal(missing.coin_summary?.value_usd, null);
});

test("history failure leaves the portfolio summary usable", async () => {
  const db = { read: () => { throw new Error("History unavailable"); } } as unknown as ReadableDatabase;
  assert.deepEqual((await summarizePortfolio(db, portfolio, 1000)).coin_summary, { value_usd: "20.01", known_value_usd: "20.01", has_priced_holdings: true, today: null });
});

test("mixed position subtotals survive full and summary validation and reach shared UI coverage", async () => {
  const db = { read: () => { throw new Error("Incomplete totals need no history read"); } } as unknown as ReadableDatabase;
  const commitments = valueCommitments([
    { commitment: "100000000", status: "open", quote_symbol: "USDC", quote_decimals: 6 },
    { commitment: "1000000000", status: "open", quote_symbol: "TSUI", quote_decimals: 9 },
    { commitment: "10000000", status: "claimable", quote_symbol: "USDC", quote_decimals: 6,
      claimable: { tokens: "2000000000", quote_refund: "5000000", sale_decimals: 9, price: null } },
  ], {}, 1000).commitments;
  const full = { ...portfolio, balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "0", usd: "0.00" } }, coins: [], commitments };
  const summary = await summarizePortfolio(db, full, 1000);
  for (const response of [full, summary]) {
    const payload = JSON.stringify(response);
    const body = JSON.parse(payload);
    assert.deepEqual(createSocialValidator().validate("portfolio-response", body).errors, []);
    assert.equal(isSocialPortfolio(body), true);
    assert.equal(portfolioFigures(body).total, null);
    assert.deepEqual(portfolioCoverage(body), { knownUsd: 105 });
    const header = shellPortfolioSummary(body, new Map());
    assert.equal(header.total_usd, null);
    assert.equal(header.known_value_usd, 105);
    assert.deepEqual(header.breakdown, { coins: 0, committed: null, claimable: null });
  }
});


test("owner schedule links survive full and summary validation without USD valuation", async () => {
  const db = { read: () => { throw new Error("Unpriced amounts need no history read"); } } as unknown as ReadableDatabase;
  const full = { ...portfolio, vesting: { has_schedule: true, href: "/portfolio/vestings" },
    coins: [{ ...portfolio.coins![0]!, coin_type: "0x2::aftest::AFTEST", value_usd: null }], unavailable: ["totals", "trend"] as const };
  for (const response of [full, await summarizePortfolio(db, full, 1000)]) {
    assert.deepEqual(createSocialValidator().validate("portfolio-response", response).errors, []);
    assert.equal(isSocialPortfolio(response), true);
    assert.equal(response.vesting?.href, "/portfolio/vestings");
  }
});
