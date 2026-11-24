import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const out = process.env.TRADING_EVIDENCE_DIR;
const browser = await chromium.connectOverCDP(process.env.TRADING_CDP_URL);
const page = browser.contexts()[0].pages().find(p => p.url().includes('/trading-proof'));
const report = { themes: [], accessibility: [], errors: [] };
page.on('pageerror', error => report.errors.push(error.message));
const sheet = () => page.getByRole('dialog');
const edit = () => page.getByRole('button', { name: 'Edit amount presets' }).filter({ visible: true });
const close = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[role="dialog"]')); };
const theme = value => page.evaluate(t => { const root = document.querySelector('[data-blast-ui]'); if (t) root.setAttribute('data-theme', t); else root.removeAttribute('data-theme'); }, value);
const measure = async locator => locator.evaluateAll(elements => {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const rgba = value => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v); };
  const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1);
  const lum = c => c.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((v, n, i) => v + n * [.2126, .7152, .0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  return elements.filter(e => e.checkVisibility() && !e.disabled).map(e => {
    let bg = [255, 255, 255, 1]; const ancestors = [];
    for (let n = e; n; n = n.parentElement) ancestors.push(n);
    for (const n of ancestors.reverse()) bg = over(rgba(getComputedStyle(n).backgroundColor), bg);
    const style = getComputedStyle(e);
    return { text: e.value || e.textContent.trim().slice(0, 60), ratio: ratio(over(rgba(style.color), bg), bg), focus: e.matches(':focus-visible') ? { color: style.outlineColor, width: style.outlineWidth, ratio: ratio(rgba(style.outlineColor), rgba(getComputedStyle(e.closest('[role="dialog"]')).backgroundColor)) } : null };
  });
});
try {
  const cdp = await page.context().newCDPSession(page);
  await page.setViewportSize({ width: 1414, height: 1000 });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Exit Esc', exact: true }).focus();
  await page.keyboard.press('q'); await page.keyboard.press('1');
  await page.waitForFunction(() => !document.querySelector('[data-coin-submit]')?.disabled);
  for (const mode of ['light', 'dark']) {
    await theme(mode); await page.evaluate(() => { document.activeElement?.blur(); document.querySelectorAll('[data-workspace-host] *').forEach(e => { if (e.scrollTop) e.scrollTop = 0; }); }); await page.mouse.move(0, 0); await page.waitForTimeout(250);
    await page.screenshot({ path: `${out}/terminal-${mode}.png` });
    await edit().focus(); await page.keyboard.press('Enter'); await sheet().waitFor(); await page.waitForTimeout(300);
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    const inputs = sheet().locator('input');
    // Keyboard focus is checked explicitly on the first amount field.
    await inputs.first().focus();
    assert.equal(await inputs.first().evaluate(e => e.matches(':focus-visible')), true);
    const rows = await measure(sheet().locator('input,button,legend,h2,p,label > span'));
    assert.ok(rows.every(r => r.ratio >= 4.5), JSON.stringify(rows.filter(r => r.ratio < 4.5)));
    assert.ok(rows.some(r => r.focus?.ratio >= 3 && r.focus.width === '2px'));
    await page.screenshot({ path: `${out}/focus-${mode}.png` });
    await sheet().locator('h2').click(); await page.mouse.move(0, 0);
    await page.screenshot({ path: `${out}/editor-${mode}.png`, clip: { x: 407, y: 180, width: 600, height: 640 } });
    const save = sheet().getByRole('button', { name: 'Save presets' });
    await save.hover(); await page.waitForTimeout(150);
    const hover = await measure(save); assert.ok(hover[0].ratio >= 4.5, JSON.stringify(hover));
    await close(); assert.equal(await edit().evaluate(e => e === document.activeElement), true);
    report.themes.push({ mode, rows, hover });
  }
  for (const mode of ['light', 'dark']) for (const width of [320, 407, 768, 1054, 1414]) {
    await page.setViewportSize({ width, height: 1000 }); await theme(mode);
    await edit().scrollIntoViewIfNeeded(); await edit().focus(); await page.keyboard.press('Enter'); await sheet().waitFor();
    for (const feature of ['prefers-reduced-motion', 'prefers-reduced-transparency', 'prefers-contrast']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: feature, value: feature === 'prefers-contrast' ? 'more' : 'reduce' }] });
      assert.equal(await page.evaluate(name => matchMedia(`(${name}: ${name === 'prefers-contrast' ? 'more' : 'reduce'})`).matches, feature), true);
      await sheet().getByLabel('Buy preset 1', { exact: true }).focus();
      const state = await sheet().evaluate(e => ({ width: innerWidth, overflow: e.scrollWidth > e.clientWidth, docOverflow: document.documentElement.scrollWidth > innerWidth, focus: document.activeElement.matches(':focus-visible'), blur: getComputedStyle(e.closest('[data-sheet-scrim]')).backdropFilter, border: getComputedStyle(e.querySelector('input')).borderTopColor }));
      assert.equal(state.overflow || state.docOverflow, false); assert.equal(state.focus, true);
      if (feature === 'prefers-reduced-transparency') assert.equal(state.blur, 'none');
      if (feature === 'prefers-contrast') assert.notEqual(state.border, 'rgba(0, 0, 0, 0)');
      report.accessibility.push({ mode, width, feature, ...state });
    }
    await close(); await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  }
  await page.setViewportSize({ width: 1414, height: 1000 });
  for (const system of ['light', 'dark']) {
    await theme(null); await page.emulateMedia({ colorScheme: system }); await edit().click(); await sheet().waitFor();
    const bg = await sheet().getByRole('button', { name: 'Save presets' }).evaluate(e => getComputedStyle(e).backgroundColor);
    assert.equal(bg, system === 'light' ? 'rgb(214, 27, 112)' : 'rgb(255, 76, 152)');
    await close(); report.accessibility.push({ systemTheme: system, actionBackground: bg });
  }
  await theme('light'); await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  assert.deepEqual(report.errors, []);
  writeFileSync(`${out}/pink-accessibility.json`, JSON.stringify(report, null, 2));
  console.log('PASS pink button/text/focus contrast, normal-motion focus return, 30 accessibility states, system light/dark and final captures');
} catch (error) { await page.screenshot({ path: `${out}/pink-failure.png` }); throw error; }
finally { await browser.close(); }
