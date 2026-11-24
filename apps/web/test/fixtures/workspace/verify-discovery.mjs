import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const out=process.env.TRADING_EVIDENCE_DIR;
assert.ok(out && process.env.TRADING_CDP_URL);
const browser=await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('/trading-proof'));
page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(30000);
const evidence={widths:[]}, errors=[];
page.on('pageerror',e=>errors.push(e.message));
const settle=()=>page.waitForTimeout(200);
const discovery=()=>page.getByRole('region',{name:'Discover markets',exact:true});
const list=name=>discovery().getByRole('button',{name,exact:true});
const state=async value=>page.evaluate(value=>{window.discoveryFixture.state=value},value);
const saved=()=>page.evaluate(()=>window.tradingFixture.store.getSnapshot());
const top=()=>page.evaluate(()=>{document.activeElement?.blur();document.querySelectorAll('*').forEach(e=>{if(e.scrollTop)e.scrollTop=0;});});
async function ready(){await page.waitForFunction(()=>typeof document.getElementById('trading-open')?.onclick==='function');if(!await page.locator('[data-workspace-host]').count())await page.locator('#trading-open').click();await page.waitForFunction(()=>!!window.tradingFixture);}
async function refresh(s){await state(s);await discovery().getByRole('button',{name:'Refresh discovery',exact:true}).click();await settle();}
async function focusA(){await page.getByRole('button',{name:/^KSTL panel ·/}).click();await discovery().waitFor();}
try {
 await page.bringToFront();await page.setViewportSize({width:1414,height:1000});await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto('http://127.0.0.1:42874/trading-proof',{waitUntil:'domcontentloaded'});await ready();
 await page.getByRole('button',{name:'Exit B',exact:true}).click();await page.locator('#trading-seed').click();await page.waitForLoadState('domcontentloaded');await ready();
 await page.evaluate(()=>{window.tradingFixture.store.focus('A');window.tradingFixture.store.setLayout({order:['chart','trade','activity','details'],hidden:[],split:64});});
 await list('New coins').waitFor();await discovery().getByRole('button',{name:'Open MOCHI coin'}).waitFor();
 const amount=page.locator('[data-panel-id="A"] [data-panel-amount]');await amount.fill('123.45');await settle();const input=await amount.elementHandle();
 await state('loading');await list('Trending').click();await discovery().getByRole('status',{name:'Loading market discovery'}).waitFor();assert.equal(await discovery().getByText('No trading coins',{exact:false}).count(),0);await page.screenshot({path:out+'/loading.png'});
 await state('ready');await list('New coins').click();await list('Trending').click();await discovery().getByRole('button',{name:'Open MOCHI coin'}).waitFor();
 await state('error');await list('Presales').click();await discovery().getByRole('alert').waitFor();await page.screenshot({path:out+'/error.png'});await state('ready');await discovery().getByRole('button',{name:'Retry discovery'}).click();await discovery().getByRole('button',{name:'Open NOVA presale'}).waitFor();await top();await page.screenshot({path:out+'/presales-list-light.png'});
 await list('Your holdings').click();await page.getByRole('region',{name:'Your position',exact:true}).waitFor();assert.ok(await input.evaluate(e=>e.isConnected));assert.equal(await input.inputValue(),'123.45');
 await list('New coins').click();await refresh('error');assert.match(await discovery().innerText(),/previous snapshot/);assert.ok(await discovery().getByRole('button',{name:'Open MOCHI coin'}).count());
 await refresh('ready');await refresh('empty');assert.match(await discovery().innerText(),/No trading coins in this list yet/);await page.screenshot({path:out+'/empty.png'});
 await refresh('stale');assert.match(await discovery().innerText(),/Indexed activity is delayed/);assert.ok(await discovery().getByText('Stale',{exact:true}).count());
 await refresh('unknown');assert.ok(await discovery().getByRole('button',{name:'Inspect full KSTL price in USD: Unavailable',exact:true}).count());
 await refresh('duplicates');assert.equal(await discovery().getByRole('button',{name:'Open KSTL coin',exact:true}).count(),3);const inspectors=discovery().getByRole('button',{name:/Inspect full KSTL coin type on Sui mainnet:/});assert.equal(await inspectors.count(),3);await inspectors.last().click();assert.match(await page.getByRole('dialog').innerText(),/0xdeadbeef::kestrel::KSTL/);await page.keyboard.press('Escape');
 await refresh('ready');await discovery().getByRole('button',{name:'Open LUMN coin',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().focused_panel_id==='B');await focusA();assert.equal(await amount.inputValue(),'123.45');
 await page.evaluate(()=>{const s=window.tradingFixture.store;s.selectDataView('Portfolio');s.setDataViewEnabled('Coins',false);});await discovery().getByRole('button',{name:'Search all coins and presales'}).click();await page.getByRole('dialog',{name:'Discover',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'Coins',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('searchbox',{name:'Search coins',exact:true}).waitFor();assert.ok(await page.getByRole('searchbox',{name:'Search coins',exact:true}).evaluate(e=>e===document.activeElement));await page.keyboard.press('Escape');await settle();assert.ok(await discovery().getByRole('button',{name:'Search all coins and presales'}).evaluate(e=>e===document.activeElement));
 await list('Presales').click();await discovery().getByRole('button',{name:'Open NOVA presale'}).click();await discovery().getByRole('button',{name:'Your allocation',exact:true}).waitFor();const presaleId=(await saved()).focused_panel_id;assert.equal((await saved()).panels[presaleId].active_namespace,'presale');assert.equal((await saved()).panels.A.coin.trade.buy.typed,'123.45');assert.ok((await saved()).retained_order.includes('A'));
 await list('Your allocation').click();await page.getByRole('region',{name:'Your allocation',exact:true}).waitFor();await list('Presales').click();await discovery().getByRole('button',{name:'Open NOVA presale'}).waitFor();await top();await page.screenshot({path:out+'/presale-terminal-light.png'});
 await list('New coins').click();await discovery().getByRole('button',{name:'Open KSTL coin'}).click();await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().focused_panel_id==='A');assert.equal(await amount.inputValue(),'123.45');await list('New coins').click();await top();await page.screenshot({path:out+'/final-light.png'});
 const cdp=await page.context().newCDPSession(page);
 for(const theme of ['light','dark'])for(const width of [320,407,768,1054,1414]){
  await page.setViewportSize({width,height:900});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1024,maxTouchPoints:1});await page.evaluate(theme=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',theme),theme);await settle();
  await discovery().scrollIntoViewIfNeeded();await settle();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const bounds=await discovery().evaluate(e=>({scroll:e.scrollWidth,width:e.clientWidth}));assert.ok(bounds.scroll<=bounds.width+1,JSON.stringify(bounds));
  const open=discovery().getByRole('button',{name:'Open MOCHI coin'});await open.scrollIntoViewIfNeeded();assert.ok(await open.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}));
  await page.keyboard.press('Tab');await open.focus();assert.ok(await open.evaluate(e=>e.matches(':focus-visible')));await page.screenshot({path:out+`/discovery-${theme}-${width}.png`});
  await list('Presales').click();await discovery().getByRole('button',{name:'Open NOVA presale'}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:out+`/presales-${theme}-${width}.png`});
  await list('New coins').click();evidence.widths.push({theme,width,overflow:false,keyboardFocus:true});
 }
 await page.setViewportSize({width:1414,height:1000});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});await top();await page.screenshot({path:out+'/final-dark.png'});
 await page.emulateMedia({contrast:'more'});await page.screenshot({path:out+'/increased-contrast.png'});await page.emulateMedia({contrast:'no-preference'});await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await page.screenshot({path:out+'/reduced-transparency.png'});
 evidence.requests=await page.evaluate(()=>window.discoveryFixture.requests);evidence.passed=['pending-to-ready','pending-to-error-to-retry','refresh-error-keeps-data','confirmed-empty','stale','unknown','duplicate-contract-inspection','keyboard-selection','draft-retention','search-from-hidden-Coins-and-Portfolio','search-focus-return','focus-replacement-retains-draft','presale-selection-namespace','allocation-tab','five-widths-two-themes'];evidence.runtimeErrors=errors;assert.deepEqual(errors,[]);writeFileSync(out+'/discovery-verification.json',JSON.stringify(evidence,null,2));console.log('PASS:',evidence.passed.join(', '));
}finally{await browser.close();}
