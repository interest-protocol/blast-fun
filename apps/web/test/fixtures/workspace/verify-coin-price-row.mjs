import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

// After a trade the coin page refreshes at a newer checkpoint than the chart's
// last live close, so the header waits with "—". The page must not move while
// it waits: a reader scrolled down to the trade stays exactly where they were.
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
    test(`the price row keeps its height when a refresh outruns the live close (${width}px, ${price})`, async () => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(origin.href, { waitUntil: "load" });
      await page.waitForFunction(() => window.priceRowProof && document.querySelector('[data-proof-slot="activity"]'));
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate((value) => window.priceRowProof.publish(value), price);
      const row = page.locator("[data-bonding-coin] strong").first();
      await row.filter({ hasNotText: "—" }).waitFor();
      const measure = () => page.evaluate(() => {
        const strong = document.querySelector("[data-bonding-coin] strong");
        const rowNode = strong.closest("div[class*='marketPriceRow']");
        const anchor = document.querySelector('[data-proof-slot="activity"]');
        return { text: strong.textContent, row: rowNode.getBoundingClientRect().height, anchor: anchor.getBoundingClientRect().top + scrollY, docHeight: document.documentElement.scrollHeight, y: scrollY };
      });
      await page.evaluate(() => scrollTo({ top: document.querySelector('[data-proof-slot="activity"]').getBoundingClientRect().top + scrollY - 200, behavior: "instant" }));
      const shown = await measure();
      await page.evaluate(() => window.priceRowProof.refresh());
      await row.filter({ hasText: "—" }).waitFor();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const waiting = await measure();
      const held = await page.evaluate(() => {
        const copy = document.querySelector("[data-bonding-coin] strong[aria-hidden='true']");
        return copy && getComputedStyle(copy).visibility;
      });
      results.push({ width, price, shown, waiting, held });
      assert.equal(held, "hidden", "the kept price is unseen");
      assert.equal(waiting.row, shown.row, "the price row height");
      assert.equal(waiting.anchor, shown.anchor, "content below the price row");
      assert.equal(waiting.y, shown.y, "the reader's scroll position");
    });
  }
}
