import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Linter } from 'eslint';
import { fixedSleepSyntax } from './eslint/non-web.mjs';
import allowed from './eslint/fixed-sleeps-allowed.json' with { type: 'json' };

const lint = (code) => new Linter().verify(code, [{
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  rules: { 'no-restricted-syntax': ['error', ...fixedSleepSyntax] },
}]).length;

test('fixed sleeps are flagged; waiting for a condition is not', () => {
  assert.equal(lint('await new Promise(resolve => setTimeout(resolve, 25));'), 1);
  assert.equal(lint('await new Promise(resolve => window.setTimeout(resolve, 25));'), 1);
  assert.equal(lint('import { setTimeout as delay } from "node:timers/promises";'), 1);
  assert.equal(lint('const { setTimeout: delay } = await import("node:timers/promises");'), 1);
  assert.equal(lint('await waitFor(() => ready(), "ready"); setTimeout(tick, 0);'), 0);
});

test('the allow list only shrinks: sorted, and every file still sleeps', () => {
  assert.deepEqual(allowed, [...allowed].sort(), 'keep fixed-sleeps-allowed.json sorted');
  for (const file of allowed) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /new Promise[^;]*setTimeout|timers\/promises/, `${file} no longer sleeps: remove it from fixed-sleeps-allowed.json`);
  }
});
