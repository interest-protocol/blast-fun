import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// This fails if web-config.ts (or anything it imports) stops loading under
// plain Node: a `server-only` import, an `@/` or `#web/` alias, or TypeScript
// that type stripping cannot erase. The Vercel build gate (runtime.mjs) loads
// it that way, so such a change would fail every production build.
test('the build gate loads web-config.ts under plain Node, with no hooks or flags', () => {
  const source = `
    const { parseWebConfig } = await import(${JSON.stringify(new URL('../../src/lib/web-config.ts', import.meta.url).href)});
    const config = parseWebConfig({ BLAST_DEPLOYMENT_TARGET: 'develop', BLAST_DEPLOYMENT_BRANCH: 'ci-fixture', NODE_ENV: 'production' });
    process.stdout.write(JSON.stringify({ gate: config.gate, siteOrigin: config.relay.siteOrigin }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    gate: { keys: null, cronSecret: null },
    siteOrigin: 'https://www.blast.fun',
  });
});
