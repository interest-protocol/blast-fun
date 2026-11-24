import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { publicPortfolioQuery } from "../queries";
import { PublicTraderPortfolio } from "./PublicTraderPortfolio";

const portfolio: SocialPortfolio = {
  balances: null, positions: null, commitments: null, coins: null, vesting: null, totals: null,
  trend: null, prices_as_of_ms: null, unavailable: ["balances", "positions", "coins", "vesting", "totals", "trend"],
};

function render(data: SocialPortfolio) {
  const client = new QueryClient();
  client.setQueryData(publicPortfolioQuery("nova").queryKey, data);
  try {
    return new JSDOM(renderToStaticMarkup(<QueryProvider client={client}><PublicTraderPortfolio callsign="nova" /></QueryProvider>));
  } finally { client.clear(); }
}

test("public portfolios omit unavailable sections and metric labels, while keeping exact balances and known zero", () => {
  let dom = render(portfolio);
  try {
    assert.equal(dom.window.document.querySelector("section"), null);
    assert.doesNotMatch(dom.window.document.body.textContent!, /Holdings|Cash|Presales|unavailable|—/);
  } finally { dom.window.close(); }
  const coin = { coin_type: "0xa::coin::TEST", symbol: "TEST", balance: "900719925474099312345", value_usd: null, basis_usd: null, basis_complete: false, pnl_usd: null, pnl_multiple: null };
  dom = render({ ...portfolio, coins: [coin] });
  try {
    const { document } = dom.window;
    assert.match(document.body.textContent!, /TEST900719925474099312345 base units/);
    assert.doesNotMatch(document.body.textContent!, /Value · USD|Unrealized PnL|unavailable|—/);
    const row = document.querySelector(".holdingRow")!;
    assert.equal(row.children.length, 4, "unknown table metrics leave structural cells for column alignment");
    assert.ok([...row.children].slice(1).every(cell => cell.textContent === ""));
  } finally { dom.window.close(); }
  dom = render({ ...portfolio, coins: [{ ...coin, value_usd: "0.00", pnl_usd: "0.00" }], balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "0", usd: "0.00" } }, positions: [] });
  try {
    const { document } = dom.window;
    assert.match(document.body.textContent!, /Value · USDUnrealized PnL/);
    assert.equal(document.querySelector(".holdingRow")!.children[1]!.textContent, "$0");
    assert.equal(document.querySelector(".holdingRow")!.children[3]!.textContent, "$0");
    assert.match(document.body.textContent!, /SUI: 0 SUI · USDC: 0 USDC/);
    assert.match(document.body.textContent!, /No presales/);
  } finally { dom.window.close(); }
});
