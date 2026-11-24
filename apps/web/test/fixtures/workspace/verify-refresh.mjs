import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Production components with deterministic reads; this never connects to the live service.
const base = process.env.REFRESH_FIXTURE_URL ?? 'http://127.0.0.1:42929/parity-proof';
const output = process.env.REFRESH_EVIDENCE_DIR;
assert.equal(new URL(base).hostname, '127.0.0.1');
assert.ok(output && process.env.REFRESH_CDP_URL);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.REFRESH_CDP_URL,{noDefaults:true});
const page = browser.contexts()[0].pages()[0];
await page.bringToFront();
const client = await page.context().newCDPSession(page);
const results = process.env.REFRESH_RESUME === '1' ? JSON.parse(await readFile(`${output}/refresh-results.json`,'utf8')) : { environment: 'Local development fixture, synthetic data; not production performance', captures: [], recordings: [], errors: [] };
const recheck = new Set((process.env.REFRESH_RECHECK ?? '').split(',').filter(Boolean));
results.recordings = results.recordings.filter(row=>!recheck.has(row.surface));
results.errors = results.errors.filter(row=>!recheck.has(new URL(row.url).searchParams.get('surface')));
page.setDefaultTimeout(60000);
page.on('pageerror', error => results.errors.push({ url: page.url(), message: error.message }));
await page.addInitScript(() => {
  const selector = node => !node ? null : node.id ? `#${node.id}` : `${node.tagName?.toLowerCase()}.${String(node.className).split(' ').slice(0,2).join('.')}`;
  window.refreshMetrics = { paints: [], lcp: [], shifts: [] };
  for (const type of ['paint', 'largest-contentful-paint', 'layout-shift']) new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if(type === 'paint') window.refreshMetrics.paints.push({name:entry.name,time:entry.startTime});
      if(type === 'largest-contentful-paint') window.refreshMetrics.lcp.push({time:entry.startTime,size:entry.size,element:selector(entry.element)});
      if(type === 'layout-shift') window.refreshMetrics.shifts.push({time:entry.startTime,value:entry.value,hadRecentInput:entry.hadRecentInput,sources:entry.sources?.map(s=>({node:selector(s.node),previous:s.previousRect.toJSON(),current:s.currentRect.toJSON()}))});
    }
  }).observe({type,buffered:true});
});
const hydrated = () => page.waitForFunction(() => performance.getEntriesByName('fixture-hydrated').length > 0, undefined, {timeout:60000});
async function settled(transition = false) {
  await hydrated();
  if (transition) await page.locator('[data-fixture-resolved="true"]').waitFor({state:'attached',timeout:60000});
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const params = (surface, theme, extras={}) => `${base}?${new URLSearchParams({surface,theme,shell:'member',...extras})}`;
const measure = () => page.evaluate(() => {
  const box = selector => { const node=document.querySelector(selector); if(!node) return null; const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  return { width:innerWidth, documentWidth:document.documentElement.scrollWidth, bodyWidth:document.body.scrollWidth, hero:box('#pfHero'),holdings:box('#pfHold'),heading:box('[data-page-head]'),balance:box('[aria-label$="Portfolio breakdown"]'),blast:box('[aria-label="Blast mode"]'),presaleHead:box('[data-sale-page] [class*="sale-head"]'),presaleBody:box('[data-sale-content]'), main:box('main'),fontStatus:document.fonts.status, h1:[...document.querySelectorAll('h1')].map(n=>n.textContent),metrics:window.refreshMetrics,marks:performance.getEntriesByType('mark').filter(e=>e.name.startsWith('fixture-')).map(e=>({name:e.name,time:e.startTime})),requests:performance.getEntriesByType('resource').filter(e=>e.initiatorType==='fetch').map(e=>({url:new URL(e.name).pathname,start:e.startTime,duration:e.duration}))};
});
try {
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled',{cacheDisabled:true});
  await page.setViewportSize({width:1076,height:900});
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await page.goto(params('portfolio','dark'),{waitUntil:'domcontentloaded',timeout:120000});
  await settled();
  assert.equal(await page.locator('h1').first().innerText(),'Portfolio');
  const families = ['portfolio','notifications','profile','own-profile','connections','home','presales','terms','create','invites','competitions'];
  const transitionFamilies = new Set(['portfolio','notifications','profile','own-profile','connections']);
  for(const surface of families) {
    for(let run=1;run<=3;run++) {
      if(results.recordings.some(row=>row.surface===surface&&row.run===run)) continue;
      // Each recording starts on a fresh document with the browser cache explicitly disabled and cleared.
      await page.goto('about:blank');
      await client.send('Network.clearBrowserCache');
      const throttled = run === 3;
      await client.send('Network.emulateNetworkConditions',{offline:false,latency:throttled?120:0,downloadThroughput:throttled?6*1024*1024:-1,uploadThroughput:throttled?1024*1024:-1});
      const name=`cold-${surface}-${run}`;
      const frames=[];
      const saves=[];
      const frame=({data,metadata,sessionId})=>{
        void client.send('Page.screencastFrameAck',{sessionId}).catch(()=>{});
        if(frames.length>=14)return;
        const file=`${name}-frame-${String(frames.length).padStart(2,'0')}.jpg`;
        frames.push({file,metadata});saves.push(writeFile(`${output}/${file}`,Buffer.from(data,'base64')));
      };
      client.on('Page.screencastFrame',frame);
      await client.send('Page.startScreencast',{format:'jpeg',quality:60,maxWidth:1076,maxHeight:900,everyNthFrame:1});
      const started=Date.now();
      let navigationError;
      const navigation=page.goto(params(surface,'dark',transitionFamilies.has(surface)?{transition:'empty'}:{}),{waitUntil:'domcontentloaded',timeout:120000}).catch(error => { navigationError = error; });
      const snapshots=[];
      for(const target of [100,250,500,1000,2000]) {
        await new Promise(resolve=>setTimeout(resolve,Math.max(0,started+target-Date.now())));
        snapshots.push({target,elapsed:Date.now()-started,measurement:await measure().catch(()=>null)});
      }
      await navigation;
      if (navigationError) throw navigationError;
      await settled(transitionFamilies.has(surface));
      await page.waitForTimeout(200);
      await page.screenshot({path:`${output}/${name}-settled.png`,animations:"allow"});
      await client.send('Page.stopScreencast');client.off('Page.screencastFrame',frame);await Promise.all(saves);
      const measurement=await measure();
      const ax=await client.send('Accessibility.getFullAXTree');
      const accessible=ax.nodes.filter(n=>!n.ignored).map(n=>({role:n.role?.value,name:n.name?.value}));
      await writeFile(`${output}/${name}-accessibility.json`,JSON.stringify(accessible,null,2));
      results.recordings.push({surface,run,throttled,cacheDisabled:true,frames,snapshots,measurement});
      await writeFile(`${output}/refresh-results.json`,JSON.stringify(results,null,2));
      console.log(`Recorded ${surface} ${run}: ${frames.length} compositor frames`);
    }
  }
  await client.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await client.send('Network.setCacheDisabled',{cacheDisabled:false});
  const surfaces = ['portfolio','notifications','profile','own-profile','connections','home','presales','terms','create','invites','competitions','holders'];
  for(const surface of surfaces) {
    await page.goto(params(surface,'light',{variant:surface==='create'?'blank-review':'empty'}),{waitUntil:'domcontentloaded',timeout:60000});
    await settled();
    for(const theme of ['light','dark']) for(const width of [320,407,768,1054,1076,1414]) {
    if(results.captures.some(row=>row.surface===surface&&row.theme===theme&&row.width===width)) continue;
    await page.setViewportSize({width,height:850});await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    await page.locator('[data-blast-ui]').evaluate((node,theme)=>node.setAttribute('data-theme',theme),theme);
    await settled();
    await page.screenshot({path:`${output}/${surface}-${theme}-${width}.png`,animations:'allow'});
    results.captures.push({surface,theme,width,measurement:await measure()});
    await writeFile(`${output}/refresh-results.json`,JSON.stringify(results,null,2));
    }
    console.log(`Responsive captures: ${surface}, both themes at six widths`);
  }
  await page.setViewportSize({width:1076,height:900});
  for(const surface of ['portfolio','notifications','profile']) for(const variant of ['loading','error','populated']) {
    if(surface === 'profile' && variant === 'error') continue;
    await page.goto(params(surface,'dark',{variant}),{waitUntil:'domcontentloaded'});await settled();
    await page.screenshot({path:`${output}/${surface}-${variant}.png`,animations:'allow'});
    results.captures.push({surface,variant,measurement:await measure()});
  }
} finally {
  await writeFile(`${output}/refresh-results.json`,JSON.stringify(results,null,2));
  await client.detach();
  await browser.close();
}
