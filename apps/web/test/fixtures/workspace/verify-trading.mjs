import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Reuse the task's one browser. Run against /trading-proof, never a live trading route.
const base = process.env.TRADING_FIXTURE_URL ?? 'http://127.0.0.1:42874/trading-proof';
assert.equal(new URL(base).hostname, '127.0.0.1');
const output = process.env.TRADING_EVIDENCE_DIR;
assert.ok(output && process.env.TRADING_CDP_URL);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL,{noDefaults:true});
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
page.setDefaultTimeout(15000);
const results = { viewports: [], states: [], interactions: [] };
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const settle = () => page.waitForTimeout(350);
const state = async scenario => {
  await page.evaluate(s => window.tradingFixture.state('A', s), scenario);
  // Include the production quote debounce, not just the first pending render.
  await page.waitForTimeout(800);
  if(scenario === 'quote-error' || scenario === 'quote-no-route') await card().getByRole('alert').filter({hasText:scenario === 'quote-error' ? 'Quote unavailable' : 'No route available'}).waitFor({state:'visible'});
};
const card = () => page.locator('[data-panel-id="A"]');
async function measure() {
  return card().evaluate(e => {
    const outer = e.getBoundingClientRect();
    const rect = node => { if(!node) return null; const r = node.getBoundingClientRect(); return { x:r.x-outer.x,y:r.y-outer.y,width:r.width,height:r.height }; };
    return { viewport:{width:innerWidth,font:Number.parseFloat(getComputedStyle(document.documentElement).fontSize)},card: {width:outer.width,height:outer.height}, header:rect(e.querySelector('header')),chart:rect(e.querySelector('[data-chart-frame]')), side:rect(e.querySelector('[aria-label="Buy or sell selected asset"]')),amount:rect(e.querySelector('[data-panel-amount]')), presets:rect(e.querySelector('[aria-label="Buy amount presets"],[aria-label="Share of available token balance"]')),action:rect(e.querySelector('[data-coin-submit]')) };
  });
}
function sameGeometry(before, after, label) {
  for (const [section, rect] of Object.entries(before)) for(const [key,value] of Object.entries(rect ?? {})) assert.ok(Math.abs(value-after[section][key]) < 1, `${label}: ${section}.${key} moved from ${value} to ${after[section][key]}`);
}
async function save(name) { await page.waitForTimeout(450); await page.screenshot({ animations:'allow', path:`${output}/${name}.png` }); }
try {
  await page.setViewportSize({width:1920,height:1080});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(base,{waitUntil:'domcontentloaded',timeout:60000});
  await page.locator('#trading-seed').waitFor({state:'visible'});
  await page.waitForFunction(()=>!!window.holderFixture);
  // Seed is test setup, including when a restored workspace covers the fixture controls.
  await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#trading-seed').evaluate(button=>button.click())]);
  await page.waitForFunction(()=>!!window.holderFixture);
  if(!await page.locator('[data-workspace-host]').count()) await page.locator('#trading-open').click();
  await page.waitForFunction(()=>!!window.tradingFixture);
  await page.evaluate(()=>document.fonts.ready);
  const records = await page.evaluate(()=>Object.values(window.tradingFixture.store.getSnapshot().panels));
  assert.equal(records.length,4,'Fixture seeded four assets');
  async function configure(count=4,collapsed=false,presentation='focus') {
    await page.evaluate(({records,count,collapsed,presentation})=>{
      const s=window.tradingFixture.store;s.setCapacity(count);
      for(let i=0;i<count;i++) s.add(records[i],i);
      s.focus('A');s.selectMobile('A');s.setDataCollapsed(collapsed);s.setPresentation(presentation);
    },{records,count,collapsed,presentation});await settle();
  }
  await configure();
  await page.locator('#workspace-data-panel [aria-label="KSTL details"]').waitFor({state:'visible',timeout:30000});
  await card().locator('[data-chart-frame]').waitFor({state:'visible'});
  await card().locator('[data-panel-amount]').fill('100');await settle();
  for(const scenario of ['ready','empty','loading','unavailable','error','stale','zero','wallet-error','quote-loading','quote-error','quote-no-route']) {
    await state(scenario);
    const geometry=await measure();
    if(results.states.length) sameGeometry(results.states[0].geometry,geometry,scenario);
    results.states.push({scenario,geometry,feedback:await card().locator('[data-trade-feedback]').innerText()});
  }
  await state('zero');await card().getByRole('button',{name:'Sell',exact:true}).click();await settle();
  assert.equal(await card().getByRole('button',{name:'50%',exact:true}).isDisabled(),true);
  assert.equal((await card().locator('[data-trade-feedback]').innerText()).trim(),'No KSTL available to sell.');
  const sellGeometry=await measure();
  // Switching side deliberately changes the currency prefix and the independently saved input.
  sameGeometry({...results.states[0].geometry,amount:null},{...sellGeometry,amount:null},'zero Sell');
  assert.equal(sellGeometry.amount.y,results.states[0].geometry.amount.y,'side switch keeps the amount baseline');
  await save('after-four-mixed-light-1920');
  await card().getByRole('button',{name:'Buy',exact:true}).click();await card().locator('[data-panel-amount]').fill('100');
  for(const scenario of ['native-ready','native-empty','native-unavailable','native-stale']) {
    await state(scenario);const geometry=await measure();sameGeometry(results.states[0].geometry,geometry,scenario);results.states.push({scenario,geometry});
  }
  await state('ready');await card().getByRole('button',{name:'Buy',exact:true}).click();await settle();
  await card().locator('[data-panel-amount]').fill('100');await settle();
  assert.equal(await card().locator('[data-coin-submit]').isEnabled(),true,'fixture funded quote enables action');
  const plot = card().getByRole('group',{name:'Inspect price history',exact:true});
  await plot.click();assert.equal(await page.getByRole('button',{name:'Collapse discovery',exact:true}).isVisible(),true);
  await plot.press('ArrowRight');await plot.press('Escape');assert.equal(await page.locator('[data-workspace-panels]').count(),1);
  await card().locator('[data-panel-amount]').press('b');assert.equal(await page.locator('[data-workspace-panels]').count(),1);
  await card().locator('[data-panel-amount]').fill('100');await settle();
  await card().getByRole('button',{name:'Trade details',exact:true}).click();await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog',{name:'Trade details',exact:true}).count(),0);
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label') === 'Trade details');
  assert.equal(await card().getByRole('button',{name:'Trade details',exact:true}).evaluate(e=>document.activeElement===e),true);
  results.interactions.push('zero presets, funded quote, chart inspection Escape, editable B, details focus return');
  await save('after-four-ready-light-1920');
  for(const count of [1,2,3,4]) {
    await configure(count,false);const boxes=await page.locator('[data-panel-id]').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0).map(e=>e.getBoundingClientRect().toJSON()));
    assert.equal(boxes.length,1,'saved assets share the current focus board');assert.equal(await page.evaluate(()=>window.tradingFixture.store.getSnapshot().visible_order.length),count);results.interactions.push({count,boxes});
  }
  const cdp=await page.context().newCDPSession(page);
  for(const [width,height] of [[320,900],[407,900],[768,1024],[1054,900],[1076,900],[1230,593],[1414,900],[1920,1080]]) {
    await page.setViewportSize({width,height});
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1024,maxTouchPoints:1});
    for(const theme of ['light','dark']) {
      await page.evaluate(t=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',t),theme);
      await configure(4,width<1100);await state('ready');
      await card().scrollIntoViewIfNeeded();await settle();
      const dimensions=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,coarse:matchMedia('(pointer:coarse)').matches}));
      assert.ok(dimensions.scrollWidth<=width,`overflow ${width} ${theme}`);
      const box=await measure();assert.ok(box.chart.height>=80,`chart usable ${width}`);
      const compactNav=page.getByRole('navigation',{name:'Selected market navigation',exact:true});
      if(await compactNav.isVisible()) {
        await compactNav.getByRole('button',{name:'Trade',exact:true}).click();await settle();
        const tradeBox=await measure();
        assert.ok(tradeBox.action.height >= (dimensions.coarse ? 44 : 32));
        assert.ok(await card().locator('[data-panel-amount]').isVisible(),'compact Trade view is reachable');
        await save(`after-trade-${width}-${theme}`);
        await state('quote-no-route');
        const failedBox=await measure();sameGeometry(tradeBox,failedBox,`compact quote refusal ${width}`);
        const quote=card().getByRole('alert').filter({hasText:'No route available'});
        assert.ok(await quote.evaluate(e=>e.scrollWidth<=e.clientWidth),'quote refusal fits its row');
        await save(`after-trade-refusal-${width}-${theme}`);
        await state('ready');
        await compactNav.getByRole('button',{name:'Chart',exact:true}).click();await settle();
      } else assert.ok(box.action.height >= (dimensions.coarse ? 44 : 32));
      // Desktop focus view lists only the other open coins; the current one (A) is the card itself.
      const nav=await page.locator(`nav[aria-label="Workspace panels"] [data-panel-chip="${width<1100?'A':'B'}"] [aria-hidden="true"]`).first().isVisible();assert.ok(nav,'coin logo visible in asset switcher');
      await save(`after-saved-${width}-${theme}`);
      results.viewports.push({width,height,theme,...dimensions,geometry:box});
      await configure(4,width<1100,'focus');await settle();
      assert.ok(await card().getByRole('region',{name:'Price chart'}).isVisible());
      await save(`after-focus-${width}-${theme}`);
    }
    console.log(`Verified ${width}×${height}, both themes`);
  }
  await page.setViewportSize({width:1414,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
  await page.evaluate(()=>document.querySelector('[data-blast-ui]').setAttribute('data-theme','light'));
  await configure(2,true);
  const savedLayout=await page.evaluate(()=>window.tradingFixture.store.getSnapshot().layout ?? {order:['chart','trade','activity','details'],hidden:[],split:64});
  const holdersShown=shown=>page.evaluate(({layout,shown})=>window.tradingFixture.store.setLayout({...layout,hidden:shown?layout.hidden.filter(s=>s!=='activity'):[...layout.hidden.filter(s=>s!=='activity'),'activity']}),{layout:savedLayout,shown});
  const motionBox=()=>card().locator('[data-board] > div').first().evaluate(node=>({rows:getComputedStyle(node).gridTemplateRows,duration:getComputedStyle(node).transitionDuration,height:node.getBoundingClientRect().height,chartHeight:node.querySelector('[data-workspace-section="chart"]').getBoundingClientRect().height,holdersHeight:node.querySelector('[data-workspace-section="activity"]').getBoundingClientRect().height,inert:node.querySelector('[data-workspace-section="activity"]').inert}));
  await holdersShown(true);await settle();
  await page.emulateMedia({reducedMotion:'no-preference'});
  const motion={normal:[],interrupted:[],reduced:[]};
  motion.normal.push(await motionBox());await holdersShown(false);
  for(const delay of [40,60,160]) {await page.waitForTimeout(delay);motion.normal.push(await motionBox());}
  assert.equal(motion.normal.at(-1).inert,true);assert.ok(motion.normal.at(-1).holdersHeight<1);
  await holdersShown(true);await page.waitForTimeout(70);motion.interrupted.push(await motionBox());
  await holdersShown(false);await page.waitForTimeout(70);motion.interrupted.push(await motionBox());
  await holdersShown(true);await settle();motion.interrupted.push(await motionBox());
  assert.ok(motion.interrupted.at(-1).holdersHeight>100);assert.equal(motion.interrupted.at(-1).inert,false);
  await page.emulateMedia({reducedMotion:'reduce'});await holdersShown(false);await page.waitForTimeout(40);motion.reduced.push(await motionBox());
  assert.equal(motion.reduced[0].duration,'0s');assert.ok(motion.reduced[0].holdersHeight<1);
  await page.evaluate(layout=>window.tradingFixture.store.setLayout(layout),savedLayout);await settle();
  results.interactions.push({holdersMotion:motion});
  await configure(2,false);const expanded=await measure();await page.getByRole('button',{name:'Collapse discovery',exact:true}).click();await settle();const collapsed=await measure();assert.ok(collapsed.card.width>expanded.card.width+100);await save('after-discovery-collapsed');
  await page.getByRole('button',{name:'Expand discovery',exact:true}).click();await settle();
  const search=page.getByRole('searchbox',{name:'Search coins',exact:true});await search.fill('b');assert.ok(await page.locator('[data-workspace-panels]').count());await search.fill('');
  await card().locator('[data-panel-amount]').fill('25.123');
  await card().getByRole('button',{name:'7D',exact:true}).click();await configure(2,true,'focus');
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.holderFixture);if(!await page.locator('[data-workspace-host]').count())await page.locator('#trading-open').click();await page.waitForFunction(()=>!!window.tradingFixture);
  const saved=await page.evaluate(()=>window.tradingFixture.store.getSnapshot());assert.equal(saved.presentation,'focus');assert.equal(saved.data.collapsed,true);assert.equal(saved.panels.A.coin.trade.buy.typed,'25.123');assert.equal(saved.panels.A.coin.chart.window,'7d');
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('b');await settle();assert.equal(await page.locator('[data-workspace-panels]').count(),0,'B exits Blast mode');await page.locator('#trading-open').click();await page.locator('[data-workspace-panels]').waitFor({state:'attached'});await settle();await page.keyboard.press('Escape');await settle();assert.equal(await page.locator('[data-workspace-panels]').count(),0);await page.locator('#trading-open').click();await page.locator('[data-workspace-panels]').waitFor({state:'attached'});
  results.interactions.push('discovery width recovery, search B, reload draft/range/mode/collapse, B exit, Escape exit and B reentry');
  assert.deepEqual(errors,[],'no runtime errors');
  await writeFile(`${output}/geometry.json`,JSON.stringify(results,null,2));console.log('PASS: trading workspace browser regression');
} finally { await writeFile(`${output}/geometry-progress.json`,JSON.stringify({...results,errors},null,2));await browser.close(); }
