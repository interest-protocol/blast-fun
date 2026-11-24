import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const base = process.env.TRADING_FIXTURE_URL;
const out = process.env.TRADING_EVIDENCE_DIR;
assert.equal(new URL(base).hostname, '127.0.0.1');
assert.ok(out && process.env.TRADING_CDP_URL);
await mkdir(out, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const context = await browser.newContext({ reducedMotion: 'reduce' });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const results = { discovery: [], stats: [], states: [] };
const marketFacts = () => page.locator('[aria-label="Selected market facts"]');
const rail = () => page.getByRole('region', { name: 'Asset browser', exact: true });
const settle = () => page.waitForTimeout(200);
const top = () => page.evaluate(() => {
  document.activeElement?.blur();
  document.querySelectorAll('*').forEach(element => { if (element.scrollTop) element.scrollTop = 0; });
});
const theme = value => page.locator('[data-blast-ui]').first().evaluate((element, value) => element.setAttribute('data-theme', value), value);
const reachable = locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return element === target || element.contains(target);
});
async function clearPanels() {
  await page.evaluate(() => {
    const store = window.tradingFixture?.store;
    if (!store) return;
    for (const id of Object.keys(store.getSnapshot().panels)) store.remove(id);
    store.setDataCollapsed(false);
  });
}
async function measureStats(width, appearance, state) {
  await top();
  await settle();
  const geometry = await marketFacts().evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width, overviewWidth: element.parentElement.getBoundingClientRect().width, priceShown: !!element.parentElement.querySelector('[aria-label="Market price"]'), availableWidth: element.closest('[data-panel-id]').getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth + 1,
      cells: [...element.children].map(cell => {
        const rect = cell.getBoundingClientRect();
        const label = cell.querySelector('dt');
        const value = cell.querySelector('dd');
        return { label: label.textContent, x: rect.x, y: rect.y, width: rect.width,
          labelWidth: label.getBoundingClientRect().width, labelHidden: label.classList.contains('sr'),
          valueWidth: value.clientWidth, valueScroll: value.scrollWidth, valueText: value.textContent,
          valueFits: value.scrollWidth <= value.clientWidth + 1 };
      }),
      freshnessContained: [...element.querySelectorAll('[aria-label="Refresh holder count"]')].every(button => {
        const cell = button.closest('dd').getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        return rect.left >= cell.left - 1 && rect.right <= cell.right + 1 && rect.top >= cell.top - 1 && rect.bottom <= cell.bottom + 1;
      }),
    };
  });
  console.log(JSON.stringify({width, appearance, state, geometry}));
  if (!geometry.priceShown) assert.ok(geometry.width >= geometry.overviewWidth - 1, 'Stats must span the missing price column');
  assert.equal(geometry.overflow, false, `${width} ${state}: stats overflow`);
  assert.ok(geometry.cells.every(cell => cell.valueFits), `${width} ${state}: clipped stat value`);
  assert.ok(geometry.freshnessContained, `${width}: holder refresh must remain with its stat`);
  if (width <= 407 && geometry.cells.length > 1) {
    assert.ok(geometry.width >= geometry.availableWidth - 40, 'Mobile stats must fill the header even without a price');
    assert.ok(geometry.cells.every(cell => cell.labelHidden || cell.labelWidth >= cell.width * .8), 'Mobile labels must use their column');
    assert.ok(Math.max(...geometry.cells.map(cell => cell.x)) - Math.min(...geometry.cells.map(cell => cell.x)) > geometry.width * .4, 'Mobile stats must occupy both columns');
    assert.ok(Math.max(...geometry.cells.map(cell => cell.width)) - Math.min(...geometry.cells.map(cell => cell.width)) <= 1, 'Mobile stat columns must be equal');
  }
  results.stats.push({ width, theme: appearance, state, ...geometry });
}

try {
  await page.setViewportSize({ width: 1414, height: 1000 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
  await page.locator('#trading-open').click();
  for (const appearance of ['light', 'dark']) for (const width of [1054, 1414]) for (const height of [400, 577, 1000]) {
    await clearPanels();
    await page.getByRole('heading', { name: 'Your workspace, ready to build', exact: true }).waitFor();
    await page.setViewportSize({ width, height });
    await theme(appearance);
    await top();
    await rail().getByRole('button', { name: 'Trending', exact: true }).click();
    const first = rail().getByRole('button', { name: 'Open ORBT in Focus', exact: true });
    await first.waitFor();
    await settle();
    assert.ok(await reachable(first), 'First discovery row must be reachable before selecting an asset');
    const last = rail().getByRole('button', { name: 'Open KSTL in Focus', exact: true });
    await last.scrollIntoViewIfNeeded();
    assert.ok(await reachable(last), 'Last discovery row must be reachable by scrolling');
    await page.screenshot({ path: `${out}/empty-discovery-${appearance}-${width}-${height}.png` });
    await last.click();
    await page.locator('[data-workspace-section="chart"] canvas').first().waitFor();
    await page.waitForFunction(() => !!window.tradingFixture);
    console.log(`Discovery ${appearance} ${width}×${height}: PASS`);
    results.discovery.push({ width, height, theme: appearance, firstReachable: true, lastReachable: true, pointerSelection: true });
  }
  const amount = page.locator('[data-panel-amount]').first();
  await amount.fill('123.45');
  const cdp = await context.newCDPSession(page);
  for (const appearance of ['light', 'dark']) for (const width of [320, 407, 768, 1054, 1414]) {
    await page.setViewportSize({ width, height: 1050 });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 1024, maxTouchPoints: 1 });
    await theme(appearance);
    await measureStats(width, appearance, 'ready');
    assert.equal(await amount.inputValue(), '123.45');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${out}/stats-${appearance}-${width}.png` });
  }
  for (const width of [1054, 1414]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const state of ['unpriced', 'unavailable', 'ready']) {
      await page.evaluate(state => window.tradingFixture.state(window.tradingFixture.store.getSnapshot().focused_panel_id, state), state);
      await settle();
      await measureStats(width, 'dark', state);
    }
  }
  await page.setViewportSize({ width: 320, height: 1050 });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  assert.ok(await page.evaluate(() => matchMedia('(pointer:coarse)').matches));
  for (const state of ['long-content', 'holders-old', 'holders-unavailable', 'unpriced', 'loading', 'unavailable', 'ready']) {
    await page.evaluate(state => {
      const id = window.tradingFixture.store.getSnapshot().focused_panel_id;
      window.tradingFixture.state(id, state);
    }, state);
    await settle();
    await measureStats(320, 'dark', state);
    results.states.push(state);
  }
  const refresh = page.getByRole('button', { name: 'Refresh holder count', exact: true });
  await refresh.scrollIntoViewIfNeeded();
  const refreshBounds = await refresh.boundingBox();
  assert.ok(refreshBounds.width >= 44 && refreshBounds.height >= 44, 'Phone refresh must retain its touch target');
  assert.ok(await reachable(refresh));
  await page.keyboard.press('Tab');
  await refresh.focus();
  assert.ok(await refresh.evaluate(element => element.matches(':focus-visible')));
  await refresh.evaluate(element => element.addEventListener('click', () => { window.keyboardHolderRefresh = true; }, { once: true }));
  await refresh.press('Enter');
  await settle();
  assert.ok(await page.evaluate(() => window.keyboardHolderRefresh), 'Enter must activate holder refresh');
  await refresh.waitFor();
  results.keyboardRefresh = true;
  results.coarsePhoneStates = true;
  await page.evaluate(() => localStorage.setItem('blast.hideBal', 'true'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
  if (!await page.locator('[data-workspace-host]').count()) await page.locator('#trading-open').click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Selected market facts"]')?.textContent.includes('••••'));
  await theme('dark');
  assert.match(await marketFacts().innerText(), /••••/);
  await measureStats(320, 'dark', 'private');
  assert.deepEqual(errors, []);
  await writeFile(`${out}/verification.json`, JSON.stringify(results, null, 2));
  console.log('PASS: empty discovery pointer selection/scroll at two desktop widths and heights; balanced stats at five widths in both themes; adverse states, privacy and retained amount. Controlled fixture data; no transactions.');
} catch (error) {
  console.error((await page.locator('body').innerText()).slice(0,2500));
  await page.screenshot({ path: `${out}/verification-failure.png` });
  throw error;
} finally {
  await context.close();
  await browser.close();
}
