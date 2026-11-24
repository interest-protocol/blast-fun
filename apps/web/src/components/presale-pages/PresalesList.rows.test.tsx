import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import { PresaleRow } from "./PresalesList";
import { fixtureList, FIXTURE_NOW } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";

test("list rows keep concise funding facts, exact overflow rules and a single destination", () => {
  const base = fixtureList("live", "ending").presales[0]!;
  for (const [raised, bps, percentage, overflow, committed] of [
    [0n, 0, "0%", false, "0 USDC"],
    [99n, 9900, "99%", false, "0.000099 USDC"],
    [100n, 10000, "100%", false, "0.0001 USDC"],
    [101n, 10100, "101%", true, "0.000101 USDC"],
    [110n, 11000, "110%", true, "0.00011 USDC"],
  ] as const) {
    const sale = { ...base, name: "A long project name 日本語 🚀", quote_symbol: "USDC", quote_decimals: 6, target_atoms: "100", raised_atoms: raised.toString(), fill_bps: bps, participants: 12345 };
    const dom = new JSDOM(renderToStaticMarkup(<PresaleRow sale={sale} now={FIXTURE_NOW} viewer={null} />));
    try {
      const row = dom.window.document.querySelector("a")!;
      assert.equal(row.getAttribute("href"), `/presale/${sale.presale_id}`);
      assert.equal(row.querySelectorAll("a, button").length, 0);
      assert.equal(row.querySelector(".sr-name b")?.getAttribute("title"), sale.name);
      assert.equal(row.querySelector(".sr-symbol")?.textContent, sale.symbol);
      assert.equal(row.querySelector(".sr-fill .num")?.textContent, percentage);
      assert.equal(row.querySelector(".sr-oversubscribed")?.textContent ?? null, overflow ? "Above target" : null);
      assert.equal(row.querySelector(".sr-back")?.children.length, 3);
      assert.equal(row.querySelector(".sr-back b")?.textContent, committed.replace(" USDC", ""));
      assert.equal(row.querySelector(".sr-back > span:last-child")?.textContent?.trim(), "12,345 backers");
      assert.doesNotMatch(row.textContent!, /Allocation|proportional|refund/);
    } finally {
      dom.window.close();
    }
  }
});
