import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const out=process.env.TRADING_EVIDENCE_DIR;
assert.ok(out && process.env.TRADING_CDP_URL);
const browser=await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page=browser.contexts()[0].pages()[0];
page.setDefaultTimeout(12000);
const evidence={}; const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.waitForTimeout(240);
const card=()=>page.locator('[data-panel-id="A"]');
const section=id=>card().locator(`[data-workspace-section="${id}"]`);
const saved=()=>page.evaluate(()=>window.tradingFixture.store.getSnapshot());
const layout={order:['chart','trade','activity','details'],hidden:[],split:64};
async function ready(){await page.waitForFunction(()=>typeof document.getElementById('trading-open')?.onclick==='function');if(!await page.locator('[data-workspace-host]').count())await page.locator('#trading-open').click();await page.waitForFunction(()=>!!window.tradingFixture);}
async function drag(handle,dx,dy,cancel=false){await handle.scrollIntoViewIfNeeded();const r=await handle.boundingBox();await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2+dx,r.y+r.height/2+dy,{steps:8});if(cancel)await page.keyboard.press('Escape');await page.mouse.up();await settle();}
async function top(){await page.evaluate(()=>{document.activeElement?.blur();document.querySelectorAll('*').forEach(e=>{if(e.scrollTop)e.scrollTop=0;});});await settle();}
async function noOverflow(){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
try {
 await page.bringToFront();await page.setViewportSize({width:1414,height:900});await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto('http://127.0.0.1:42874/trading-proof');await ready();
 // Fixtures share a guest journal; seed the coin scenarios explicitly.
 await page.locator('[data-blast-exit]').count().then(async n=>{if(n)await page.locator('[data-blast-exit]').click();});
 if(await page.locator('[data-workspace-host]').count())await page.getByRole('button',{name:'Exit',exact:false}).last().click();
 await page.locator('#trading-seed').click();await page.waitForLoadState('domcontentloaded');await ready();
 await page.evaluate(l=>{const s=window.tradingFixture.store;s.focus('A');s.setLayout(l);window.tradingFixture.state('A','ready');},layout);await settle();
 const input=card().locator('[data-panel-amount]');await input.fill('123.45');await page.waitForTimeout(500);const element=await input.elementHandle();
 assert.equal(await page.getByRole('region',{name:'Asset browser',exact:true}).count(),0);
 const firstHeight=+(await card().getByRole('separator',{name:'Resize chart and activity height',exact:true}).getAttribute('aria-valuenow'));
 await drag(card().getByRole('separator',{name:'Resize chart and activity height',exact:true}),0,60);
 assert.equal((await saved()).layout.terminal.height,firstHeight+60);
 assert.equal(await element.inputValue(),'123.45');assert.ok(await element.evaluate(e=>e.isConnected));
 const afterHeight=(await saved()).layout;
 await drag(card().getByRole('separator',{name:'Resize chart and activity height',exact:true}),0,-40,true);assert.deepEqual((await saved()).layout,afterHeight);
 await card().getByRole('separator',{name:'Resize chart and activity height',exact:true}).press('ArrowUp');assert.equal((await saved()).layout.terminal.height,firstHeight+40);
 await drag(card().getByRole('separator',{name:'Resize Chart and Market activity',exact:true}),-65,0);
 assert.ok((await saved()).layout.terminal.widths[0]<50);const resized=(await saved()).layout;
 await page.reload();await ready();assert.deepEqual((await saved()).layout,resized);assert.equal(await input.inputValue(),'123.45');
 await page.getByRole('button',{name:'Edit layout',exact:true}).click();await card().getByRole('button',{name:'Move Trade earlier',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.deepEqual((await saved()).layout,resized);
 await top();await page.keyboard.press('/');await page.getByRole('dialog',{name:'Discover',exact:true}).waitFor();await page.getByRole('tab',{name:'Presales',exact:true}).click();await page.keyboard.press('Escape');await settle();await page.getByRole('button',{name:'Discover coins and presales',exact:true}).click();assert.equal(await page.getByRole('tab',{name:'Presales',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('tab',{name:'Coins',exact:true}).click();await settle();await page.screenshot({path:out+'/discovery-light.png'});await page.keyboard.press('Escape');await settle();assert.equal(await input.inputValue(),'123.45');
 await top();await page.keyboard.press('Shift+S');await settle();assert.equal(await card().locator('[data-side="sell"]').getAttribute('aria-pressed'),'true');assert.ok(await input.evaluate(e=>e===document.activeElement));
 await top();await page.keyboard.press('Shift+B');await settle();assert.equal(await card().locator('[data-side="buy"]').getAttribute('aria-pressed'),'true');assert.equal(await input.inputValue(),'123.45');
 await page.evaluate(l=>window.tradingFixture.store.setLayout(l),layout);
 const cdp=await page.context().newCDPSession(page);
 evidence.widths=[];
 for(const theme of ['light','dark'])for(const width of [320,407,768,1054,1414]){
  await page.setViewportSize({width,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1024,maxTouchPoints:1});await page.evaluate(t=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',t),theme);await settle();await noOverflow();
  const metricBounds=await card().locator('header dl').evaluate(e=>{const r=e.getBoundingClientRect();const parent=e.closest('header').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,parentBottom:parent.bottom,viewport:innerWidth};});
  assert.ok(metricBounds.left>=0 && metricBounds.right<=metricBounds.viewport && metricBounds.bottom<=metricBounds.parentBottom+1,JSON.stringify(metricBounds));
  const amount=await input.elementHandle();const button=card().locator('[data-coin-submit]');await button.scrollIntoViewIfNeeded();assert.ok(await button.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}));
  const order=await card().locator('[data-workspace-section]').evaluateAll(es=>es.map(e=>e.dataset.workspaceSection));if(width<1024)assert.deepEqual(order,['chart','trade','activity','details']);
  assert.ok(await amount.evaluate(e=>e.isConnected));await top();await page.screenshot({path:out+`/coin-${theme}-${width}.png`});evidence.widths.push({width,theme,order,tradeReachable:true});
 }
 // Explicit mobile order may equal the desktop default and must still persist.
 await page.setViewportSize({width:407,height:900});await page.getByRole('button',{name:'Edit layout',exact:true}).click();await card().getByRole('button',{name:'Move Trade later',exact:true}).click();await page.getByRole('button',{name:'Done',exact:true}).click();assert.deepEqual((await saved()).layout.terminal.stacked_order,['chart','activity','trade']);
 await page.reload();await ready();assert.deepEqual(await card().locator('[data-workspace-section]').evaluateAll(es=>es.map(e=>e.dataset.workspaceSection)),['chart','activity','trade','details']);
 await page.evaluate(l=>window.tradingFixture.store.setLayout(l),layout);await settle();
 await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await settle();
 const touch=card().getByRole('separator',{name:'Resize chart height',exact:true});await touch.scrollIntoViewIfNeeded();const tr=await touch.boundingBox();assert.ok(tr.height>=44);const x=tr.x+tr.width/2,y=tr.y+tr.height/2;await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+40}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle();assert.equal((await saved()).layout.terminal.stacked_height,320);
 // The smallest legal desktop ticket must wrap rather than clip.
 await page.setViewportSize({width:1054,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await page.evaluate(l=>window.tradingFixture.store.setLayout({...l,terminal:{order:['chart','activity','trade'],widths:[50,30,20],height:460}}),layout);await settle();await noOverflow();await top();await page.screenshot({path:out+'/coin-narrow-ticket.png'});
 const overflow=await section('trade').evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth}));assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));evidence.narrowTicket=overflow;
 for(const state of ['loading','error','empty','unavailable','wallet-error','quote-error','native-ready']){await page.evaluate(s=>window.tradingFixture.state('A',s),state);await page.waitForTimeout(600);await noOverflow();evidence[state]=(await card().innerText()).slice(-1800);}
 await page.evaluate(l=>{window.tradingFixture.state('A','ready');window.tradingFixture.store.setLayout(l);},layout);await page.setViewportSize({width:1414,height:900});await settle();
 await page.emulateMedia({contrast:'more'});await page.screenshot({path:out+'/coin-increased-contrast.png'});await page.emulateMedia({contrast:'no-preference'});await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await page.screenshot({path:out+'/coin-reduced-transparency.png'});await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 evidence.runtimeErrors=errors;assert.deepEqual(errors,[]);writeFileSync(out+'/terminal-verification.json',JSON.stringify(evidence,null,2));console.log('PASS: terminal resize, cancellation, persistence, draft retention, discovery, shortcuts, mobile reorder, touch, five widths, both themes, bounded data states');
}finally{await browser.close();}
