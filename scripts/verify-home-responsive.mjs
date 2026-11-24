// Responsive geometry regression: real rendered Home, including the former 761–940px collision.
import fs from "node:fs/promises";
// Attach to an existing task-owned Chrome tab; never creates another browser.
// Usage: node scripts/verify-home-responsive.mjs CDP_PORT HOME_URL OUTPUT_DIRECTORY
const [port, homeUrl, outputDirectory] = process.argv.slice(2);
if (!port || !homeUrl || !outputDirectory)
  throw Error("Expected CDP_PORT HOME_URL OUTPUT_DIRECTORY");
await fs.mkdir(outputDirectory, { recursive: true });
const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
  r.json(),
);
const tab = tabs.find((t) => t.type === "page" && t.url === homeUrl);
if (!tab) throw Error("Task-owned fixture tab not found");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  }
  if (m.method === "Runtime.exceptionThrown")
    errors.push(m.params.exceptionDetails);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const size = async (width, height) => {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait(100);
};
const screenshot = async (name, full = false) => {
  const metrics = await send("Page.getLayoutMetrics");
  const s = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: full,
    ...(full
      ? {
          clip: {
            x: 0,
            y: 0,
            width: metrics.cssContentSize.width,
            height: metrics.cssContentSize.height,
            scale: 1,
          },
        }
      : {}),
  });
  await fs.writeFile(
    `${outputDirectory}/${name}.png`,
    Buffer.from(s.data, "base64"),
  );
};
const close = () => ws.close();
await send("Runtime.enable");
await send("Page.enable");

const measure = `(()=>{
 const rect=e=>e.getBoundingClientRect(), visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const overlaps=[]; const outside=[]; const rows=[...document.querySelectorAll('[data-section] article, [class*="__holdingRow"], [class*="__coinToolbar"], [class*="__headControls"]')];
 for(const row of rows){
  const cells=[...row.children].flatMap(c=>getComputedStyle(c).display==='contents'?[...c.children]:[c]).filter(c=>visible(c)&&rect(c).width>1&&rect(c).height>1);
  for(const c of cells){const b=rect(c),r=rect(row);if(b.left<r.left-1||b.right>r.right+1||b.top<r.top-1||b.bottom>r.bottom+1)outside.push(c.className);}
  for(let i=0;i<cells.length;i++)for(let j=i+1;j<cells.length;j++){const a=rect(cells[i]),b=rect(cells[j]);if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlaps.push([cells[i].className,cells[j].className]);}
 }
 const create=[...document.querySelectorAll('button[aria-label="Create"]')].filter(visible);
 return {width:innerWidth,height:innerHeight,home:rect(document.querySelector('[class*="_home"]')).width,overflow:document.documentElement.scrollWidth>innerWidth,overlaps,outside,coinHeights:[...document.querySelectorAll('[data-section="coins"] article')].map(r=>rect(r).height),create:create.length,createTargets:create.map(c=>({width:rect(c).width,height:rect(c).height,current:c.hasAttribute('aria-current')})),presales:document.querySelectorAll('article[data-sale]').length,traders:document.querySelectorAll('article[class*="traderCols"]').length};
})()`;
await evaluate(
  `document.querySelectorAll('article button[aria-expanded="true"]').forEach(b=>b.click())`,
);
await wait(200);
const ready = await evaluate(
  `!!document.querySelector('[data-section="coins"] article') && !!document.querySelector('article[data-sale]') && !!document.querySelector('[data-section="traders"] article')`,
);
if (!ready) {
  close();
  throw Error(
    "Load a Home fixture with coins, an open presale and a populated trader before running",
  );
}
const initialRail = await evaluate(
  `document.querySelector('[data-blast-ui]').getAttribute('data-rail')`,
);
const results = [];
for (const [w, h] of [
  [320, 812],
  [375, 812],
  [407, 850],
  [640, 850],
  [555, 850],
  [556, 850],
  [557, 850],
  [759, 900],
  [760, 900],
  [761, 900],
  [768, 1024],
  [891, 900],
  [892, 900],
  [893, 900],
  [900, 900],
  [939, 900],
  [940, 900],
  [941, 900],
  [991, 900],
  [992, 900],
  [993, 900],
  [1024, 768],
  [1054, 900],
  [1119, 900],
  [1120, 900],
  [1163, 900],
  [1164, 900],
  [1165, 900],
  [1166, 900],
  [1280, 800],
  [1414, 900],
  [1440, 900],
  [1920, 1080],
]) {
  await size(w, h);
  await evaluate("window.scrollTo(0,0)");
  for (const rail of ["full", "mini"]) {
    await evaluate(
      `document.querySelector('[data-blast-ui]').setAttribute('data-rail','${rail}')`,
    );
    await wait(100);
    const result = { rail, ...(await evaluate(measure)) };
    results.push(result);
    if (
      result.overflow ||
      result.overlaps.length ||
      result.outside.length ||
      result.create !== 1
    )
      console.log("FAIL", JSON.stringify(result));
  }
  if ([375, 407, 768, 900, 1440, 1920].includes(w)) {
    await evaluate(
      `document.querySelector('[data-blast-ui]').setAttribute('data-rail','full')`,
    );
    await wait(100);
    await screenshot(`home-${w}`, true);
  }
}
await size(375, 812);
await evaluate(
  `[...document.querySelectorAll('article button[aria-expanded="false"]')].forEach(b=>b.click())`,
);
await wait(600);
for (const w of [375, 407, 640, 768, 900, 1024, 1280, 1440, 1920]) {
  await size(w, 900);
  const result = { expanded: true, ...(await evaluate(measure)) };
  results.push(result);
  if (result.overflow || result.overlaps.length || result.outside.length)
    console.log("FAIL EXPANDED", JSON.stringify(result));
  if ([375, 768, 1440].includes(w)) await screenshot(`expanded-${w}`, true);
}
await fs.writeFile(
  `${outputDirectory}/matrix.json`,
  JSON.stringify({ results, errors }, null, 2),
);
await evaluate(
  `document.querySelectorAll('article button[aria-expanded="true"]').forEach(b=>b.click());document.querySelector('[data-blast-ui]').setAttribute('data-rail',${JSON.stringify(initialRail)});window.scrollTo(0,0)`,
);
close();
const failed = results.filter(
  (r) =>
    r.overflow ||
    r.overlaps.length ||
    r.outside.length ||
    r.create !== 1 ||
    r.createTargets.some((t) => t.current || t.width < 44 || t.height < 44),
);
console.log(
  `Checked ${results.length} layouts; ${failed.length} failures; ${errors.length} runtime errors.`,
);
if (failed.length || errors.length) process.exitCode = 1;
