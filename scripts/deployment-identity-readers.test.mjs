import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const OWNER = 'packages/core/src/lib/config/deployment-identity.ts';
const READER = /\bVERCEL_(?:ENV|TARGET_ENV|GIT_COMMIT_REF)\b/;
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const TEST = /\.test\.|\/test\//;

test('only deployment-identity.ts reads the Vercel identity variables', () => {
  const files = execFileSync('git', ['ls-files', 'apps', 'packages', 'scripts'], { encoding: 'utf8' })
    .split('\n')
    .filter((file) => SOURCE.test(file) && !TEST.test(file) && file !== OWNER);
  const readers = files.filter((file) => READER.test(readFileSync(file, 'utf8')));

  assert.deepEqual(readers, []);
});
