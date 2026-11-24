import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Linter } from 'eslint';
import { sharedPatterns } from './eslint/shared-patterns.mjs';
import cssLegacy from './shared-patterns-css-legacy.json' with { type: 'json' };

function lint(code, filename = 'apps/web/src/components/NewFeature.tsx') {
  return new Linter().verify(code, [{
    files: ['**/*.tsx'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'blast-ui': { rules: { 'shared-patterns': sharedPatterns } } },
    rules: { 'blast-ui/shared-patterns': 'error' },
  }], { filename });
}

test('new screens use the shared tabs, empty state and dropdown trigger', () => {
  assert.equal(lint('const x = <Segmented label="Source" options={[]} value="a" onChange={f} />').length, 0);
  assert.equal(lint('const x = <div className="seg" role="tablist" />').at(0)?.messageId, 'seg');
  assert.equal(lint('const x = <div className={clsx("seg", styles.sources)} />').at(0)?.messageId, 'seg');
  assert.equal(lint('const x = <div className={`card empty ${styles.pad}`} />').at(0)?.messageId, 'empty');
  assert.equal(lint('const x = <svg><path d="m6 9 6 6 6-6" /></svg>').at(0)?.messageId, 'chevron');
  assert.equal(lint('import { SegThumb } from "#web/components/blast-ui/SegThumb.tsx";').at(0)?.messageId, 'thumb');
  assert.equal(lint('const x = <div role="tablist" aria-label="Views" />').at(0)?.messageId, 'tablist');
  // Words that merely contain the class names are fine.
  assert.equal(lint('const x = <div className="segment emptyRow" />').length, 0);
});

test('the primitives themselves own the markup', () => {
  const file = 'apps/web/src/components/blast-ui/Segmented.tsx';
  assert.equal(lint('import { SegThumb } from "./SegThumb"; const x = <div className="seg" />', file).length, 0);
});

const SOURCE = new URL('../apps/web/src/', import.meta.url);
// Separate shells keep their own themes.
const SKIP = /^(components\/(launchpad|mission-control)|app\/\((mission-control|launchpad)\))\//;
const SELECTED = /aria-(selected|current|pressed)|:checked|\[data-(selected|active)\]|\.(on|active|selected)\b/;
const PINK = /var\(--(pink(-soft|-soft-2|-text|-line|-ink)?|action)\)|#ff4c98|#d61b70|#c0125e|#ff80b8/i;
// Corners come from the approved boards' radius scale (3–26px, now rem: px / 16), the shared
// --r-* roles, a pill (999px) or a circle; anything else is an arbitrary value.
const BOARD_RADII = /^(0\.125|0\.1875|0\.25|0\.3125|0\.375|0\.4375|0\.5|0\.5625|0\.625|0\.6875|0\.75|0\.8125|0\.875|0\.9375|1|1\.0625|1\.125|1\.25|1\.375|1\.5|1\.625)rem$/;
const ROLE_SAFE = { test: (part) => BOARD_RADII.test(part) || /^(0|[1-4]px|999px|62\.4375rem|50%|inherit|var\(--r-[a-z-]+\)|calc\(.*\))$/.test(part) };

async function modules() {
  const files = await readdir(SOURCE, { recursive: true });
  return files.map((file) => file.replaceAll('\\', '/')).filter((file) => file.endsWith('.module.css') && !SKIP.test(file));
}

function rules(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);
}

test('selected, current and pressed states are never pink (only ledgered legacy remains)', async () => {
  const over = [];
  for (const file of await modules()) {
    if (file.startsWith('components/blast-ui/')) continue;
    const css = await readFile(new URL(file, SOURCE), 'utf8');
    const count = rules(css).filter(([selector, body]) => SELECTED.test(selector) && PINK.test(body.replace(/--[\w-]+\s*:[^;]*;/g, ''))).length;
    const allowed = cssLegacy.pinkSelection[file] ?? 0;
    if (count > allowed) over.push(`${file}: ${count} > ${allowed}`);
  }
  assert.deepEqual(over, []);
});

test('corners use the shared radius roles (only ledgered legacy remains)', async () => {
  const over = [];
  for (const file of await modules()) {
    const css = await readFile(new URL(file, SOURCE), 'utf8');
    let count = 0;
    for (const [, body] of rules(css)) {
      for (const [, value] of body.matchAll(/border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+)/g)) {
        count += value.trim().replace(/\s*!important$/, '').split(/\s+(?![^(]*\))/).filter((part) => !ROLE_SAFE.test(part)).length;
      }
    }
    const allowed = cssLegacy.radius[file] ?? 0;
    if (count > allowed) over.push(`${file}: ${count} > ${allowed}`);
  }
  assert.deepEqual(over, []);
});

// Touch rules keep physical px (44px targets, 16px input text so iOS never zooms, hit-area insets).
function withoutCoarseBlocks(css) {
  let out = css;
  for (let start = out.search(/@media[^{]*pointer:\s*coarse[^{]*\{/); start !== -1; start = out.search(/@media[^{]*pointer:\s*coarse[^{]*\{/)) {
    let depth = 0;
    let end = out.indexOf('{', start);
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++;
      else if (out[end] === '}' && --depth === 0) break;
    }
    out = out.slice(0, start) + out.slice(end + 1);
  }
  return out;
}

test('lengths are rem so every page keeps the board proportions at any width', async () => {
  // 16px = 1rem at the 1440px board; px stays only for hairlines (<= 1.5px), media queries and 44/48px touch minimums.
  const files = [...(await modules()).filter((file) => !file.startsWith('components/legal/')), 'components/blast-ui/blast-ui.css'];
  const over = [];
  for (const file of files) {
    const css = withoutCoarseBlocks(await readFile(new URL(file, SOURCE), 'utf8'));
    for (const [selector, body] of rules(css)) {
      for (const [length, px] of body.matchAll(/(-?\d*\.?\d+)px\b/g)) {
        const value = Math.abs(Number(px));
        if (value > 1.5 && value !== 44 && value !== 48) over.push(`${file} ${selector.split('\n').pop().trim().slice(0, 60)}: ${length}`);
      }
    }
  }
  assert.deepEqual(over, []);
});
