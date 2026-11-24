import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:42929/parity-proof';
const output = process.env.REFRESH_EVIDENCE_DIR;
assert.ok(output && process.env.REFRESH_CDP_URL);
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.REFRESH_CDP_URL, { noDefaults: true });
const page = browser.contexts()[0].pages()[0];
const cdp = await page.context().newCDPSession(page);
await page.bringToFront();
page.setDefaultTimeout(60000);
const allSurfaces = ['following', 'saved', 'invites', 'follow-status', 'connections-follow'];
const surfaces = process.env.REFRESH_SURFACES?.split(',') ?? allSurfaces;
const results = process.env.REFRESH_SURFACES ? JSON.parse(await readFile(`${output}/results.json`, 'utf8')) : { environment: 'Local synthetic component fixtures; no live account or financial action', captures: [], errors: [] };
results.captures = results.captures.filter(capture => !surfaces.includes(capture.surface));
results.captures.forEach(capture => { capture.pointer ??= 'fine'; });
delete results.geometryPassed;
page.on('pageerror', error => results.errors.push({ url: page.url(), message: error.message }));
const readyFollowStatus = async variant => {
  const name = variant === 'empty'
    ? 'Following @nova. Unfollow'
    : variant === 'error'
      ? 'Relationship unavailable. Retry status for @nova'
      : 'Checking follow status for @nova';
  await page.getByRole('button', { name, exact: true }).waitFor();
};
const ready = async (surface, variant) => {
  await page.waitForFunction(() => performance.getEntriesByName('fixture-hydrated').length > 0);
  if (surface === 'invites') {
    await page.getByRole('heading', { name: 'People you invited' }).waitFor();
    if (variant === 'empty') await page.getByText('No qualifying activity yet', { exact: true }).waitFor();
    if (variant === 'error') await page.getByText('Invite totals unavailable', { exact: true }).waitFor();
  } else if (surface === 'follow-status' || surface === 'connections-follow') {
    await readyFollowStatus(variant);
  } else if (variant === 'populated') {
    await page.locator('[class*="personalResult"] ol > li').first().waitFor();
  } else if (variant === 'empty') {
    await page.getByText(surface === 'saved' ? 'Nothing saved yet' : 'You’re not following anyone yet', { exact: true }).waitFor();
  } else if (variant === 'error') {
    await page.getByRole('alert').last().waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
};
try {
  for (const surface of surfaces) {
    for (const variant of [...(surface === 'connections-follow' ? [] : ['loading']), 'data-pending', 'empty', 'error', ...(['following', 'saved'].includes(surface) ? ['populated'] : [])]) {
      await page.goto(`${base}?${new URLSearchParams({ surface, variant, shell: 'member', theme: 'light' })}`, { waitUntil: 'domcontentloaded' });
      await ready(surface, variant);
      for (const pointer of ['fine', ...(['invites', 'connections-follow'].includes(surface) ? ['coarse'] : [])]) for (const theme of ['light', 'dark']) for (const width of [320, 407, 768, 1054, 1414]) {
        await page.setViewportSize({ width, height: 900 });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: pointer === 'coarse', maxTouchPoints: 1 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        await page.locator('[data-blast-ui]').evaluate((node, value) => node.setAttribute('data-theme', value), theme);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measurement = await page.evaluate(() => {
          const box = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; };
          const follow = document.querySelector('main button[aria-label*="@nova"]');
          return { width:innerWidth, scrollWidth:document.documentElement.scrollWidth, coarse:matchMedia('(pointer: coarse)').matches, result:box('[class*="personalResult"]'), summary:box('section[aria-label="Your invites"],section[aria-label="Loading your invites"]'), listHeading:box('#invitees-heading'), follow:box('main button[aria-label*="@nova"]'), followTextFits:follow ? follow.scrollWidth <= follow.clientWidth : null, tableHead:box('[class*="personalResult"] [class*="listHead"]'), tableEnd:box('[class*="personalResult"] [data-table-end]') };
        });
        assert.equal(measurement.width, width);
        assert.ok(measurement.scrollWidth <= width, `${surface} ${variant} overflows at ${width}`);
        assert.equal(measurement.coarse, pointer === 'coarse');
        if (surface === 'connections-follow') {
          assert.ok(measurement.follow.height >= 44, 'Connection action touch height');
          assert.ok(measurement.followTextFits, 'Connection action text overflows');
        }
        if (variant === 'populated') {
          assert.ok(measurement.tableHead.height < 100, `${surface} inflated table header`);
          assert.ok(measurement.tableEnd.height < 140, `${surface} inflated table footer`);
        }
        const file = `${surface}-${variant}-${theme}-${width}${pointer === 'coarse' ? '-touch' : ''}.png`;
        await page.screenshot({ path:`${output}/${file}`, animations:'allow' });
        results.captures.push({ surface, variant, theme, width, pointer, file, measurement });
      }
      await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
      console.log(`${surface} ${variant}: five widths, both themes`);
    }
  }
  for (const surface of allSurfaces) for (const pointer of ['fine', ...(['invites', 'connections-follow'].includes(surface) ? ['coarse'] : [])]) for (const theme of ['light', 'dark']) for (const width of [320, 407, 768, 1054, 1414]) {
    const samples = results.captures.filter(x => x.surface === surface && x.theme === theme && x.width === width && x.pointer === pointer && x.variant !== 'populated');
    assert.equal(samples.length, surface === 'connections-follow' ? 3 : 4, `${surface} ${pointer} state coverage`);
    const boxKey = surface === 'invites' ? 'summary' : surface === 'follow-status' || surface === 'connections-follow' ? 'follow' : 'result';
    const before = samples[0].measurement[boxKey];
    assert.ok(before, `${surface} measurement missing`);
    for (const sample of samples.slice(1)) {
      const after = sample.measurement[boxKey];
      for (const dimension of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[dimension] - after[dimension]) <= 1, `${surface} ${sample.variant} ${width} ${dimension}: ${before[dimension]} -> ${after[dimension]}`);
      if (surface === 'invites') assert.ok(Math.abs(samples[0].measurement.listHeading.y - sample.measurement.listHeading.y) <= 1, `Invites heading moved at ${width}`);
    }
  }
  assert.deepEqual(results.errors, []);
  results.geometryPassed = true;
  console.log('PASS: pending, empty and failure anchors');
} finally {
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
