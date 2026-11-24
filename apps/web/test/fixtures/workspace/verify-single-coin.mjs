import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const output = process.env.TRADING_EVIDENCE_DIR;
assert.ok(output && process.env.TRADING_CDP_URL);
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page = browser.contexts()[0].pages().find(p => p.url().includes('/trading-proof'));
assert.ok(page && new URL(page.url()).hostname === '127.0.0.1');
page.setDefaultTimeout(10000);
const results = [];
const card = () => page.locator('[data-panel-id="A"]');
const state = () => page.evaluate(() => window.tradingFixture.store.getSnapshot());
const blur = () => page.evaluate(() => document.activeElement?.blur());
const wait = () => page.waitForTimeout(200);
async function press(key) { await blur(); await page.keyboard.press(key); await wait(); }
const order = () => card().locator('[data-workspace-section]').evaluateAll(es => es.map(e => e.dataset.workspaceSection));
try {
 await page.setViewportSize({width:1414,height:900});
 await page.emulateMedia({reducedMotion:'reduce',contrast:'more'});
 const cdp = await page.context().newCDPSession(page);
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 if (await page.getByRole('dialog').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
 // Seed using the public fixture control, then open the real production workspace.
 if (await page.locator('[data-panel-id]').count()) await press('Escape');
 await Promise.all([page.waitForEvent('domcontentloaded',{timeout:30000}), page.locator('#trading-seed').click()]); await page.waitForTimeout(600);
 await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
 if (!(await page.locator('[data-workspace-host]').count())) await page.locator('#trading-open').click();
 await page.waitForFunction(() => !!window.tradingFixture);
 await page.evaluate(() => { window.tradingFixture.state('A','ready'); window.tradingFixture.state('B','ready'); window.tradingFixture.store.setDataCollapsed(false); });
 await page.waitForTimeout(800);
 assert.equal(await page.locator('[data-focus-hidden="false"]').count(),1);
 assert.equal(await page.getByRole('button',{name:'Compare',exact:true}).count(),0);
 const before = await state();
 await press('e');
 assert.equal((await state()).panels.A.coin.trade.side,'sell');
 assert.equal(await page.locator('[data-side="sell"]:focus').count(),1);
 await card().locator('[data-panel-amount]').fill('25');
 await page.keyboard.press('q');
 assert.equal((await state()).panels.A.coin.trade.side,'sell','typing cannot change trade side');
 const typed = await state();
 await press('q');
 assert.equal((await state()).panels.A.coin.trade.side,'buy');
 await card().locator('[data-panel-amount]').fill('100');
 await page.waitForTimeout(800);
 await card().locator('[data-panel-amount]').press('Shift+Space');
 await page.getByRole('dialog').waitFor();
 assert.match(await page.getByRole('dialog').innerText(),/Confirm|Review|Buy/);
 await page.screenshot({path:output+'/keyboard-review.png',animations:'disabled'});
 await page.keyboard.press('Escape'); await wait();
 const inspector = card().locator('[data-inspect-value]').first();
 await inspector.click(); await page.getByRole('dialog').waitFor();
 await page.keyboard.press('e'); await page.keyboard.press(']');
 assert.equal((await state()).panels.A.coin.trade.side,'buy');
 assert.equal((await state()).focused_panel_id,'A');
 assert.ok(await page.getByRole('dialog').isVisible());
 await page.keyboard.press('Escape'); await wait();
 await press(']'); assert.equal((await state()).focused_panel_id,'B');
 await press('['); assert.equal((await state()).focused_panel_id,'A');
 assert.deepEqual((await state()).panels.A.coin.trade.sell,typed.panels.A.coin.trade.sell);
 await press('?'); await page.getByRole('heading',{name:'Keyboard shortcuts'}).waitFor();
 await page.keyboard.press('Escape'); await wait();
 results.push('Buy/Sell shortcuts, editable exclusion, Shift+Space review, inspector exclusion, coin navigation, help');

 await page.getByRole('button',{name:'Edit layout',exact:true}).click(); await wait();
 assert.equal(await page.evaluate(() => document.activeElement?.textContent),'Cancel');
 const input = await card().locator('[data-panel-amount]').elementHandle();
 await card().getByRole('button',{name:'Move Trade',exact:true}).dragTo(card().locator('[data-workspace-section="chart"]'));
 assert.deepEqual(await order(),['trade','chart','activity','details']);
 assert.ok(await input.evaluate(e => e.isConnected),'drag preserves live trade input');
 await card().getByRole('button',{name:'Move Trade',exact:true}).press('ArrowRight');
 assert.deepEqual(await order(),['chart','trade','activity','details']);
 await card().getByRole('button',{name:'Move Trade earlier',exact:true}).click();
 await card().getByRole('button',{name:'Hide Market details',exact:true}).click();
 await card().getByRole('slider',{name:'Left column width'}).fill('55');
 assert.equal((await state()).layout,undefined,'draft layout remains private');
 await page.screenshot({path:output+'/edit-layout.png',animations:'disabled'});
 await page.getByRole('button',{name:'Done',exact:true}).click(); await wait();
 const saved = (await state()).layout;
 assert.deepEqual(saved,{order:['trade','chart','activity','details'],hidden:['details'],split:55});
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 await card().getByRole('button',{name:'Reset layout',exact:true}).click();
 await page.keyboard.press('Escape'); await wait();
 assert.deepEqual((await state()).layout,saved,'Escape cancels layout edits');
 await page.reload(); await page.waitForTimeout(1000);
 await page.waitForFunction(() => typeof document.getElementById('trading-open')?.onclick === 'function');
 if (!(await page.locator('[data-workspace-host]').count())) await page.locator('#trading-open').click();
 await page.waitForFunction(() => !!window.tradingFixture);
 assert.deepEqual((await state()).layout,saved,'layout survives reload');
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();
 await card().getByRole('button',{name:'Reset layout',exact:true}).click();
 await page.getByRole('button',{name:'Done',exact:true}).click();
 results.push('Drag, keyboard reorder, stable draft DOM, hide, column ratio, save, cancel, reload, reset');

 // Stable chart and trade placement when asynchronous reads change.
 const geometry=[];
 for (const scenario of ['ready','loading','empty','unavailable','error','stale','zero','wallet-error','quote-error','quote-loading','native-ready']) {
  await page.evaluate(s => window.tradingFixture.state('A',s),scenario); await page.waitForTimeout(650);
  geometry.push({scenario,...await card().evaluate(e => {const chart=e.querySelector('[data-workspace-section="chart"]').getBoundingClientRect();const trade=e.querySelector('[data-workspace-section="trade"]').getBoundingClientRect();return {chartHeight:chart.height,tradeY:trade.y};})});
 }
 assert.ok(geometry.every(g=>g.chartHeight===geometry[0].chartHeight&&g.tradeY===geometry[0].tradeY));
 await page.evaluate(() => window.tradingFixture.state('A','ready')); await page.waitForTimeout(800);
 const sizes=[];
 for (const width of [320,407,768,1054,1414,1920]) {
  await page.setViewportSize({width,height:900});
  await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1024,maxTouchPoints:1});
  await page.waitForFunction(() => !!window.tradingFixture);
  await page.evaluate(w => window.tradingFixture.store.setDataCollapsed(w<1024),width); await wait();
  assert.equal((await state()).focused_panel_id,(await state()).mobile_panel_id);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow,false,`document overflow at ${width}`);
  const active = await card().locator('[data-coin-submit]').boundingBox();
  await card().locator('[data-coin-submit]').scrollIntoViewIfNeeded();
  const hit = await card().locator('[data-coin-submit]').evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});
  assert.ok(hit,`trade CTA reachable at ${width}`);
  if(width<1024) assert.ok(active.height>=44);
  await page.getByRole('button',{name:'Edit layout',exact:true}).click();
  const controls=card().getByRole('button',{name:'Move Market details earlier',exact:true});
  await controls.scrollIntoViewIfNeeded();
  if(width<1024){const box=await controls.boundingBox();assert.ok(box.width>=44&&box.height>=44);}
  if(width===320) await page.screenshot({path:output+'/edit-mobile.png',animations:'disabled'});
  await controls.click();
  assert.deepEqual(await order(),['chart','trade','details','activity']);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  if(width===320) {
   await page.getByRole('button',{name:'Keyboard shortcuts',exact:true}).click();
   await page.waitForFunction(() => { const keys=[...document.querySelectorAll('[role=dialog] kbd')]; return keys.length>0&&keys.every(e=>getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0); });
   await page.screenshot({path:output+'/mobile-shortcuts.png',animations:'disabled'});
   await page.keyboard.press('Escape'); await wait();
  }
  if(width===407) {
   await card().locator('[data-coin-submit]').scrollIntoViewIfNeeded();
   await page.screenshot({path:output+'/light-mobile.png',animations:'disabled'});
  }
  sizes.push({width,overflow,ctaHeight:active.height});
 }
 await page.emulateMedia({reducedMotion:'reduce',contrast:'no-preference'});
 await page.setViewportSize({width:1414,height:900}); await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 await page.evaluate(() => { window.tradingFixture.store.setDataCollapsed(false); document.querySelectorAll('*').forEach(e=>{if(e.scrollTop)e.scrollTop=0;}); });
 await wait();
 for(const theme of ['light','dark']) {
  await page.evaluate(t => document.querySelector('[data-blast-ui]').setAttribute('data-theme',t),theme); await wait();
  await blur(); await page.screenshot({path:output+`/${theme}-desktop.png`,animations:'disabled'});
 }
 const logos = await page.locator('[data-panel-chip] img, [data-panel-id] img').evaluateAll(es=>es.map(e=>({loaded:e.complete&&e.naturalWidth>0,src:e.getAttribute('src')})));
 assert.ok(logos.length&&logos.every(e=>e.loaded));
 assert.equal(await page.locator('nextjs-portal').evaluateAll(es=>es.some(e=>e.shadowRoot?.querySelector('[data-nextjs-dialog-overlay]'))),false);
 writeFileSync(output+'/verification.json',JSON.stringify({results,geometry,sizes,logos,initialCoins:Object.keys(before.panels)},null,2));
 console.log('PASS: single-coin workspace, movable saved layout, keyboard trading guards, chart states, six widths and light/dark captures');
} finally { await browser.close(); }
