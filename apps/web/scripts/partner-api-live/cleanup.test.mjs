import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { EventEmitter } from 'node:events';
import { createCleanup } from './cleanup.mjs';

const connection = 'postgresql://gate:fixture-secret@ep-fixture-pooler.c-2.us-east-1.aws.neon.tech/blast?sslmode=require';

test('release cleanup normalizes legacy Neon TLS before the actual pg pool sees it', async (t) => {
  const configurations = [];
  t.mock.method(Pool.prototype, 'query', async function () {
    configurations.push(this.options);
    return { rows: [{ active: 0 }] };
  });
  const cleanup = createCleanup(connection);
  try { await cleanup.run('release-gate:00000000-0000-0000-0000-000000000000'); }
  finally { await cleanup.close(); }
  assert.equal(configurations.length, 1);
  for (const configuration of configurations) {
    assert.equal(configuration.connectionString, connection.replace('-pooler.', '.').replace('require', 'verify-full'));
    const tls = new Client(configuration).connectionParameters.ssl;
    assert.ok(tls && typeof tls === 'object');
    assert.notEqual(tls.rejectUnauthorized, false);
    assert.equal(tls.checkServerIdentity, undefined);
  }
});

test('release cleanup refuses insecure or ambiguous Neon TLS before opening a pool', () => {
  for (const suffix of ['sslmode=disable', 'sslmode=no-verify', 'sslmode=require&sslmode=require', 'sslmode=require&uselibpqcompat=true']) {
    assert.throws(() => createCleanup(connection.replace('sslmode=require', suffix)), /must (set sslmode=verify-full|not set uselibpqcompat)/);
  }
});

test('the fixture lock, identity proof and cleanup retain one direct database session until release', async (t) => {
  const client = new EventEmitter(); const calls = []; const released = [];
  client.query = async (sql, values) => {
    calls.push({ sql, values });
    return sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: true }] } : { rowCount: 1 };
  };
  client.release = destroy => { released.push(destroy); };
  t.mock.method(Pool.prototype, 'connect', async function () {
    assert.ok(!this.options.connectionString.includes('-pooler.'));
    return client;
  });
  t.mock.method(Pool.prototype, 'query', async () => { throw new Error('Lock escaped its session'); });
  const cleanup = createCleanup(connection);
  const fixture = 'a1111111-2222-4333-8444-555555555555';
  try {
    assert.equal(await cleanup.claim(fixture), true);
    assert.equal(await cleanup.prove(`ci-partner-read-api-${fixture}`), true);
    await cleanup.run(`release-gate:${fixture}`);
    assert.deepEqual(released, []);
    assert.equal(calls.length, 3);
    await cleanup.release();
    assert.match(calls.at(-1).sql, /pg_advisory_unlock/);
    assert.deepEqual(released, [true]);
  } finally { await cleanup.close(); }
});

test('a lost lock connection cannot prove or clean a fixture through a replacement pooled session', async (t) => {
  const client = new EventEmitter(); const released = []; let queries = 0;
  client.query = async () => { queries++; return { rows: [{ locked: true }] }; };
  client.release = destroy => { released.push(destroy); };
  t.mock.method(Pool.prototype, 'connect', async () => client);
  const cleanup = createCleanup(connection);
  try {
    await cleanup.claim('a1111111-2222-4333-8444-555555555555');
    assert.equal(cleanup.signal.aborted, false);
    client.emit('error', new Error('Disconnected'));
    assert.equal(cleanup.signal.aborted, true);
    await assert.rejects(cleanup.prove('ci-partner-read-api-a1111111-2222-4333-8444-555555555555'), /lock connection was lost/);
    await assert.rejects(cleanup.run('release-gate:a1111111-2222-4333-8444-555555555555'), /Primary cleanup unavailable/);
    assert.equal(queries, 1);
  } finally { await cleanup.close(); }
  assert.deepEqual(released, [true]);
});
