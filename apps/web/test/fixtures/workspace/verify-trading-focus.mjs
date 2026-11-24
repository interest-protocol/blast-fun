import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

// Continue the main fixture regression in the same task-owned browser.
const output = process.env.TRADING_EVIDENCE_DIR;
assert.ok(output && process.env.TRADING_CDP_URL);
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page = browser.contexts()[0].pages()[0];
assert.equal(new URL(page.url()).hostname, '127.0.0.1');
assert.equal(new URL(page.url()).pathname, '/trading-proof');
page.setDefaultTimeout(15000);
try {
 await page.setViewportSize({width:1414,height:900});const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 await page.emulateMedia({reducedMotion:'reduce',contrast:'more'});
 await page.evaluate(()=>{const s=window.tradingFixture.store;s.setPresentation('focus');s.setDataCollapsed(false);s.focus('A');window.tradingFixture.state('A','ready');});
 const card=page.locator('[data-panel-id="A"]');
 await page.waitForTimeout(800);
 await card.getByRole('button',{name:'Buy',exact:true}).click();
 await card.locator('[data-panel-amount]').fill('100');await page.waitForTimeout(800);
 const measure=()=>card.evaluate(e=>{const outer=e.getBoundingClientRect(); const rect=s=>{const r=e.querySelector(s).getBoundingClientRect();return {x:r.x-outer.x,y:r.y-outer.y,width:r.width,height:r.height};};return {chart:rect('[data-chart-frame]'),trade:rect('[aria-label="Buy or sell selected asset"]'),side:rect('[aria-label="Buy or sell"]'),amount:rect('[data-panel-amount]'),action:rect('[data-coin-submit]'),activity:rect('[aria-label="Asset participation"]'),details:rect('[aria-label="Market details"]')};});
 const measurements=[];
 for(const scenario of ['ready','loading','empty','unavailable','error','stale','zero','wallet-error','quote-loading','quote-error','native-ready','native-empty','native-unavailable','native-stale']) {
  await page.evaluate(s=>window.tradingFixture.state('A',s),scenario);await page.waitForTimeout(800);
  if(scenario === 'quote-error') await card.getByText('The quote could not load.',{exact:false}).waitFor({state:'visible'});
  const geometry=await measure();
  if(measurements.length) for(const [section,rect] of Object.entries(geometry))for(const [key,val]of Object.entries(rect)) assert.ok(Math.abs(val-measurements[0].geometry[section][key])<1,`${scenario} ${section}.${key}`);
  measurements.push({scenario,geometry});
 }
 await page.evaluate(()=>window.tradingFixture.state('A','zero'));await page.waitForTimeout(500);
 await card.getByRole('button',{name:'Sell',exact:true}).click();
 await card.getByRole('button',{name:'My position',exact:true}).click();await page.waitForTimeout(500);
 assert.match(await card.getByRole('group',{name:'Available trade balance'}).innerText(),/0 KSTL/);
 assert.equal(await card.getByRole('button',{name:/Inspect full exact asset balance/}).innerText(),'0');
 await page.screenshot({path:output+'/after-focus-zero.png',animations:'disabled'});
 await page.evaluate(()=>window.tradingFixture.state('A','unavailable'));await page.waitForTimeout(500);
 await card.getByText('Balance unavailable',{exact:true}).waitFor({state:'visible'});assert.match(await card.getByRole('group',{name:'Available trade balance'}).innerText(),/unavailable/i);
 assert.match(await card.getByRole('region',{name:'Asset participation'}).innerText(),/balance is unavailable/i);
 await page.evaluate(()=>window.tradingFixture.state('A','ready'));await page.waitForTimeout(500);
 await card.getByRole('button',{name:'Buy',exact:true}).click();await card.locator('[data-panel-amount]').fill('700');await page.waitForTimeout(500);
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 const mobile=[];
 for(const width of [320,407,768]) {
  await page.setViewportSize({width,height:900});
  for(const presentation of ['compare','focus']){
   await page.evaluate(p=>{const s=window.tradingFixture.store;s.setPresentation(p);s.setDataCollapsed(true);},presentation);await page.waitForTimeout(500);
   await card.locator('[data-coin-submit]').scrollIntoViewIfNeeded();await page.waitForTimeout(250);
   const hit=await card.locator('[data-coin-submit]').evaluate(e=>{const r=e.getBoundingClientRect();return {rect:r.toJSON(),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});
   assert.equal(hit.hit,true,`reachable ${width} ${presentation}`);assert.ok(hit.rect.height>=44);assert.ok(hit.rect.y >= 0 && hit.rect.bottom <= 830, 'full action above bottom navigation');
   const impact=card.getByText('High price impact:',{exact:false});await impact.waitFor({state:'visible'});
   const visibility=await impact.evaluate(e=>{const r=e.getBoundingClientRect();const parent=e.parentElement.parentElement.getBoundingClientRect();return {height:r.height,top:r.top-parent.top,bottom:parent.bottom-r.bottom};});
   assert.ok(visibility.top>=-1 && visibility.bottom>=-1,`impact ${width} ${presentation} ${JSON.stringify(visibility)}`);
   await page.screenshot({path:output+`/after-${presentation}-${width}-trade-visible.png`,animations:'disabled'});
   mobile.push({width,presentation,...hit,impact:visibility});
  }
 }
 writeFileSync(output+'/focus-geometry.json',JSON.stringify({measurements,mobile},null,2));
 console.log('PASS: Focus state geometry, zero/unknown balance agreement, reachable mobile actions and visible material impact');
} finally { await browser.close(); }
