import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const out = process.env.TRADING_EVIDENCE_DIR;
assert.ok(out);
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page = browser.contexts()[0].pages().find(p => p.url().includes('/trading-proof'));
page.setDefaultTimeout(15000);
const results = [];
const panel = () => page.locator('[data-panel-id="A"]:visible');
const nav = () => page.getByRole('navigation', { name: 'Selected market navigation', exact: true });
const amount = () => panel().locator('[data-panel-amount]');
const capture = name => page.screenshot({ path: `${out}/${name}.png` });
const top = () => page.locator('[data-workspace-scroll]').evaluate(e => e.scrollTo({ top: 0, behavior: 'instant' }));
async function reopen() {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
  if (!(await page.locator('[data-workspace-host]').count())) await page.getByRole('button', { name: 'Open Blast mode', exact: true }).click();
  await page.waitForFunction(() => !!window.tradingFixture);
  await page.evaluate(() => {
    const s = window.tradingFixture.store;
    s.focus('A'); s.selectMobile('A'); s.setDataCollapsed(true);
    const p = s.getSnapshot().panels.A;
    s.patchPanel('A', { coin: { ...p.coin, trade: { ...p.coin.trade, side: 'buy' } } });
    s.setLayout({ order: ['chart', 'trade', 'activity', 'details'], hidden: [], split: 64 });
    window.tradingFixture.state('A', 'ready');
  });
  await amount().waitFor();
}
try {
  await page.evaluate(() => localStorage.setItem('blast.hideBal', 'false'));
  await reopen();
  for (const width of [320, 407, 768, 1054, 1414]) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'no-preference', reducedTransparency: 'no-preference' });
    if (width <= 768) {
      const discover = nav().getByRole('button', { name: 'Discover', exact: true });
      await discover.focus(); await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Discover', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('dialog', { name: 'Discover', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await discover.evaluate(e => e === document.activeElement), true);
      await nav().getByRole('button', { name: 'Trade', exact: true }).focus(); await page.keyboard.press('Enter');
      assert.equal(await amount().evaluate(e => e === document.activeElement), true);
      await page.keyboard.press('Tab');
      assert.ok(await panel().evaluate(e => e.contains(document.activeElement)));
    } else {
      const corner = panel().locator('[data-workspace-section="chart"] [data-grid-resize="se"]');
      await corner.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
      assert.equal(await corner.evaluate(e => e === document.activeElement), true);
    }
    for (const [name, media] of [
      ['reduced-motion', { reducedMotion: 'reduce', contrast: 'no-preference', reducedTransparency: 'no-preference' }],
      ['increased-contrast', { reducedMotion: 'no-preference', contrast: 'more', reducedTransparency: 'no-preference' }],
      ['reduced-transparency', { reducedMotion: 'no-preference', contrast: 'no-preference', reducedTransparency: 'reduce' }],
    ]) {
      await page.emulateMedia(media); await top();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.ok(await panel().locator('[data-coin-chart] svg[role="img"]').isVisible());
      assert.ok(await amount().isVisible());
      if (width === 407) await capture(`mobile-${name}`);
    }
    results.push(`Keyboard and independent motion/contrast/transparency preferences at ${width}px`);
    console.log('PASS', results.at(-1));
  }
  await page.evaluate(() => localStorage.setItem('blast.hideBal', 'true'));
  await reopen();
  // Definition lists retain native semantics rather than pretending to be a generic ARIA list.
  const values = panel().locator('dl[aria-label="Selected market facts"] dd');
  await page.waitForFunction(() => [...document.querySelectorAll('dl[aria-label="Selected market facts"] dd')].every(e => e.textContent === '••••'));
  assert.equal(await values.count(), 3);
  assert.equal(await panel().locator('dl[aria-label="Selected market facts"] button').count(), 0);
  await capture('amount-privacy');
  results.push('Amount privacy conceals all selected-market facts and removes exact-value inspection'); console.log('PASS', results.at(-1));
  await page.evaluate(() => localStorage.setItem('blast.hideBal', 'false'));
  await reopen();
  await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'no-preference', reducedTransparency: 'no-preference' });
  await amount().fill('50');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-panel-id="A"] button')].some(e => e.textContent === 'Buy KSTL' && !e.disabled));
  for (const width of [1414, 407]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.locator('[data-blast-ui]').evaluate((e, t) => e.setAttribute('data-theme', t), theme);
      await top(); await capture(`final-${width}-${theme}`);
      if (width === 407) {
        await nav().getByRole('button', { name: 'Trade', exact: true }).click();
        await capture(`final-mobile-trade-${theme}`);
      }
    }
  }
  console.log('PASS final previews captured with simulated $50 quote, no submission');
} finally {
  writeFileSync(`${out}/preferences-results.json`, JSON.stringify({ results }, null, 2));
  await browser.close();
}
