import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
const out=process.env.TRADING_EVIDENCE_DIR;
assert.ok(out && process.env.TRADING_CDP_URL);
const browser=await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('/trading-proof'));
page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(30000);
const errors=[],evidence={views:[]};page.on('pageerror',e=>errors.push(e.message));
const top=()=>page.evaluate(()=>{document.activeElement?.blur();document.querySelectorAll('*').forEach(e=>{if(e.scrollTop)e.scrollTop=0;});});
const panel=()=>page.locator('[data-panel-id]:visible').filter({has:page.locator('[data-workspace-section="chart"]')}).first();
const header=()=>panel().locator('header').first();
const discovery=()=>panel().getByRole('region',{name:'Discover markets',exact:true});
const state=async s=>{await page.evaluate(s=>window.tradingFixture.state('A',s),s);await page.waitForTimeout(120);};
async function openMarket(tab,label){await discovery().getByRole('button',{name:tab,exact:true}).click();await discovery().getByRole('button',{name:label,exact:true}).click();await page.waitForTimeout(200);}
async function geometry(){return panel().locator('[data-workspace-section]').evaluateAll(es=>Object.fromEntries(es.map(e=>[e.dataset.workspaceSection,e.getBoundingClientRect().toJSON()])));}
async function terminalFits(){const g=await geometry();assert.ok(Math.abs(g.details.x-Math.min(g.chart.x,g.activity.x,g.trade.x))<1);assert.ok(Math.abs(g.details.right-Math.max(g.chart.right,g.activity.right,g.trade.right))<1);assert.ok(Math.abs(g.details.y-Math.max(g.chart.bottom,g.activity.bottom,g.trade.bottom)-6)<1);const height=Number(await panel().getByRole('separator',{name:/height/}).getAttribute('aria-valuenow'));assert.ok(Math.abs(height-g.chart.height)<1,JSON.stringify({height,g}));return g;}
async function plotFits(){const chart=panel().getByRole('region',{name:'Price chart',exact:true});const frame=chart.getByRole('group',{name:'Inspect price history',exact:true});await frame.focus();await page.keyboard.press('Home');const r=await frame.evaluate(e=>{const c=e.querySelector('[class*="_canvas_"]').getBoundingClientRect(),f=e.getBoundingClientRect(),time=e.querySelector('[class*="_timeAxis_"]').getBoundingClientRect(),stage=e.closest('[class*="_chartStage_"]').getBoundingClientRect();return {left:c.left-f.left,right:f.right-c.right,h:c.height,timeBottom:time.bottom,stageBottom:stage.bottom};});assert.ok(Math.abs(r.left-4)<1&&Math.abs(r.right-4)<1,JSON.stringify(r));assert.ok(r.h>40&&r.timeBottom<=r.stageBottom+1);await page.keyboard.press('End');assert.ok(await frame.locator('svg circle').count());await page.keyboard.press('Escape');return r;}
try{
 await page.bringToFront();await page.setViewportSize({width:1414,height:1100});await page.emulateMedia({reducedMotion:'reduce'});
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof document.getElementById('trading-open')?.onclick==='function');if(!await page.locator('[data-workspace-host]').count())await page.locator('#trading-open').click();await page.waitForFunction(()=>!!window.tradingFixture);
 if(!await header().getByRole('button',{name:'Copy KSTL coin address'}).count())await openMarket('New coins','Open KSTL coin');
 await page.evaluate(()=>window.tradingFixture.store.setLayout({order:['chart','activity','trade','details'],hidden:[],split:64}));await state('ready');
 const amount=panel().locator('[data-panel-amount]');await amount.fill('123.45');await header().getByRole('button',{name:/Inspect full current unrealized PnL/}).waitFor();
 for(const s of ['pnl-loading','pnl-error','pnl-unknown','pnl-loss','zero','guest']){await state(s);if(['pnl-unknown','zero'].includes(s))await header().getByRole('button',{name:/current PnL availability/}).waitFor();if(s==='pnl-loss')await header().getByRole('button',{name:/Inspect full current unrealized PnL/}).waitFor();const text=await header().innerText();if(s==='pnl-loading')await header().getByRole('status',{name:'Loading current PnL'}).waitFor();if(s==='pnl-error')await header().getByRole('button',{name:'Retry current PnL'}).waitFor();if(s==='pnl-loss')assert.match(text,/−\$125/);if(s==='pnl-unknown'||s==='zero')assert.match(text,/Unavailable/);assert.doesNotMatch(text,/\+\$260/);await top();await page.screenshot({path:out+`/${s}.png`});}
 await state('ready');await header().getByRole('button',{name:/Inspect full current unrealized PnL/}).waitFor();await page.evaluate(()=>document.querySelector('[data-blast-ui]').setAttribute('data-amounts','hidden'));await state('stale');assert.doesNotMatch(await header().innerText(),/260|26%|600,000|1,260/);await page.evaluate(()=>document.querySelector('[data-blast-ui]').setAttribute('data-amounts','shown'));await state('ready');
 const cdp=await page.context().newCDPSession(page);
 for(const market of ['coin','presale']){
  if(market==='presale'){await openMarket('Presales','Open NOVA presale');await header().getByRole('button',{name:/Your commitment across linked wallets/}).waitFor();const input=panel().getByRole('textbox',{name:'Commit amount',exact:true});await input.fill('100');}
  for(const theme of ['light','dark'])for(const width of [320,407,768,1054,1414]){
   await page.setViewportSize({width,height:1100});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1024,maxTouchPoints:1});await page.evaluate(theme=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',theme),theme);await page.waitForTimeout(200);await top();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const h=await header().evaluate(e=>({w:e.clientWidth,s:e.scrollWidth}));assert.ok(h.s<=h.w+1,JSON.stringify(h));
   const g=width>=1054?await terminalFits():await geometry();
   let chart;if(market==='coin')chart=await plotFits();else {const svg=panel().locator('[class*="_funding_"] [data-tradingview-plot][data-ready]');await svg.waitFor();const b=await svg.boundingBox();assert.ok(b.width>100&&b.height>100,JSON.stringify(b));chart=b;}
   await top();await page.screenshot({path:out+`/${market}-${theme}-${width}.png`});evidence.views.push({market,theme,width,geometry:g,chart});
  }
  await page.setViewportSize({width:1414,height:1100});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await top();
  const height=panel().getByRole('separator',{name:/height/});await height.focus();await page.keyboard.press('Home');await page.waitForTimeout(100);const before=await terminalFits();const hb=await height.boundingBox();await page.mouse.move(hb.x+hb.width/2,hb.y+hb.height/2);await page.mouse.down();await page.mouse.move(hb.x+hb.width/2,hb.y+hb.height/2+60,{steps:6});await page.mouse.up();await page.waitForTimeout(100);const after=await terminalFits();assert.ok(Math.abs(after.chart.height-before.chart.height-60)<=1,JSON.stringify({before,after}));await height.focus();await page.keyboard.press('Home');await page.waitForTimeout(100);await terminalFits();
  const widthHandle=panel().getByRole('separator',{name:market==='coin'?'Resize Chart and Market activity':'Resize Funding and Participants & posts',exact:true});await widthHandle.focus();await page.keyboard.press('Home');await page.waitForTimeout(150);await terminalFits();if(market==='coin')await plotFits();await widthHandle.focus();await page.keyboard.press('End');await page.waitForTimeout(150);await terminalFits();if(market==='coin')await plotFits();
  await page.evaluate(()=>{const s=window.tradingFixture.store,l=s.getSnapshot().layout;s.setLayout({...l,terminal:{...l.terminal,height:460,widths:[50,25,25]}});});await page.waitForTimeout(150);
  if(market==='coin'){assert.equal(await amount.inputValue(),'123.45');await state('native-ready');await plotFits();await state('ready');await page.waitForFunction(()=>[...document.querySelectorAll('[data-panel-id="A"] button')].some(b=>b.textContent==='Buy KSTL'&&!b.disabled));}
  await top();for(const theme of ['light','dark']){await page.evaluate(theme=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',theme),theme);await page.screenshot({path:out+`/final-${market}-${theme}.png`});}
 }
 assert.doesNotMatch(await header().innerText(),/Current PnL/);assert.match(await header().innerText(),/250 USDC/);
 await openMarket('New coins','Open KSTL coin');assert.equal(await panel().locator('[data-panel-amount]').inputValue(),'123.45');
 evidence.runtimeErrors=errors;assert.deepEqual(errors,[]);writeFileSync(out+'/fullwidth-verification.json',JSON.stringify(evidence,null,2));console.log('PASS full-width discovery, immediate resizing, drafts, chart edges, PnL states and presale commitment at five widths in both themes');
}finally{await browser.close();}
