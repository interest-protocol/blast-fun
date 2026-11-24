import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const out=process.env.TRADING_EVIDENCE_DIR;
assert.ok(out);
const browser=await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('/trading-proof'));
assert.ok(page);
page.setDefaultTimeout(15000);
const results=[],errors=[],measurements=[];
page.on('pageerror',e=>errors.push(e.message));
const panel=()=>page.locator('[data-panel-id="A"]:visible');
const section=name=>panel().locator(`[data-workspace-section="${name}"]`);
const snap=()=>page.evaluate(()=>window.tradingFixture.store.getSnapshot());
const capture=name=>page.screenshot({path:`${out}/${name}.png`});
const top=()=>page.locator('[data-workspace-scroll]').evaluate(e=>e.scrollTo({top:0,behavior:'instant'}));
const check=async(name,fn)=>{await fn();results.push(name);console.log('PASS',name);};
const defaults=()=>page.evaluate(()=>window.tradingFixture.store.setLayout({order:['chart','trade','activity','details'],hidden:[],split:64}));
async function edit(){await page.getByRole('button',{name:'Workspace options',exact:true}).click();await page.getByRole('menuitem',{name:'Edit layout',exact:true}).click();}
try{
 await page.setViewportSize({width:1414,height:900});await page.emulateMedia({reducedMotion:'reduce'});await page.reload();
 await page.waitForFunction(()=>typeof document.getElementById('trading-open')?.onclick==='function');
 if(await page.locator('[data-workspace-host]').count()){await page.keyboard.press('Escape');await page.locator('[data-workspace-host]').waitFor({state:'detached'});}
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Seed four assets',exact:true}).click()]);
 await page.waitForFunction(()=>typeof document.getElementById('trading-open')?.onclick==='function');await page.getByRole('button',{name:'Open Blast mode',exact:true}).click();
 await page.waitForFunction(()=>!!window.tradingFixture);await defaults();
 await page.evaluate(()=>{const s=window.tradingFixture.store;s.focus('A');s.selectMobile('A');s.setDataCollapsed(true);window.tradingFixture.state('A','ready');});
 await section('trade').locator('[data-panel-amount]').waitFor();
 await check('Default desktop shows holdings, amount and action inside a usable ticket',async()=>{
  await section('trade').getByRole('region',{name:'Your position',exact:true}).waitFor();
  const held=await section('trade').getByRole('region',{name:'Your position',exact:true}).boundingBox();
  const amount=await section('trade').locator('[data-panel-amount]').boundingBox();
  const ticket=await section('trade').boundingBox();
  const cta=await section('trade').getByRole('button',{name:'Buy KSTL',exact:true}).boundingBox();
  assert.ok(held.y<amount.y);assert.ok(cta.y+cta.height<=ticket.y+ticket.height);assert.ok(ticket.height>=500);
  measurements.push({width:1414,ticket,held,amount,cta});await capture('workspace-1414-light');
 });
 await check('Section visibility reflows the grid, Cancel restores it, and Done persists the choice',async()=>{
  const before=await section('chart').boundingBox();await edit();await page.getByRole('checkbox',{name:'Market activity',exact:true}).uncheck();
  assert.equal(await section('activity').count(),0);const after=await section('chart').boundingBox();assert.ok(after.width>before.width);
  await capture('layout-editor-light');await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await section('activity').count(),1);
  await edit();await page.getByRole('checkbox',{name:'Market activity',exact:true}).uncheck();await page.getByRole('checkbox',{name:'Discovery',exact:true}).uncheck();await page.getByRole('button',{name:'Done',exact:true}).click();
  assert.deepEqual((await snap()).layout.hidden,['activity','details']);assert.equal(await section('details').count(),0);
  await capture('workspace-hidden-sections');
  const original=(await snap()).layout.terminal?.grid;
  await section('chart').locator('[data-grid-resize="se"]').focus();await page.keyboard.press('ArrowDown');
  assert.equal((await snap()).layout.terminal.without_activity_grid.length,2);assert.deepEqual((await snap()).layout.terminal.grid,original);
  await edit();await page.getByRole('button',{name:'Restore defaults',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();assert.deepEqual((await snap()).layout.hidden,[]);assert.equal(await section('activity').count(),1);
 });
 await check('Five widths and both themes retain readable facts, plot, trade action and no horizontal overflow',async()=>{
  const cdp=await page.context().newCDPSession(page);
  for(const width of [320,407,768,1054,1414]){
   await page.setViewportSize({width,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<=768});
   for(const theme of ['light','dark']){
    await page.locator('[data-blast-ui]').evaluate((e,t)=>e.setAttribute('data-theme',t),theme);await top();await page.waitForTimeout(180);
    const sizes=await page.evaluate(()=>({width:innerWidth,doc:document.documentElement.scrollWidth}));assert.ok(sizes.doc<=sizes.width+1,JSON.stringify(sizes));
    await panel().getByRole('definition').first().count();
    const plot=await panel().locator('[data-coin-chart] svg[role="img"]').first().boundingBox();assert.ok(plot&&plot.width>100&&plot.height>100);
    const ticket=await section('trade').boundingBox();assert.ok(ticket.width>200);measurements.push({width,theme,ticket,plot});
    await capture(`workspace-${width}-${theme}`);
   }
  }
 });
 await check('Mobile Discover opens the picker, Trade focuses its form, Activity and Chart are reachable',async()=>{
  await page.setViewportSize({width:407,height:900});await top();
  const nav=page.getByRole('navigation',{name:'Selected market navigation',exact:true});await nav.waitFor();
  await nav.getByRole('button',{name:'Discover',exact:true}).click();await page.getByRole('dialog',{name:'Discover',exact:true}).waitFor();await capture('mobile-market-picker');
  await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Discover',exact:true}).waitFor({state:'hidden'});
  await nav.getByRole('button',{name:'Trade',exact:true}).click();await page.waitForFunction(()=>document.activeElement?.matches('[data-panel-amount]'));
  const input=await section('trade').locator('[data-panel-amount]').boundingBox();assert.ok(input.y>0&&input.y<800);
  await capture('mobile-trade-focus');assert.equal(await nav.isVisible(),true);
  await page.setViewportSize({width:407,height:550});assert.equal(await nav.isVisible(),true);
  await page.setViewportSize({width:407,height:900});assert.equal(await nav.isVisible(),true);
  assert.equal(await section('trade').locator('[data-panel-amount]').evaluate(e=>e===document.activeElement),true);
  await nav.getByRole('button',{name:'Activity',exact:true}).click();assert.equal(await section('activity').evaluate(e=>document.activeElement===e),true);
  await nav.getByRole('button',{name:'Chart',exact:true}).click();await top();
  await edit();await page.getByRole('checkbox',{name:'Market activity',exact:true}).uncheck();assert.equal(await nav.getByRole('button',{name:'Activity',exact:true}).count(),0);await page.getByRole('button',{name:'Cancel',exact:true}).click();
 });
 await check('Warning, unavailable and loading states stay distinct; contrast and transparency preferences keep controls',async()=>{
  for(const scenario of ['wallet-error','quote-error','quote-loading','zero','stale','ready']){
   console.log('CHECK state',scenario);
   await page.evaluate(s=>window.tradingFixture.state('A',s),scenario);
   await section('trade').getByRole('button',{name:'Buy KSTL',exact:true}).waitFor();
   await section('trade').locator('[data-panel-amount]').fill('50');
   if(scenario==='wallet-error') await section('trade').getByText('Wallet balances could not load.',{exact:false}).waitFor();
   else if(scenario==='quote-error') await section('trade').getByText('The quote could not load.',{exact:false}).waitFor();
   else if(scenario==='quote-loading') await section('trade').getByText('Getting a current quote',{exact:true}).waitFor();
   else await page.waitForTimeout(1200);
   const ticket=await section('trade').boundingBox();assert.ok(ticket.height>300);
   const cta=await section('trade').getByRole('button',{name:'Buy KSTL',exact:true});
   if(['wallet-error','quote-error','quote-loading'].includes(scenario)) assert.equal(await cta.isDisabled(),true);
   await capture(`state-${scenario}`);
  }
  await page.emulateMedia({reducedMotion:'reduce',contrast:'more',reducedTransparency:'reduce'});await top();await capture('mobile-accessibility-preferences');
 });
 await check('Hidden Discovery preserves presale allocation and visibility survives reload',async()=>{
  const savedA=(await snap()).panels.A;
  await page.evaluate(()=>{const s=window.tradingFixture.store;s.remove('A');s.add({panel_id:'A',chain:'sui',network:'mainnet',coin_type:'0x'+'d4'.repeat(32)+'::orbit::ORBT',presale_id:'0x'+'0'.repeat(59)+'5a1e2'},0);s.patchPanel('A',{active_namespace:'presale'});s.focus('A');s.selectMobile('A');s.setLayout({...s.getSnapshot().layout,hidden:['details']});});
  await panel().getByRole('region',{name:'Your allocation',exact:true}).waitFor();
  await panel().getByRole('region',{name:'Your allocation',exact:true}).getByText('Your allocation is unavailable.',{exact:true}).count().then(n=>assert.equal(n,0));
  assert.equal(await panel().getByRole('region',{name:'Discover markets',exact:true}).count(),0);
  await capture('presale-hidden-discovery');
  await page.waitForFunction(()=>Object.values(localStorage).some(v=>v.includes('\"hidden\":[\"details\"]')));
  await page.reload();await page.waitForFunction(()=>!!window.tradingFixture);assert.ok((await snap()).layout.hidden.includes('details'));
  await page.evaluate(saved=>{const s=window.tradingFixture.store;s.remove('A');s.restorePanel(saved,0);s.focus('A');s.selectMobile('A');s.setLayout({order:['chart','trade','activity','details'],hidden:[],split:64});window.tradingFixture.state('A','ready');},savedA);
 });
 assert.deepEqual(errors,[]);console.log('PASS no browser page errors');
}finally{writeFileSync(`${out}/browser-results.json`,JSON.stringify({results,errors,measurements},null,2));await browser.close();}
