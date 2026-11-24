import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { readFile } from 'node:fs/promises';
import { createCleanup } from './cleanup.mjs';
import { PARTNER } from './check.mjs';

const url = new URL(process.env.MISSION_CONTROL_TEST_DATABASE_URL);
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/mission_control_test');
const admin = new Client({ connectionString: url.href });
await admin.connect();
// The disposable runner installs the chain fixture and roles; this focused suite
// installs the same checked-in partner schema used by the release cleanup owner.
for (const migration of ['0124_partner_api_keys', '0127_partner_key_tiers', '0128_partner_release_fixture_cleanup']) {
  await admin.query(await readFile(new URL(
    `../../../../packages/core/src/modules/database/migrations/${migration}.up.sql`, import.meta.url), 'utf8'));
}
await admin.query("CREATE ROLE partner_cleanup_test LOGIN PASSWORD 'disposable-test'");
await admin.query('GRANT blast_web TO partner_cleanup_test');
url.username = 'partner_cleanup_test';
const cleanup = createCleanup(url.href);
const concurrentCleanup = createCleanup(url.href);
const runtime = new Client({ connectionString: url.href });
await runtime.connect();
const fixtures = new Map();
async function fixture(name, { age = 0, partner, label, empty = false } = {}) {
  const runId = randomUUID();
  const item = { partner: partner ?? `${PARTNER}-${runId}`, label: label ?? `release-gate:${runId}`, id: randomUUID() };
  await admin.query(`INSERT INTO partner_api_partners(id,created_by,updated_by,created_at)
    VALUES ($1,'operator:test','operator:test',now()-make_interval(secs=>$2))`, [item.partner, age]);
  if (!empty) await admin.query(`INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by,created_at)
    VALUES ($1,$2,$3,$4,'operator:test',now()-make_interval(secs=>$5))`,
  [item.id, item.partner, item.label, randomBytes(32), age]);
  fixtures.set(name, item);
  return item;
}
async function present(name) {
  return (await admin.query('SELECT 1 FROM partner_api_partners WHERE id=$1', [fixtures.get(name).partner])).rowCount === 1;
}
try {
  const current = await fixture('current');
  const fixtureId = current.label.slice('release-gate:'.length);
  assert.equal(await cleanup.claim(fixtureId), true);
  assert.equal(await concurrentCleanup.claim(fixtureId), false);
  assert.equal(await cleanup.prove(current.partner), true);
  assert.equal(await cleanup.prove(`${PARTNER}-${randomUUID()}`), false);
  const concurrent = await fixture('concurrent');
  await fixture('stale', { age: 7200 });
  await fixture('orphan', { age: 7200, empty: true });
  await fixture('manual', { age: 7200, label: 'manual-key' });
  const real = await fixture('real', { age: 7200, partner: 'real-partner', label: current.label });
  await cleanup.stale();
  assert.equal(await present('stale'), false); assert.equal(await present('orphan'), false);
  for (const name of ['current', 'concurrent', 'manual', 'real']) assert.equal(await present(name), true);
  await cleanup.run(current.label); await cleanup.run(current.label);
  await cleanup.release();
  assert.equal(await concurrentCleanup.claim(fixtureId), true);
  await concurrentCleanup.release();
  assert.equal(await present('current'), false);
  assert.equal((await admin.query('SELECT 1 FROM partner_api_key_policy_events WHERE key_id=$1', [current.id])).rowCount, 0);
  for (const name of ['concurrent', 'manual', 'real']) assert.equal(await present(name), true);
  await assert.rejects(cleanup.run('manual-key'), /Primary cleanup unavailable/);
  await assert.rejects(cleanup.run(fixtures.get('manual').label), /Primary cleanup unavailable/);
  const orphan = await fixture('lost-create', { empty: true });
  await cleanup.run(orphan.label); assert.equal(await present('lost-create'), false);
  await runtime.query('BEGIN');
  try {
    await assert.rejects(runtime.query('DELETE FROM partner_api_keys WHERE id=$1', [real.id]), /permission denied/);
  } finally { await runtime.query('ROLLBACK'); }
  await runtime.query('BEGIN');
  try {
    await assert.rejects(runtime.query('DELETE FROM partner_api_key_policy_events WHERE key_id=$1', [real.id]), /permission denied/);
  } finally { await runtime.query('ROLLBACK'); }
  await cleanup.run(concurrent.label); assert.equal(await present('concurrent'), false);
  assert.equal((await admin.query('SELECT revoked_at FROM partner_api_keys WHERE id=$1', [real.id])).rows[0].revoked_at, null);
  assert.equal((await admin.query('SELECT 1 FROM partner_api_key_policy_events WHERE key_id=$1', [real.id])).rowCount, 1);
  console.log('PASS: runtime fixture lock serializes sessions; cleanup proves its primary and deletes only its run; concurrent and real partners preserved; direct DELETE still denied.');
} finally { await runtime.end(); await concurrentCleanup.close(); await cleanup.close(); await admin.end(); }
