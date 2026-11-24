import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const out = process.env.TRADING_EVIDENCE_DIR;
assert.ok(out, 'TRADING_EVIDENCE_DIR is required');
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page = browser.contexts()[0].pages().find(page => page.url().includes('/trading-proof'));
assert.ok(page, 'Open the trading-proof fixture in the task browser');
page.setDefaultTimeout(12000);
const results = [];
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const panel = () => page.locator('[data-panel-id]:visible').filter({ has: page.locator('[data-workspace-section="chart"]') }).first();
const discovery = () => panel().getByRole('region', { name: 'Discover markets', exact: true });
async function visibleChart(label = 'Observed pool price history') {
  const plot = panel().locator('[data-coin-chart]').getByRole('img', { name: label, exact: true });
  await plot.waitFor({ state: 'attached' });
  const box = await plot.boundingBox();
  assert.ok(box && box.width >= 100 && box.height >= 100, `Price plot must fill its card: ${JSON.stringify(box)}`);
  const frame = await panel().getByRole('group', { name: 'Inspect price history', exact: true }).boundingBox();
  assert.ok(frame && frame.height >= box.height, 'The keyboard/pointer inspection surface must contain the visible plot');
}
const top = () => page.locator('[data-workspace-scroll]').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
const state = async name => {
  const id = await panel().getAttribute('data-panel-id');
  await page.evaluate(({ id, name }) => window.tradingFixture.state(id, name), { id, name });
};
async function record(name, run) {
  await run();
  results.push(name);
  console.log('PASS', name);
}
async function capture(name) {
  await page.screenshot({ path: `${out}/${name}.png` });
}
async function edit() {
  await page.getByRole('button', { name: 'Workspace options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit layout', exact: true }).click();
}
try {
  await page.setViewportSize({ width: 1414, height: 659 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.reload();
  await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
  await page.waitForTimeout(1000);
  if (await page.locator('[data-workspace-host]').count()) {
    await page.keyboard.press('Escape');
    await page.locator('[data-workspace-host]').waitFor({ state: 'detached' });
  }
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Seed four assets', exact: true }).click()]);
  await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
  await record('Home advertises F and opens the workspace', async () => {
    const home = page.getByTitle('Open the trading workspace (F)', { exact: true });
    assert.equal(await home.getAttribute('aria-keyshortcuts'), 'F');
    assert.equal(await home.locator('kbd').textContent(), 'F');
    await capture('home-shortcut');
    await home.click();
    await page.waitForFunction(() => !!window.tradingFixture);
  });
  // Production can load CoinPanel's generic child reset after CoinChartVisual.
  const childReset = await page.evaluate(() => [...document.styleSheets]
    .flatMap(sheet => [...sheet.cssRules])
    .find(rule => rule.selectorText?.includes('chartStage') && / > \*$/.test(rule.selectorText))?.cssText);
  assert.ok(childReset, 'Use the actual chart-stage reset to exercise production CSS ordering');
  await page.addStyleTag({ content: childReset });
  // Start with a deterministic guest journal. The fixture disables all sends.
  await page.evaluate(() => {
    const store = window.tradingFixture.store;
    store.setCapacity(4);
    store.setLayout({ order: ['chart', 'trade', 'activity', 'details'], hidden: [], split: 64, terminal: { order: ['chart', 'trade', 'activity'], widths: [50, 25, 25], height: 380 } });
    store.focus('A'); store.selectMobile('A'); store.setDataCollapsed(true);
  });
  await state('ready');
  await panel().getByRole('button', { name: 'Buy', exact: true }).click();
  await record('Desktop shells align, gutters hold handles, Buy/Sell does not move discovery', async () => {
    await top();
    await visibleChart();
    const rects = await panel().locator('[data-workspace-section]').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.dataset.workspaceSection, element.getBoundingClientRect().toJSON()])));
    assert.ok(Math.abs(rects.chart.height - rects.trade.height) < 1);
    assert.ok(Math.abs(rects.trade.height - rects.activity.height) < 1);
    assert.ok(rects.trade.x - rects.chart.right >= 16);
    const before = await discovery().boundingBox();
    await panel().getByRole('button', { name: 'Sell', exact: true }).click();
    await page.waitForTimeout(200);
    const after = await discovery().boundingBox();
    assert.ok(Math.abs(before.y - after.y) < 1);
    assert.match(await panel().getByRole('button', { name: /^Receive / }).innerText(), /Receive/);
    await panel().getByRole('button', { name: 'Buy', exact: true }).click();
    assert.match(await panel().getByRole('button', { name: /^Pay with / }).innerText(), /Pay with/);
    await capture('desktop-light');
  });
  await record('Discovery scrolls; selecting a lower row keeps the fixed toolbar recoverable', async () => {
    const scroller = page.locator('[data-workspace-scroll]');
    assert.equal(await scroller.evaluate(e => getComputedStyle(e).overflowY), 'auto');
    await discovery().getByRole('button', { name: 'New coins', exact: true }).click();
    await discovery().getByRole('button', { name: 'Open LUMN coin', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-panel-id="B"]')?.checkVisibility());
    assert.equal(await scroller.evaluate(e => e.scrollTop), 0);
    assert.equal(await page.locator('[data-workspace-host]').evaluate(e => e.scrollTop), 0);
    const toolbar = await page.getByRole('button', { name: 'Workspace options', exact: true }).boundingBox();
    assert.ok(toolbar.y >= 0);
    await page.locator('[data-panel-chip="A"]').click();
    await top();
  });
  await record('Discover and slash focus inline search; results stay in the terminal', async () => {
    await page.getByRole('button', { name: 'Discover coins and presales', exact: true }).click();
    const search = discovery().getByRole('searchbox');
    assert.equal(await search.evaluate(e => e === document.activeElement), true);
    assert.equal(await page.getByRole('dialog', { name: 'Discover', exact: true }).count(), 0);
    await search.fill('KSTL');
    await discovery().getByText('Trading coins and open presales · all sources', { exact: true }).waitFor();
    await discovery().getByRole('button', { name: /KSTL/ }).last().waitFor();
    await search.fill('');
    await page.getByRole('button', { name: 'Workspace options', exact: true }).focus();
    await page.keyboard.press('/');
    assert.equal(await search.evaluate(e => e === document.activeElement), true);
    await search.fill(''); await search.blur(); await top();
  });
  await record('Duplicate markets expose distinct inspectable and copyable identities', async () => {
    await page.evaluate(() => window.discoveryFixture.state = 'duplicates');
    await discovery().getByRole('button', { name: 'Refresh discovery', exact: true }).click();
    const copies = discovery().getByRole('button', { name: 'Copy KSTL coin type', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Copy KSTL coin type"]')].filter(e => e.checkVisibility()).length === 2);
    assert.equal(await copies.count(), 2);
    const identities = await discovery().getByRole('button', { name: /^Inspect full KSTL coin type/ }).allTextContents();
    assert.equal(new Set(identities).size, 2);
    await browser.contexts()[0].grantPermissions(['clipboard-read', 'clipboard-write']);
    await copies.last().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '0xdeadbeef::kestrel::KSTL');
    await page.evaluate(() => window.discoveryFixture.state = 'ready');
    await discovery().getByRole('button', { name: 'Refresh discovery', exact: true }).click();
    await top();
  });
  await record('Layout editing, keyboard resizing and cancel preserve reachable discovery and drafts', async () => {
    const amount = panel().locator('[data-panel-amount]');
    await amount.fill('12.34');
    await edit();
    await panel().getByRole('button', { name: 'Move Trade later', exact: true }).click();
    assert.equal(await amount.inputValue(), '12.34');
    await discovery().getByRole('button', { name: 'Trending', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await top();
    const height = panel().locator('[data-workspace-section=chart] [data-grid-resize=se]');
    const before = await panel().locator('[data-workspace-section=chart]').evaluate(e => Math.round(e.getBoundingClientRect().height));
    await height.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await panel().locator('[data-workspace-section=chart]').evaluate(e => Math.round(e.getBoundingClientRect().height)), before + 20);
    await page.keyboard.press('ArrowUp');
    assert.equal(await panel().locator('[data-workspace-section=chart]').evaluate(e => Math.round(e.getBoundingClientRect().height)), before);
    await height.focus(); await page.keyboard.press('Home');
    const action = panel().getByRole('button', { name: 'Buy KSTL', exact: true });
    await action.scrollIntoViewIfNeeded();
    const actionBox = await action.boundingBox();
    const tradeBox = await panel().locator('[data-workspace-section=trade]').boundingBox();
    assert.ok(actionBox.y >= tradeBox.y && actionBox.y + actionBox.height <= tradeBox.y + tradeBox.height);
    await height.focus(); await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.evaluate(() => { const s=window.tradingFixture.store; s.setLayout({ ...s.getSnapshot().layout, terminal: { ...s.getSnapshot().layout.terminal, height: 380, grid: undefined } }); });
    assert.equal(await amount.inputValue(), '12.34'); await top();
  });
  await record('Sparse, missing, loading and failed histories explain their state and recover', async () => {
    await state('native-ready');
    await visibleChart('Native pool candles');
    await state('sparse');
    await panel().locator('[data-chart-empty="sparse"]').waitFor();
    assert.match(await panel().locator('[data-chart-empty="sparse"]').innerText(), /1 recorded observation.*Last observed.*USD pricing unavailable/s);
    await capture('sparse-chart');
    await state('unpriced');
    await panel().getByText('No USD price yet', { exact: true }).waitFor();
    await state('coin-error');
    await panel().getByText('USD price could not load', { exact: true }).waitFor();
    await state('loading');
    await panel().getByRole('status', { name: 'Loading price history', exact: true }).waitFor();
    await state('error');
    await panel().getByRole('button', { name: 'Retry price history', exact: true }).click();
    await state('ready'); await panel().locator('[aria-label="Observed pool price history"]').waitFor();
  });
  await record('Holder age and empty states are visible without the pool coverage banner', async () => {
    await panel().getByRole('button', { name: 'Holders', exact: true }).click();
    const age = panel().getByRole('button', { name: /^Inspect full holder count observation/ });
    assert.doesNotMatch(await age.innerText(), /Snapshot time/);
    assert.match(await age.innerText(), /now|ago/);
    await panel().getByText('No indexed holders', { exact: true }).waitFor();
    await panel().getByRole('button', { name: 'Trades', exact: true }).click();
    assert.equal(await panel().getByText('Blast pool & presale trades · 24h · other venues excluded', { exact: true }).count(), 0);
    await panel().getByRole('button', { name: 'Posts', exact: true }).click();
    await panel().getByText('Posts unavailable', { exact: true }).waitFor();
    await capture('empty-context');
    await panel().getByRole('button', { name: 'Trades', exact: true }).click();
  });
  await record('Recent panels popover stays inside short desktop and phone viewports', async () => {
    await page.evaluate(() => window.tradingFixture.store.setCapacity(1));
    for (const width of [1414, 407, 320]) {
      await page.setViewportSize({ width, height: 659 });
      const trigger = page.getByRole('button', { name: /^Recent panels/ });
      await trigger.click();
      const popup = page.getByRole('region', { name: 'Recent panels', exact: true });
      const box = await popup.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1, JSON.stringify(box));
      assert.ok(box.y >= 0 && box.y + box.height <= 660, JSON.stringify(box));
      assert.equal(await popup.getByRole("button", { name: /Select retained/ }).count() > 0 || await popup.locator("li > button:first-of-type").count() > 0, true);
      assert.equal(await popup.locator("li > button:first-of-type").first().evaluate(e => e === document.activeElement), true);
      await capture(`saved-${width}`);
      await popup.getByRole('button', { name: 'Inspect full coin type', exact: false }).first().focus();
      await page.keyboard.press('Tab');
      assert.equal(await popup.evaluate(e => e.contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.matches('[data-more-panels-trigger]'));
      assert.equal(await trigger.evaluate(e => e === document.activeElement), true);
    }
  });
  await record('All required widths scroll, retain focus, and avoid document overflow in both themes', async () => {
    await page.evaluate(() => window.tradingFixture.store.setCapacity(4));
    for (const width of [320, 407, 768, 1054, 1414]) {
      await page.setViewportSize({ width, height: 659 });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width <= 768 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(t => document.querySelector('[data-blast-ui]').setAttribute('data-theme', t), theme);
        await top();
        await visibleChart();
        const geometry = await page.evaluate(() => ({ width: innerWidth, doc: document.documentElement.scrollWidth, h: document.querySelector('[data-workspace-scroll]').clientHeight, scroll: document.querySelector('[data-workspace-scroll]').scrollHeight }));
        assert.ok(geometry.doc <= width, JSON.stringify(geometry));
        assert.ok(geometry.scroll > geometry.h);
        await discovery().getByRole('button', { name: 'New coins', exact: true }).click();
        await discovery().getByRole('button', { name: 'Open LUMN coin', exact: true }).click();
        assert.equal(await page.locator('[data-workspace-scroll]').evaluate(e => e.scrollTop), 0);
        await page.locator('[data-panel-chip="A"]').click();
        await top();
        if (width === 1054) {
          const action = await panel().getByRole('button', { name: 'Buy KSTL', exact: true }).boundingBox();
          const card = await panel().locator('[data-workspace-section="trade"]').boundingBox();
          assert.ok(action.y >= card.y && action.y + action.height <= card.y + card.height, 'Default compact desktop Buy must fit its card');
        }
        await capture(`workspace-${width}-${theme}`);
      }
    }
    await page.emulateMedia({ contrast: 'more' }); await capture('increased-contrast');
    await page.emulateMedia({ contrast: 'no-preference' });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await capture('reduced-transparency');
  });
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(`${out}/browser-results.json`, JSON.stringify({ passed: results, errors }, null, 2));
  await browser.close();
}
