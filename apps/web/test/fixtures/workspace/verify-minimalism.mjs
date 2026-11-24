import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Continue in the task's single browser against the local, non-sending fixture.
const output = process.env.TRADING_EVIDENCE_DIR;
assert.ok(output && process.env.TRADING_CDP_URL);
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page = browser.contexts()[0].pages()[0];
assert.equal(new URL(page.url()).hostname, '127.0.0.1');
assert.equal(new URL(page.url()).pathname, '/trading-proof');
const cdp = await page.context().newCDPSession(page);
const results = [];
page.setDefaultTimeout(15000);
const settle = () => page.waitForTimeout(500);
try {
  await page.goto('http://127.0.0.1:42874/trading-proof', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  if (await page.locator('[data-workspace-panels]').count()) {
    await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('b'); await settle();
  }
  await page.locator('#trading-seed').click(); await page.waitForTimeout(1500);
  if (!await page.locator('[data-workspace-panels]').count()) await page.locator('#trading-open').click();
  await page.waitForFunction(() => !!window.tradingFixture);
  await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'no-preference' });
  for (const width of [320, 407, 1414]) {
    await page.setViewportSize({ width, height: 900 });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 1024, maxTouchPoints: 1 });
    for (const mode of ['compare', 'focus']) {
      await page.evaluate(mode => {
        const store = window.tradingFixture.store;
        store.setPresentation(mode); store.setDataCollapsed(true); store.selectMobile('A'); store.focus('A');
        window.tradingFixture.state('A', 'ready');
      }, mode);
      await settle();
      const card = page.locator('[data-panel-id="A"]');
      const header = card.locator('header[data-stable="true"]');
      await header.scrollIntoViewIfNeeded();
      const contract = header.getByRole('button', { name: /^Inspect full coin type on Sui mainnet:/ });
      const bounds = await contract.evaluate(e => {
        const rect = e.getBoundingClientRect(); const parent = e.closest('header').getBoundingClientRect();
        return { coarse: matchMedia('(pointer:coarse)').matches, height: rect.height, fits: rect.left >= parent.left && rect.right <= parent.right, hit: e.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
      });
      assert.ok(bounds.fits && bounds.hit, `${width} ${mode}: contract is visible and reachable`);
      if (width < 1024) assert.ok(bounds.height >= 44, `${width} ${mode}: ${JSON.stringify(bounds)}`);
      await contract.click();
      await page.getByRole('dialog', { name: 'coin type on Sui mainnet', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Inspect full coin type on Sui mainnet:'));
      const price = card.getByRole('button', { name: /^Inspect full observed USD price:/ }).first();
      await price.click();
      await page.getByRole('dialog', { name: 'observed USD price', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog', { name: 'coin type on Sui mainnet', exact: true }).count(), 0);
      await page.keyboard.press('Escape');
      results.push({ width, mode, contract: bounds });
    }
  }
  await page.setViewportSize({ width: 1414, height: 900 });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.evaluate(() => {
    const s = window.tradingFixture.store; s.setDataCollapsed(false); s.selectDataView('Coins');
    const controls = s.getSnapshot().data.controls.Coins;
    s.patchDataControls('Coins', { ...controls, navigation: { ...controls.navigation, expanded_ids: [] } });
  });
  await settle();
  const data = page.locator('#workspace-data-panel');
  const lists = data.getByRole('button', { name: /^More coin lists:/ });
  assert.equal(await lists.isVisible(), false, 'Secondary lists wait in Filters');
  await data.getByRole('button', { name: /^Filters/ }).click();
  await lists.click();
  await page.getByRole('menuitemradio', { name: 'Following', exact: true }).click();
  await settle();
  assert.equal(await page.evaluate(() => window.tradingFixture.store.getSnapshot().data.controls.Coins.source), 'following');
  await data.getByRole('button', { name: /^Filters/ }).click();
  await data.getByText('Following · 24h', { exact: true }).waitFor();
  await data.getByRole('button', { name: 'Trending', exact: true }).click();
  for (const selected of ['Coins', 'Portfolio', 'Presales']) {
    await page.evaluate(view => window.tradingFixture.store.selectDataView(view), selected); await settle();
    const header = page.locator('#workspace-data > div:not([hidden]) header').first();
    const layout = await header.evaluate(e => {
      const outer = e.getBoundingClientRect();
      return [...e.querySelectorAll('button,select')].filter(b => b.getBoundingClientRect().width > 0).map(b => { const r = b.getBoundingClientRect(); return { name: b.textContent, rect: r.toJSON(), fits: r.left >= outer.left - 1 && r.right <= outer.right + 1 }; });
    });
    assert.ok(layout.every(b => b.fits), `${selected} discovery header: ${JSON.stringify(layout)}`);
    for (let a = 0; a < layout.length; a++) for (let b = a + 1; b < layout.length; b++) {
      const first = layout[a].rect; const second = layout[b].rect;
      const overlap = Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1;
      assert.equal(overlap, false, `${selected}: ${layout[a].name} overlaps ${layout[b].name}`);
    }
  }
  await page.evaluate(() => window.tradingFixture.store.selectDataView('Coins'));
  await settle();
  await page.screenshot({ path: `${output}/after-minimalism-desktop.png`, animations: 'disabled' });
  await writeFile(`${output}/minimalism-interactions.json`, JSON.stringify(results, null, 2));
  console.log('PASS: contract/price hit targets, exact inspection and Escape, secondary discovery lists and header widths');
} finally { await browser.close(); }
