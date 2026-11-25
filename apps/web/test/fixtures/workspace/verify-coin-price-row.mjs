import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

// The header shows "—" until the first live close, then the price, then the
// last trade's note. After the viewer's own trade it waits with "—" for a close
// that includes the trade.
// The page must not move at either step: a reader scrolled down stays exactly
// where they were.
const origin = new URL(process.env.PRICE_ROW_FIXTURE_URL ?? "http://127.0.0.1:42863/price-row-proof");
assert.equal(origin.hostname, "127.0.0.1", "Use the controlled loopback fixture");
assert.ok(process.env.PRICE_ROW_CDP_URL, "Set PRICE_ROW_CDP_URL to the task-owned browser");
assert.ok(process.env.PRICE_ROW_EVIDENCE_DIR, "Set PRICE_ROW_EVIDENCE_DIR to a task output folder");
const output = process.env.PRICE_ROW_EVIDENCE_DIR;
const results = [];
let browser, page;

before(async () => {
  await mkdir(output, { recursive: true });
  browser = await chromium.connectOverCDP(process.env.PRICE_ROW_CDP_URL);
  page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(90_000);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin.origin || url.protocol === "data:" ? route.continue() : route.abort();
  });
});

after(async () => {
  await writeFile(`${output}/price-row-results.json`, JSON.stringify(results, null, 2));
  await browser?.close(); // Disconnect; agent-browser owns and closes the browser.
});

// Wide prices wrap the row's currency control; a short "—" would not.
const PRICES = ["0.0000000168", "12345.678901"];

for (const width of [1440, 1024, 390, 320]) {
  for (const price of PRICES) {
    test(`the price row keeps its height from the first price to the viewer's trade (${width}px, ${price})`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(origin.href, { waitUntil: "load" });
      await page.waitForFunction(() => window.priceRowProof && document.querySelector('[data-proof-slot="activity"]'));
      await page.evaluate(() => document.fonts.ready);
      const row = page.locator("[data-bonding-coin] strong").first();
      const measure = () => page.evaluate(() => {
        const strong = document.querySelector("[data-bonding-coin] strong");
        const rowNode = strong.closest("div[class*='marketPriceRow']");
        const anchor = document.querySelector('[data-proof-slot="activity"]');
        return { text: strong.textContent, row: rowNode.getBoundingClientRect().height, anchor: anchor.getBoundingClientRect().top + scrollY, docHeight: document.documentElement.scrollHeight, y: scrollY };
      });
      await page.evaluate(() => scrollTo({ top: document.querySelector('[data-proof-slot="activity"]').getBoundingClientRect().top + scrollY - 200, behavior: "instant" }));
      await row.filter({ hasText: "—" }).waitFor();
      const first = await measure();
      await page.evaluate((value) => window.priceRowProof.publish(value), price);
      await row.filter({ hasNotText: "—" }).waitFor();
      const shown = await measure();
      await page.evaluate(() => window.priceRowProof.lastTrade());
      await page.locator('[data-chart-last-trade="headline"]:not([data-idle])').waitFor();
      const noted = await measure();
      await page.evaluate(() => window.priceRowProof.trade());
      await row.filter({ hasText: "—" }).waitFor();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const waiting = await measure();
      const held = await page.evaluate(() => {
        const copy = document.querySelector("[data-bonding-coin] strong[aria-hidden='true']");
        return copy && getComputedStyle(copy).visibility;
      });
      results.push({ width, price, first, shown, noted, waiting, held });
      assert.equal(held, "hidden", "the kept price is unseen");
      assert.equal(shown.row, first.row, "the price row height when the first price arrives");
      assert.equal(shown.anchor, first.anchor, "content below the price row when the first price arrives");
      assert.equal(noted.row, shown.row, "the price row height when the last trade arrives");
      assert.equal(noted.anchor, shown.anchor, "content below the price row when the last trade arrives");
      assert.equal(waiting.row, shown.row, "the price row height");
      assert.equal(waiting.anchor, shown.anchor, "content below the price row");
      assert.equal(waiting.y, shown.y, "the reader's scroll position");
    });
  }
}
