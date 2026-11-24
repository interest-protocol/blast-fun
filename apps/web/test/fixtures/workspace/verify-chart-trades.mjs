import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const out=process.env.TRADING_EVIDENCE_DIR;
assert.ok(out);
const browser=await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('/trading-proof'));
assert.ok(page && new URL(page.url()).hostname==='127.0.0.1','Controlled local fixture only');
page.setDefaultTimeout(12000);
const errors=[],passed=[];
page.on('pageerror',error=>errors.push(error.message));
const type=symbol=>`0x${'7a3f'.padEnd(60,'0')}c91e::${symbol.toLowerCase()}::${symbol}`;
const holdings=[
 {coin_type:type('KSTL'),symbol:'KSTL',name:'Kestrel',decimals:9,icon_url:null,balance:'600000000000001',value_usd:'1284.12',presale_id:null},
 {coin_type:type('LUMN'),symbol:'LUMN',name:'Lumen',decimals:9,icon_url:null,balance:'2000000000000',value_usd:'84.24',presale_id:null},
 {coin_type:type('ODD'),symbol:'ODD',name:'Unknown metadata',decimals:null,icon_url:null,balance:'1',value_usd:null,presale_id:null},
];
await page.route('**/api/social/me/**',async route=>{
 const url=new URL(route.request().url());
 if(url.pathname.endsWith('/settings')) return route.fulfill({json:{}});
 if(!url.pathname.includes('/portfolio')) return route.continue();
 if(url.pathname.endsWith('/coins')) return route.fulfill({json:{coins:holdings,page:1,page_size:20,total:3}});
 return route.fulfill({json:{balances:{sui:{atoms:'0',usd:'0.00'},usdc:{atoms:'860000000',usd:'860.00'}},positions:[],commitments:{committed_usd:'0.00',claimable_usd:'0.00'},coins:holdings.map((coin,i)=>({...coin,basis_usd:'1000.00',basis_complete:i!==2,pnl_usd:i?'-15.76':'284.12',pnl_multiple:i?'0.8424':'1.2841'})),vesting:{has_schedule:false,href:null},totals:{people:0,volume_usd:'0.00'},trend:null,prices_as_of_ms:Date.now(),unavailable:['trend'],wallet_sync:{status:'ready',checkpoint:'1',as_of_ms:Date.now()}}});
});
const filtersButton=()=>page.getByRole('button',{name:'Chart activity filters',exact:true});
const filters=()=>page.locator('[aria-label="Chart activity filters"]').filter({has:page.getByRole('heading',{name:'People on chart',exact:true})});
const markers=()=>page.locator('[data-chart-trade-marker]');
const details=()=>page.locator('[aria-label="Chart trade details"]');
const drawer=()=>page.getByRole('dialog',{name:'Portfolio',exact:true});
const capture=name=>page.screenshot({path:`${out}/${name}.png`});
const count=async()=>markers().evaluateAll(nodes=>nodes.reduce((total,node)=>{const match=node.getAttribute('aria-label').match(/(\d+) buys?, (\d+) sells?/);return total+Number(match[1])+Number(match[2]);},0));
async function openFilters(){await filtersButton().click();await filters().waitFor();}
async function closeFilters(){await filters().getByRole('button',{name:'Done',exact:true}).click();await filters().waitFor({state:'hidden'});}
async function pick(name,value){await filters().getByRole('checkbox',{name,exact:true}).setChecked(value);}
const groupNames=['KOLs Curated Blast accounts','Top traders Top 10 by public PnL · 24h','Following Accounts you follow'];
async function groups(selected){for(const name of groupNames) await pick(name,selected.includes(name));}
async function assertPeopleSelected(){
 const state=await filtersButton().evaluate(button=>{
  const computed=getComputedStyle(button),probe=document.createElement('span');button.append(probe);
  probe.style.background='var(--workspace-accent-soft)';probe.style.color='var(--workspace-accent-text)';
  const selected=getComputedStyle(probe),result={active:button.dataset.active,background:computed.backgroundColor,color:computed.color,selectedBackground:selected.backgroundColor,selectedColor:selected.color};probe.remove();return result;
 });
 assert.equal(state.active,'true');assert.equal(state.background,state.selectedBackground);assert.equal(state.color,state.selectedColor);
}
async function resetFilters(){await openFilters();await pick('Show people',true);const posts=filters().getByRole('checkbox',{name:/^Calls & theses/});if(await posts.isEnabled())await posts.setChecked(false);await groups(groupNames);await pick('B · Buys',true);await pick('S · Sells',true);await closeFilters();await page.waitForFunction(()=>document.querySelectorAll('[data-chart-trade-marker]').length>0);await assertPeopleSelected();await filtersButton().hover();await assertPeopleSelected();await page.mouse.move(0,0);}
async function check(name,run){await run();passed.push(name);console.log('PASS',name);}
try{
 await page.setViewportSize({width:1414,height:1000});await page.emulateMedia({reducedMotion:'reduce'});
 await page.reload({waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>typeof document.getElementById('trading-open')?.onclick==='function');
 if(!(await page.locator('[data-workspace-host]').count())) await page.getByRole('button',{name:'Open Blast mode',exact:true}).click();
 await page.waitForFunction(()=>!!window.tradingFixture);
 await page.evaluate(coin=>{const s=window.tradingFixture.store;s.setPresentation('focus');s.setCapacity(2);s.setDataCollapsed(true);s.add({panel_id:'A',coin_type:coin,chain:'sui',network:'mainnet',presale_id:null});s.focus('A');document.querySelector('[data-blast-ui]').setAttribute('data-theme','light');},type('KSTL'));
 await filtersButton().waitFor();
 await check('Portfolio single page shows three holdings with no pager and Buy more/Sell still select the intended side',async()=>{
  await page.getByRole('button',{name:'Portfolio',exact:true}).click();await drawer().getByRole('button',{name:'Sell KSTL',exact:true}).waitFor();
  await drawer().getByText('3 holdings',{exact:true}).waitFor();assert.equal(await drawer().getByRole('button',{name:'Next coin page',exact:true}).count(),0);
  await capture('portfolio-desktop-light');
  await drawer().getByRole('button',{name:'Sell KSTL',exact:true}).click();await drawer().waitFor({state:'hidden'});
  await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().panels.A.coin.trade.side==='sell');
  await page.getByRole('button',{name:'Portfolio',exact:true}).click();await drawer().getByRole('button',{name:'Buy more KSTL',exact:true}).click();await drawer().waitFor({state:'hidden'});
  await page.waitForFunction(()=>window.tradingFixture.store.getSnapshot().panels.A.coin.trade.side==='buy');
 });
 await check('Overlays default off; all groups union five demo trades and side filters are literal',async()=>{
  assert.equal(await markers().count(),0);await resetFilters();assert.equal(await count(),5);
  await capture('chart-desktop-light');await openFilters();await capture('filters-desktop-light');
  await pick('B · Buys',false);await closeFilters();assert.equal(await count(),2);
  await openFilters();await pick('S · Sells',false);await closeFilters();assert.equal(await markers().count(),0);
  await page.getByText('Select Buys or Sells to show trades.',{exact:true}).waitFor();
  await openFilters();await pick('B · Buys',true);await closeFilters();assert.equal(await count(),3);
 });
 await check('KOL-only, top-trader-only, Following-only and empty groups do not broaden results',async()=>{
  await resetFilters();
  const expected=[2,5,1];
  for(let i=0;i<groupNames.length;i++) {await openFilters();await groups([groupNames[i]]);await closeFilters();await page.waitForTimeout(80);assert.equal(await count(),expected[i],groupNames[i]);}
  await openFilters();await groups([]);await closeFilters();assert.equal(await markers().count(),0);await page.getByText('Select a group to show trades.',{exact:true}).waitFor();
 });
 await check('Trade details retain exact amounts, direction, actor and time; Escape returns focus to marker',async()=>{
  await resetFilters();await markers().first().focus();await page.keyboard.press('Enter');await details().waitFor();
  assert.match(await details().innerText(),/Kofi Mensah/);assert.match(await details().innerText(),/Buy/);assert.match(await details().innerText(),/UTC/);
  const inspect=details().getByRole('button',{name:/Inspect full chart trade amount:/}).first();assert.match(await inspect.getAttribute('aria-label'),/84\.20/);
  await capture('trade-details-desktop-light');await page.keyboard.press('Escape');await details().waitFor({state:'hidden'});assert.equal(await markers().first().evaluate(node=>node===document.activeElement),true);
 });
 await check('Following-only marker and open details disappear immediately on sign-out, then recover for a fresh actor',async()=>{
  await openFilters();await groups([groupNames[2]]);await closeFilters();assert.equal(await count(),1);await markers().first().click();await details().waitFor();
  await page.evaluate(()=>window.holderFixture.setSignedIn(false));await details().waitFor({state:'hidden'});assert.equal(await markers().count(),0);await page.getByText('Sign in to use Following.',{exact:true}).waitFor();
  await openFilters();assert.equal(await filters().getByRole('checkbox',{name:'Following Sign in to use Following',exact:true}).isDisabled(),true);await closeFilters();
  await page.evaluate(()=>{window.holderFixture.setScope('other');window.holderFixture.setSignedIn(true)});
  await page.getByText('No matching trades in this view.',{exact:true}).waitFor();assert.equal(await markers().count(),0);
  await page.evaluate(()=>window.holderFixture.setScope('holder-fixture'));await page.waitForFunction(()=>document.querySelectorAll('[data-chart-trade-marker]').length===1);
 });
 await check('Activity loading, error/retry, unavailable and confirmed empty remain distinct',async()=>{
  await resetFilters();
  await page.evaluate(()=>window.tradingFixture.state('A','trades-loading'));await page.getByRole('status',{name:'Loading chart trades',exact:true}).waitFor();assert.equal(await markers().count(),0);assert.equal(await page.getByText('No matching trades in this view.',{exact:true}).count(),0);
  await page.evaluate(()=>window.tradingFixture.state('A','trades-error'));await page.getByRole('button',{name:'Retry trades',exact:true}).waitFor();assert.equal(await markers().count(),0);
  await page.evaluate(()=>window.tradingFixture.state('A','trades-unavailable'));await page.getByText('Chart trades unavailable for this market.',{exact:true}).waitFor();
  await page.evaluate(()=>window.tradingFixture.state('A','trades-empty'));await page.getByText('No matching trades in this view.',{exact:true}).waitFor();
  await page.evaluate(()=>window.tradingFixture.state('A','ready'));await page.waitForFunction(()=>document.querySelectorAll('[data-chart-trade-marker]').length>0);
 });
 await check('Missing KOL configuration, incomplete Following, and ranking failures remain explicit',async()=>{
  await resetFilters();await openFilters();await groups([groupNames[0]]);await closeFilters();
  await page.evaluate(()=>window.holderFixture.setKols([]));await page.getByText('KOL list is not configured yet.',{exact:true}).waitFor();assert.equal(await markers().count(),0);assert.equal(await page.getByText('No matching trades in this view.',{exact:true}).count(),0);
  await page.evaluate(()=>window.holderFixture.setKols(['maralin']));await page.waitForFunction(()=>document.querySelectorAll('[data-chart-trade-marker]').length>0);
  await openFilters();await groups([groupNames[2]]);await closeFilters();
  await page.evaluate(()=>window.holderFixture.setScope('unavailable'));await page.getByRole('button',{name:'Retry Following',exact:true}).waitFor();assert.equal(await markers().count(),0);assert.equal(await page.getByText('No matching trades in this view.',{exact:true}).count(),0);
  await page.evaluate(()=>window.holderFixture.setScope('holder-fixture'));await page.waitForFunction(()=>document.querySelectorAll('[data-chart-trade-marker]').length>0);
  await openFilters();await groups([groupNames[1]]);await closeFilters();
  await page.evaluate(async()=>{window.discoveryFixture.pnlState='error';await window.holderFixture.refreshPnl()});await page.getByRole('button',{name:'Retry rankings',exact:true}).waitFor();assert.equal(await markers().count(),0);
  await page.evaluate(()=>window.discoveryFixture.pnlState='ready');await page.getByRole('button',{name:'Retry rankings',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-chart-trade-marker]').length>0);
  await page.evaluate(()=>window.tradingFixture.state('A','trades-partial'));await page.getByText('Trades · 24h · partial history',{exact:true}).waitFor();
  await page.evaluate(()=>window.tradingFixture.state('A','trades-delayed'));await page.getByText('Trade indexing is delayed; recent trades may be missing.',{exact:true}).waitFor();
  await page.evaluate(()=>window.tradingFixture.state('A','ready'));
 });
 await check('Both themes at five widths fit chart controls, popovers, holdings and grouped markers',async()=>{
  const cdp=await page.context().newCDPSession(page);
  for(const width of [320,407,768,1054,1414]){
   await page.setViewportSize({width,height:1000});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<=768});
   for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',theme),theme);
    await resetFilters();if(width<=768) await page.getByRole('navigation',{name:'Selected market navigation',exact:true}).getByRole('button',{name:'Chart',exact:true}).click(); else await page.locator('[data-workspace-section="chart"]:visible').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await count(),5);
    await capture(`chart-${width}-${theme}`);await openFilters();
    const box=await filters().boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.y>=0,JSON.stringify(box));
    if(width===407||width===1414)await capture(`filters-${width}-${theme}`);
    await closeFilters();assert.equal(await filtersButton().evaluate(node=>node===document.activeElement),true);
    await page.getByRole('button',{name:'Portfolio',exact:true}).click();await drawer().getByText('3 holdings',{exact:true}).waitFor();
    if(width===407||width===1414)await capture(`portfolio-${width}-${theme}`);
    await page.keyboard.press('Escape');await drawer().waitFor({state:'hidden'});
   }
  }
 });
 assert.deepEqual(errors,[]);
}finally{writeFileSync(`${out}/browser-results.json`,JSON.stringify({passed,errors},null,2));await browser.close();}
