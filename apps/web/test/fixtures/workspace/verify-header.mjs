import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
const out=process.env.TRADING_EVIDENCE_DIR;
assert.ok(out && process.env.TRADING_CDP_URL);
const browser=await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('/trading-proof'));
page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(30000);
const errors=[],evidence={widths:[]};page.on('pageerror',e=>errors.push(e.message));
const panel=()=>page.locator('[data-panel-id="A"]');
const header=()=>panel().locator('header').first();
const state=async s=>{await page.evaluate(s=>window.tradingFixture.state('A',s),s);await page.waitForTimeout(160);};
const top=()=>page.evaluate(()=>{document.activeElement?.blur();document.querySelectorAll('*').forEach(e=>{if(e.scrollTop)e.scrollTop=0;});});
async function ready(){await page.waitForFunction(()=>typeof document.getElementById('trading-open')?.onclick==='function');if(!await page.locator('[data-workspace-host]').count())await page.locator('#trading-open').click();await page.waitForFunction(()=>!!window.tradingFixture);if(!await page.getByRole('button',{name:/^KSTL panel ·/}).count()){const d=page.getByRole('region',{name:'Discover markets',exact:true});await d.getByRole('button',{name:'New coins',exact:true}).click();await d.getByRole('button',{name:'Open KSTL coin',exact:true}).click();}await page.evaluate(()=>window.tradingFixture.store.focus('A'));await header().getByRole('button',{name:'Copy KSTL coin address'}).waitFor();}
async function plotFits(){
 const chart=panel().getByRole('region',{name:'Price chart',exact:true});
 const frame=chart.getByRole('group',{name:'Inspect price history',exact:true});
 await frame.focus();await page.keyboard.press('Home');
 const first=await frame.evaluate(e=>{const canvas=e.querySelector('[class*="_canvas_"]').getBoundingClientRect();const clip=e.closest('[class*="_chartStage_"]').getBoundingClientRect();const time=e.querySelector('[class*="_timeAxis_"]').getBoundingClientRect();return {left:canvas.left-clip.left,right:clip.right-canvas.right,timeBottom:time.bottom,clipBottom:clip.bottom,height:canvas.height};});
 assert.ok(first.left>=3.9,JSON.stringify(first));assert.ok(first.right>=4,JSON.stringify(first));assert.ok(first.height>80,JSON.stringify(first));assert.ok(first.timeBottom<=first.clipBottom+1,JSON.stringify(first));
 await page.keyboard.press('End');assert.ok(await frame.locator('svg circle').count());await page.keyboard.press('Escape');return first;
}
try{
 await page.bringToFront();await page.setViewportSize({width:1414,height:1000});await page.emulateMedia({reducedMotion:'reduce'});
 await page.goto('http://127.0.0.1:42874/trading-proof',{waitUntil:'domcontentloaded'});await ready();
 await page.evaluate(()=>window.tradingFixture.store.setLayout({order:['chart','activity','trade','details'],hidden:[],split:64}));
 await header().getByRole('button',{name:'Inspect full exact asset balance: 600,000'}).waitFor();
 const amount=panel().locator('[data-panel-amount]');await amount.fill('123.45');
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 await header().getByRole('button',{name:'Copy KSTL coin address'}).click();await header().getByRole('button',{name:'Copied',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),await page.evaluate(()=>window.tradingFixture.store.getSnapshot().panels.A.coin_type));assert.equal(await page.getByRole('dialog').count(),0);
 const inspector=header().getByRole('button',{name:/Inspect full coin type on Sui/});await inspector.click();await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');assert.ok(await inspector.evaluate(e=>e===document.activeElement));
 const links=await header().getByRole('navigation',{name:'Project links'}).locator('a').evaluateAll(links=>links.map(a=>({href:a.href,rel:a.rel,target:a.target,label:a.ariaLabel})));
 assert.equal(links.length,3);assert.ok(links.every(a=>a.href.startsWith('https:')&&a.target==='_blank'&&a.rel.includes('noopener')));
 await page.waitForTimeout(1900);await page.evaluate(()=>{window.headerClipboard=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async()=>{throw new Error('Simulated denial')};});await header().getByRole('button',{name:'Copy KSTL coin address'}).click();await page.getByText('Copying is blocked here. Select the address instead.').waitFor();assert.equal(await header().getByRole('button',{name:'Copied',exact:true}).count(),0);await page.evaluate(()=>navigator.clipboard.writeText=window.headerClipboard);
 await state('wallet-loading');await header().getByRole('status',{name:'Loading your holdings'}).waitFor();await page.screenshot({path:out+'/holdings-loading.png'});await state('wallet-error');await header().getByRole('button',{name:'Retry balance'}).waitFor();await page.screenshot({path:out+'/holdings-error.png'});await state('ready');await header().getByRole('button',{name:'Inspect full exact asset balance: 600,000'}).waitFor();
 await state('zero');await header().getByRole('button',{name:'Inspect full exact asset balance: 0',exact:true}).waitFor();await state('unavailable');await header().getByRole('button',{name:'Retry balance'}).waitFor();assert.match(await header().innerText(),/Unavailable/);assert.doesNotMatch(await header().innerText(),/600,000/);await state('ready');
 await page.evaluate(()=>document.querySelector('[data-blast-ui]').setAttribute('data-amounts','hidden'));await state('stale');assert.doesNotMatch(await header().innerText(),/600,000|1,260/);assert.equal(await header().getByRole('button',{name:/exact asset balance/}).count(),0);await page.screenshot({path:out+'/holdings-private.png'});await page.evaluate(()=>document.querySelector('[data-blast-ui]').setAttribute('data-amounts','shown'));await state('ready');
 const cdp=await page.context().newCDPSession(page);
 for(const width of [320,1414])for(const theme of ['light','dark'])for(const status of ['guest','wallet-loading','wallet-error']){
  await page.setViewportSize({width,height:1000});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1024,maxTouchPoints:1});await page.evaluate(theme=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',theme),theme);await state(status);
  if(status==='wallet-loading')await header().getByRole('status',{name:'Loading your holdings'}).waitFor();else await header().getByRole('button',{name:status==='guest'?'Sign in':'Retry balance',exact:true}).waitFor();
  await top();const fits=await header().locator('dl > div').evaluateAll(cells=>cells.every(cell=>{const own=cell.getBoundingClientRect();return [...cell.querySelectorAll('button')].every(button=>{const r=button.getBoundingClientRect();return (button.ariaLabel!=="Retry balance"&&button.textContent!=="Sign in"||button.scrollWidth<=button.clientWidth+1)&&r.left>=own.left-1&&r.right<=own.right+1;});}));assert.ok(fits,`${status} ${width}`);
  await page.screenshot({path:out+`/holdings-${status}-${theme}-${width}.png`});
 }
 await state('ready');await header().getByRole('button',{name:'Inspect full exact asset balance: 600,000'}).waitFor();

 for(const theme of ['light','dark'])for(const width of [320,407,768,1054,1414]){
  await page.setViewportSize({width,height:1000});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:width<1024,maxTouchPoints:1});await page.evaluate(theme=>document.querySelector('[data-blast-ui]').setAttribute('data-theme',theme),theme);await top();await page.waitForTimeout(120);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const bounds=await header().evaluate(e=>({w:e.clientWidth,s:e.scrollWidth}));assert.ok(bounds.s<=bounds.w+1,JSON.stringify(bounds));
  const copy=header().getByRole('button',{name:'Copy KSTL coin address'});await page.keyboard.press('Tab');await copy.focus();assert.ok(await copy.evaluate(e=>e.matches(':focus-visible')));
  for(const target of [copy,...await header().getByRole('navigation',{name:'Project links'}).locator('a').all()]){
   const r=await target.boundingBox();if(width<1024){assert.ok(r.height>=44&&r.width>=44,JSON.stringify(r));}assert.ok(await target.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}));
  }
  const chart=await plotFits();await top();await page.screenshot({path:out+`/header-${theme}-${width}.png`});evidence.widths.push({theme,width,overflow:false,chart});
 }
 await page.setViewportSize({width:1414,height:1000});await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
 const separators=panel().getByRole('separator');evidence.separators=await separators.evaluateAll(es=>es.map(e=>e.ariaLabel));
 const horizontal=panel().getByRole('separator',{name:'Resize Chart and Market activity',exact:true});if(await horizontal.count()){await horizontal.focus();await page.keyboard.press('Home');await plotFits();await horizontal.focus();await page.keyboard.press('End');await plotFits();}
 const height=panel().getByRole('separator',{name:/height/i}).first();await height.focus();await page.keyboard.press('Home');await plotFits();await height.focus();await page.keyboard.press('End');await plotFits();
 await page.evaluate(()=>{const s=window.tradingFixture.store;const l=s.getSnapshot().layout;s.setLayout({...l,terminal:{...l.terminal,height:460,widths:[50,25,25]}});});
 await state('native-ready');await plotFits();await state('ready');assert.equal(await amount.inputValue(),'123.45');
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-panel-id="A"] button')].some(b=>b.textContent==='Buy KSTL'&&!b.disabled));await top();await page.screenshot({path:out+'/final-dark.png'});await page.evaluate(()=>document.querySelector('[data-blast-ui]').setAttribute('data-theme','light'));await page.screenshot({path:out+'/final-light.png'});
 await page.emulateMedia({contrast:'more'});await page.screenshot({path:out+'/increased-contrast.png'});await page.emulateMedia({contrast:'no-preference'});await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});await page.screenshot({path:out+'/reduced-transparency.png'});
 const discover=page.getByRole('region',{name:'Discover markets',exact:true});await discover.getByRole('button',{name:'Presales',exact:true}).click();await discover.getByRole('button',{name:'Open NOVA presale',exact:true}).click();await page.getByRole('button',{name:'Copy NOVA coin address',exact:true}).waitFor();await top();await page.screenshot({path:out+'/presale-light.png'});
 evidence.links=links;evidence.runtimeErrors=errors;assert.deepEqual(errors,[]);writeFileSync(out+'/header-verification.json',JSON.stringify(evidence,null,2));console.log('PASS header states, copy success/failure, social destinations, five widths/two themes, chart endpoints, resizing, draft retention and presale header');
}finally{await browser.close();}
