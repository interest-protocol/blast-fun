import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const out = process.env.TRADING_EVIDENCE_DIR;
assert.ok(out);
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page = browser.contexts()[0].pages().find(p => p.url().includes('trading-proof'));
assert.ok(page);
page.setDefaultTimeout(15000);
let scenario = 'ready';
const passed = [], errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
const type = symbol => `0x${'7a3f'.padEnd(60, '0')}c91e::${symbol.toLowerCase()}::${symbol}`;
const holdings = [
  { coin_type: type('KSTL'), symbol: 'KSTL', name: 'Kestrel', decimals: 9, icon_url: null, balance: '600000000000001', value_usd: '1284.12', presale_id: null },
  { coin_type: type('LUMN'), symbol: 'LUMN', name: 'Lumen', decimals: 9, icon_url: null, balance: '2000000000000', value_usd: '84.24', presale_id: null },
  { coin_type: type('ODD'), symbol: 'ODD', name: 'Unknown metadata', decimals: null, icon_url: null, balance: '1', value_usd: null, presale_id: null },
];
const body = () => ({ balances: { sui: { atoms: '0', usd: '0.00' }, usdc: { atoms: '860000000', usd: '860.00' } }, positions: [], commitments: { committed_usd: '0.00', claimable_usd: '0.00' }, coins: holdings.map((coin, i) => ({ ...coin, basis_usd: '1000.00', basis_complete: scenario !== 'unknown' && i !== 2, pnl_usd: i ? '-15.76' : '284.12', pnl_multiple: i ? '0.8424' : '1.2841' })), vesting: { has_schedule: false, href: null }, totals: { people: 0, volume_usd: '0.00' }, trend: null, prices_as_of_ms: Date.now(), unavailable: ['trend'], wallet_sync: { status: scenario === 'stale' ? 'stale' : 'ready', checkpoint: '1', as_of_ms: Date.now() } });
await page.route('**/api/social/me/**', async route => {
  const url = new URL(route.request().url()); requests.push(url.pathname);
  if (url.pathname.endsWith('/settings')) return route.fulfill({ json: {} });
  if (!url.pathname.includes('/portfolio')) return route.continue();
  if (scenario === 'pending') return new Promise(() => {});
  if (scenario === 'error' || (scenario === 'pnl-error' && !url.pathname.endsWith('/coins'))) return route.fulfill({ status: 503, json: {} });
  if (url.pathname.endsWith('/coins')) {
    const rows = scenario === 'empty' ? [] : holdings.filter(c => `${c.symbol} ${c.name}`.toLowerCase().includes((url.searchParams.get('q') ?? '').toLowerCase()));
    return route.fulfill({ json: { coins: rows, page: 1, page_size: 20, total: rows.length } });
  }
  return route.fulfill({ json: body() });
});
const trigger = () => page.getByRole('button', { name: 'Portfolio', exact: true });
const drawer = () => page.getByRole('dialog', { name: 'Portfolio', exact: true });
const panel = () => page.locator('[data-panel-id="A"]:visible');
const snap = () => page.evaluate(() => window.tradingFixture.store.getSnapshot());
const capture = name => page.screenshot({ path: `${out}/${name}.png` });
const check = async (name, run) => { await run(); passed.push(name); console.log('PASS', name); };
async function open() { await trigger().click(); await drawer().waitFor(); }
async function close() { await page.keyboard.press('Escape'); await drawer().waitFor({ state: 'hidden' }); }
try {
  await page.setViewportSize({ width: 1414, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
  if (!(await page.locator('[data-workspace-host]').count())) await page.getByRole('button', { name: 'Open Blast mode', exact: true }).click();
  await page.waitForFunction(() => !!window.tradingFixture);
  await page.evaluate(coin => {
    const s=window.tradingFixture.store;s.setPresentation('focus');s.setCapacity(2);s.setDataCollapsed(true);
    s.add({ panel_id: 'A', coin_type: coin, chain: 'sui', network: 'mainnet', presale_id: null });s.focus('A');
    document.querySelector('[data-blast-ui]').setAttribute('data-theme', 'light');
  }, type('KSTL'));
  await panel().locator('[data-panel-amount]').fill('12.34');
  await check('Portfolio sits beside Discover and loads exact private holdings, value and signed PnL', async () => {
    await open();
    await drawer().getByRole('button', { name: 'Sell KSTL', exact: true }).waitFor();
    await drawer().getByText(/PnL \+\$284\.12/).waitFor();
    assert.match(await drawer().innerText(), /600,000\.000000001/);
    assert.match(await drawer().innerText(), /PnL −\$15\.76/);
    assert.match(await drawer().innerText(), /No fresh price/);
    assert.equal(await drawer().getByRole('button', { name: 'Sell ODD' }).count(), 0);
    const box=await drawer().boundingBox();assert.ok(box.x > 900 && box.x+box.width <= 1414);
    await capture('portfolio-desktop-light');
    await close();assert.equal(await trigger().evaluate(e=>e===document.activeElement),true);
  });
  await check('Sell and Buy more reuse the canonical panel, preserve separate drafts and focus the trade input', async () => {
    await open();await drawer().getByRole('button', { name: 'Sell KSTL', exact: true }).click();
    await drawer().waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().panels.A.coin.trade.side==='sell');
    await panel().locator('[data-panel-amount]').fill('1.25');
    await open();await drawer().getByRole('button',{name:'Buy more KSTL',exact:true}).click();
    await drawer().waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().panels.A.coin.trade.side==='buy');
    assert.equal(await panel().locator('[data-panel-amount]').inputValue(),'12.34');
    assert.equal((await snap()).panels.A.coin.trade.sell.typed,'1.25');
    assert.equal(await panel().locator('[data-panel-amount]').evaluate(e=>document.activeElement===e),true);
    assert.equal(Object.values((await snap()).panels).filter(p=>p.coin_type===type('KSTL')).length,1);
  });
  await check('Full capacity keeps the displaced market in Saved and focuses the selected trade', async () => {
    await page.evaluate(()=>{const s=window.tradingFixture.store;s.setCapacity(1);s.setDataCollapsed(true)});
    await open();await drawer().getByRole('button',{name:'Buy more LUMN',exact:true}).click();await drawer().waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().panels[window.tradingFixture.store.getSnapshot().focused_panel_id]?.coin_type.endsWith('::LUMN'));
    const s=await snap(),id=s.focused_panel_id;assert.equal(s.panels[id].coin_type,type('LUMN'));assert.equal(s.panels[id].coin.trade.side,'buy');assert.ok(s.retained_order.includes('A'));
    await page.waitForFunction(()=>document.activeElement?.matches('[data-panel-amount]'));
    await open();await drawer().getByRole('button',{name:'Buy more KSTL',exact:true}).click();await drawer().waitFor({state:'hidden'});
    await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().focused_panel_id==='A');
    assert.equal((await snap()).panels.A.coin.trade.buy.typed,'12.34');
    assert.equal((await snap()).panels.A.coin.trade.sell.typed,'1.25');
  });
  await check('Loading, error/retry, successful empty, unknown and stale PnL remain distinct', async () => {
    scenario='error';await open();await drawer().getByRole('button',{name:'Retry coins',exact:true}).waitFor();await capture('portfolio-error');
    scenario='empty';await drawer().getByRole('button',{name:'Retry coins',exact:true}).click();await drawer().getByText('No coins in your linked wallets.',{exact:true}).waitFor();await capture('portfolio-empty');await close();
    scenario='pnl-error';await open();await drawer().getByRole('button',{name:'Retry PnL',exact:true}).waitFor();
    scenario='ready';await drawer().getByRole('button',{name:'Retry PnL',exact:true}).click();await drawer().getByText(/PnL \+\$284\.12/).waitFor();
    const fullReads=requests.filter(path=>path.endsWith('/portfolio')).length;
    await drawer().getByRole('button',{name:'Refresh coins',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh coins"]')?.disabled);
    assert.ok(requests.filter(path=>path.endsWith('/portfolio')).length>fullReads);await close();
    scenario='unknown';await open();await drawer().getByText('PnL unavailable',{exact:true}).first().waitFor();await close();
    scenario='stale';await open();await drawer().getByText('PnL unavailable',{exact:true}).first().waitFor();assert.doesNotMatch(await drawer().innerText(),/PnL \+\$284/);await close();
    scenario='pending';await open();await drawer().getByRole('status',{name:'Loading portfolio coins',exact:true}).waitFor();await capture('portfolio-loading');await close();scenario='ready';
  });
  await check('Drawer and mobile sheet fit five widths in both themes with keyboard focus and no document overflow', async () => {
    const cdp=await page.context().newCDPSession(page);
    for(const width of [320,407,768,1054,1414]) {
      await page.setViewportSize({width,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<=768});
      for(const theme of ['light','dark']) {
        await page.evaluate(t=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',t),theme);
        await open();await drawer().getByRole('button',{name:'Sell KSTL',exact:true}).waitFor();
        const box=await drawer().boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.y>=0,JSON.stringify(box));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        assert.ok(await drawer().evaluate(e=>e.scrollWidth<=e.clientWidth));
        await drawer().getByRole('searchbox',{name:'Search portfolio coins',exact:true}).focus();await page.keyboard.press('Tab');
        assert.equal(await drawer().evaluate(e=>e.contains(document.activeElement)),true);
        await capture(`portfolio-${width}-${theme}`);await close();assert.equal(await trigger().evaluate(e=>e===document.activeElement),true);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        for (const control of [trigger(), page.getByRole('button',{name:'Discover',exact:true}), page.locator('[data-more-panels-trigger]')]) {
          if (!(await control.count())) continue;
          const bounds=await control.boundingBox();
          assert.ok(bounds && bounds.x>=0 && bounds.x+bounds.width<=width+1,JSON.stringify(bounds));
        }
        if (width===407 || width===1414) await capture(`workspace-${width}-${theme}`);
      }
    }
    await page.setViewportSize({width:407,height:900});await open();await drawer().getByRole('button',{name:'Sell KSTL',exact:true}).click();await drawer().waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement?.matches('[data-panel-amount]'));
    assert.equal((await snap()).panels.A.coin.trade.side,'sell');
  });
  await check('Sign-out wipes open private rows without sends or durable financial data', async () => {
    await open();await drawer().getByRole('button',{name:'Sell KSTL',exact:true}).waitFor();
    await page.evaluate(()=>window.holderFixture.setSignedIn(false));await drawer().getByText('Sign in to see your portfolio.',{exact:true}).waitFor();
    assert.doesNotMatch(await drawer().innerText(),/600,000|284\.12|Buy more/);
    assert.doesNotMatch(JSON.stringify(await snap()),/1284\.12|pnl_usd|600000000000001/);
    assert.ok(requests.every(path=>!path.includes('/swap')&&!path.includes('/quote')));
    await close();
  });
  assert.deepEqual(errors,[]);
} finally {
  writeFileSync(`${out}/browser-results.json`,JSON.stringify({passed,errors},null,2));await browser.close();
}
