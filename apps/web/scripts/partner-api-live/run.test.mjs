import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { uiOnlyFeaturePreview } from './runtime.mjs';

const FEATURE = { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/some-feature' };
const DEVELOP = { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'develop', VERCEL_GIT_COMMIT_REF: 'develop' };
const PRODUCTION = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' };
const TOKEN = 't'.repeat(40);

test('every generic feature preview is UI-only; develop and production are not', () => {
  assert.equal(uiOnlyFeaturePreview(FEATURE), true);
  assert.equal(uiOnlyFeaturePreview({ ...FEATURE, PRESALE_ADMIN_TOKEN: TOKEN }), true, 'a token never turns a branch build into the live check');
  assert.equal(uiOnlyFeaturePreview(DEVELOP), false, 'the custom develop environment always runs the live check');
  assert.equal(uiOnlyFeaturePreview({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'x' }), true, 'with no stated target, VERCEL_ENV is the target');
  assert.equal(uiOnlyFeaturePreview(PRODUCTION), false);
  assert.equal(uiOnlyFeaturePreview({}), false, 'a local run is not a preview');
});

/** The build's own command, `check:partner-live -- --built`, with only the given variables. */
function runBuilt(environment) {
  const run = fileURLToPath(new URL('./run.mjs', import.meta.url));
  return spawnSync(process.execPath, ['--no-warnings', run, '--built'], {
    env: { PATH: process.env.PATH, ...environment }, encoding: 'utf8', timeout: 60_000,
  });
}

test('a UI-only feature preview build publishes, recorded as skipped and never as passed', () => {
  const result = runBuilt(FEATURE);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.deepEqual(report, { gate: 'partner-api-live', skipped: 'ui_only_feature_preview', target: 'preview', commit: null });
  assert.equal('passed' in report, false);
});

test('a feature preview build given an operator credential fails without running anything', () => {
  for (const credential of [{ PRESALE_ADMIN_TOKEN: TOKEN }, { PRESALE_ADMIN_TOKEN: '' }, { CRON_SECRET: TOKEN }]) {
    const result = runBuilt({ ...FEATURE, ...credential });
    assert.equal(result.status, 1, Object.keys(credential)[0]);
    const report = JSON.parse(result.stderr.trim().split('\n').at(-1));
    assert.deepEqual([report.passed, report.failure.stage, report.failure.category], [false, 'preflight', 'preview_operator_credential']);
    assert.equal(`${result.stdout}${result.stderr}`.includes(TOKEN), false, 'the value is never printed');
    assert.equal(result.stdout.includes('skipped'), false);
  }
});

test('develop and production still fail closed without their full configuration', () => {
  for (const environment of [DEVELOP, PRODUCTION]) {
    const result = runBuilt(environment);
    assert.equal(result.status, 1, `${environment.VERCEL_TARGET_ENV} must not publish without the live check`);
    const report = JSON.parse(result.stderr.trim().split('\n').at(-1));
    assert.equal(report.passed, false);
    assert.equal(report.failure.stage, 'preflight');
    assert.equal(result.stdout.includes('skipped'), false);
  }
});
