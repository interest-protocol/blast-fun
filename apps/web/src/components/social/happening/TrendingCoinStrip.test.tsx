import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { HappeningCoin } from "@blast/core/modules/social/contracts/happening.ts";

import { TrendingCoinStripView } from "./TrendingCoinStrip";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const coin: HappeningCoin = { coin_type: "test::coin::COIN", presale_id: "sale", name: "Trending coin", symbol: "COIN", icon_url: null, price_usd: "0.0021", change_24h_bps: 1200, buyers_24h: 50, holders: 100 };

test("expanded and collapsed Trending preserve the same ten coins, icons and ranking", () => {
  const coins = Array.from({ length: 12 }, (_, index) => ({ ...coin, coin_type: `coin${index}`, symbol: `C${index}`, icon_url: `https://cdn.blast.fun/coin${index}.png` }));
  const render = (expanded: boolean) => renderToStaticMarkup(<TrendingCoinStripView coins={coins} expanded={expanded} onOpen={() => undefined} />);
  const expanded = render(true);
  const collapsed = render(false);
  const labels = (html: string) => [...html.matchAll(/<button[^>]+aria-label="([^"]+)"/g)].map((match) => match[1]);
  const icons = (html: string) => [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(labels(expanded), labels(collapsed));
  assert.equal(labels(expanded).length, 10);
  assert.deepEqual(icons(expanded), icons(collapsed));
  assert.deepEqual([...expanded.matchAll(/<b class="trendingTicker">([^<]+)<\/b>/g)].map((match) => match[1]), coins.slice(0, 10).map((row) => row.symbol));
  assert.match(expanded, /C0, Trending coin, \$0\.0021, \+12% today\. View coin/);
  assert.match(expanded, /<b class="num">\$0\.0021<\/b>/);
  assert.doesNotMatch(collapsed, /<b[ >]|trendingValue/);
  assert.doesNotMatch(expanded, /Your coins|Deposit|withdraw|Sign in|Gainers|bought today/);
});

test("Trending distinguishes an unavailable feed from an empty ranking", () => {
  assert.match(renderToStaticMarkup(<TrendingCoinStripView coins={null} onOpen={() => undefined} />), /Trending coins are unavailable right now/);
  assert.match(renderToStaticMarkup(<TrendingCoinStripView coins={[]} onOpen={() => undefined} />), /No trending coins yet/);
});

test("Clicking a Trending coin opens its coin sheet, including native SUI", async () => {
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const opened: string[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<TrendingCoinStripView coins={[coin, { ...coin, coin_type: "sui", presale_id: null, name: "SUI", symbol: "SUI", change_24h_bps: null }]} onOpen={(key) => opened.push(key)} />));
    const collapsed = [...container.querySelectorAll("button")];
    for (const button of collapsed) await act(async () => button.click());
    await act(async () => root.render(<TrendingCoinStripView coins={[coin, { ...coin, coin_type: "sui", presale_id: null, name: "SUI", symbol: "SUI", change_24h_bps: null }]} expanded onOpen={(key) => opened.push(key)} />));
    const expanded = [...container.querySelectorAll("button")];
    assert.deepEqual(expanded, collapsed, "revealing details keeps the coin buttons mounted");
    for (const button of expanded) await act(async () => button.click());
    assert.deepEqual(opened, ["sale", "sui", "sale", "sui"]);
    assert.match(expanded[0]!.textContent ?? "", /COIN\$0\.0021\+12%/);
    assert.match(expanded[1]!.textContent ?? "", /SUI\$0\.0021$/, "an absent 24h change shows nothing, never a dash");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("tiny prices read with subscript zeros, never in exponent form, on the rail", () => {
  const tiny = { ...coin, price_usd: "0.000000000496" };
  const html = renderToStaticMarkup(<TrendingCoinStripView coins={[tiny]} expanded onOpen={() => undefined} />);
  assert.match(html, /\$0\.0₉496/);
  assert.doesNotMatch(html, /e-\d/);
});
