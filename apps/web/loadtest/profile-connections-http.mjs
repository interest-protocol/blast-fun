// Run through with-disposable-postgres.sh after wallet-http-build.mjs creates an isolated production build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, fetch } from 'undici';
import pg from 'pg';

import { migrateDatabase } from '../../../packages/core/src/modules/database/migrations.ts';
import { CHAIN_FIXTURE, resetSharedDatabase, urlAs } from '../../../packages/core/test/fixtures/modules/database/role-fixtures.ts';
import { SIZE, HUB, seedLargeLists } from '../../../packages/core/test/fixtures/modules/social/follows/large-connections.ts';
import { forEachConcurrent } from './lib/concurrent.mjs';

const root = process.cwd();
const dir = process.env.WALLET_SCALE_HTTP_DIR;
assert(dir && path.isAbsolute(dir), 'Set WALLET_SCALE_HTTP_DIR to the isolated build directory');
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
assert(databaseUrl, 'Run with scripts/with-disposable-postgres.sh');
let target;
try { target = new URL(databaseUrl); } catch { throw new Error('Invalid disposable database URL'); }
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.pathname, '/mission_control_test');
assert.equal(target.username, 'postgres');
await fs.access(`${root}/apps/web/.next/BUILD_ID`);
const env = JSON.parse(await fs.readFile(`${dir}/app-env.json`, 'utf8'));
assert.equal(env.NODE_ENV, 'production');
assert.equal(env.LOADTEST_EGRESS_MODE, 'block');
assert(!env.LOADTEST_EGRESS_ALLOW);
const key = await fs.readFile(`${dir}/signing.pem`);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const dispatcher = new Agent({ connections: 32, pipelining: 1 });
const report = {
  started_at: new Date().toISOString(), node: process.version,
  host: { platform: os.platform(), cpus: os.availableParallelism(), total_memory_gib: os.totalmem() / 2 ** 30 },
  fixture: { accounts: SIZE + 1, relationships: SIZE * 2, private_share: 0.1 },
  workload: { model: 'closed-loop; fixed request counts; no client retries', concurrency: [1, 8, 32], primary_pool_max: 10, statement_timeout_ms: 8000, postgres_shared_memory: process.env.POSTGRES_TEST_SHM_SIZE ?? '64m' },
  stages: [], privacy_checks: 0, resource_samples: [],
};
let child, gateCookie, sequence = 0, stoppedForPressure = false;
const credentials = {};

function bearer(did) {
  const now = Math.floor(Date.now() / 1000);
  const data = [{ alg: 'ES256', typ: 'JWT' }, { iss: 'privy.io', aud: env.PRIVY_APP_ID, sub: did, sid: 'connections-load', iat: now - 60, exp: now + 7200 }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `Bearer ${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function percentile(samples, share) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)] * 100) / 100 : null;
}

async function save() {
  await fs.writeFile(`${dir}/connections-http-results.json`, `${JSON.stringify(report, null, 2)}\n`);
}

async function request(spec, overrides = {}) {
  assert(!stoppedForPressure, 'VPS memory headroom or PSI exceeded; stop load');
  const headers = {
    cookie: `${gateCookie}${spec.auth === 'wallet' ? `; __Host-blast_wallet=${credentials.wallet}` : ''}`,
    origin: env.NEXT_PUBLIC_SITE_URL, 'sec-fetch-site': 'same-origin',
    'x-forwarded-for': `10.201.${Math.floor(sequence / 250) % 250}.${sequence++ % 250 + 1}`,
    ...(spec.auth === 'owner' ? { authorization: credentials.owner } : {}),
    ...(spec.auth === 'other' ? { authorization: credentials.other } : {}),
    ...(spec.publicView ? { 'x-blast-public-view': '1' } : {}),
    ...overrides,
  };
  const response = await fetch(`${report.origin}${spec.path}`, { dispatcher, headers, signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  if (response.ok) assert.match(response.headers.get('cache-control') ?? '', /private/);
  assert(response.headers.get('x-request-id'));
  return { status: response.status, body };
}

function assertVisible(result, spec) {
  if (result.status !== 200) {
    assert(!('accounts' in result.body) && !('followers' in result.body) && !('following' in result.body));
    return;
  }
  if ('accounts' in result.body) {
    assert.deepEqual(Object.keys(result.body).sort(), ['accounts', 'next_cursor']);
    assert(result.body.accounts.length <= 50);
    assert.equal(new Set(result.body.accounts.map(account => account.callsign)).size, result.body.accounts.length);
    if (spec.path.includes('tab=followers') || !['owner', 'wallet'].includes(spec.auth) || spec.publicView) {
      assert(result.body.accounts.every(account => !account.private), 'private identity leaked');
    }
  }
}

async function verified(spec, expected) {
  const result = await request(spec);
  assertVisible(result, spec);
  assert.deepEqual(result, expected, spec.label);
  report.privacy_checks++;
  return result;
}

async function stage(label, concurrency, specs, requests = 64) {
  const latencies = [], successes = [], errors = [];
  const byScenario = {};
  const statuses = {};
  const started = performance.now();
  let active = 0, maxActive = 0;
  await forEachConcurrent(Array.from({ length: requests }, (_, i) => i), concurrency, async i => {
    const spec = specs[i % specs.length];
    const start = performance.now();
    maxActive = Math.max(maxActive, ++active);
    try {
      const result = await request(spec);
      assertVisible(result, spec);
      statuses[result.status] = (statuses[result.status] ?? 0) + 1;
      if (result.status === 200) {
        assert.deepEqual(result, spec.expected, spec.label);
        report.privacy_checks++;
        successes.push(performance.now() - start);
      } else {
        errors.push({ scenario: spec.label, status: result.status, code: result.body.error?.code });
      }
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      errors.push({ scenario: spec.label, error: error.name, cause: error.cause?.code });
    } finally {
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
      (byScenario[spec.label] ??= []).push(elapsed);
      active--;
    }
  });
  const seconds = (performance.now() - started) / 1000;
  const result = { label, concurrency, max_active: maxActive, requests, successful: successes.length, seconds,
    successful_rps: successes.length / seconds, statuses, errors,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99), max: percentile(latencies, 1) },
    successful_p95_ms: percentile(successes, 0.95),
    by_scenario: Object.fromEntries(Object.entries(byScenario).map(([scenario, samples]) => [scenario, {
      requests: samples.length, p50_ms: percentile(samples, 0.5), p95_ms: percentile(samples, 0.95), max_ms: percentile(samples, 1),
    }])) };
  report.stages.push(result);
  await save();
  console.log(JSON.stringify(result));
}

async function sampleResources() {
  const memory = await fs.readFile('/proc/meminfo', 'utf8');
  const available = Number(/MemAvailable:\s+(\d+)/.exec(memory)?.[1]) / 1048576;
  const pressure = await fs.readFile('/proc/pressure/memory', 'utf8');
  const full = Number(/full avg10=([\d.]+)/.exec(pressure)?.[1]);
  stoppedForPressure ||= available < 4 || full >= 1;
  report.resource_samples.push({ at: new Date().toISOString(), available_gib: available, full_avg10: full });
}

let monitor;
try {
  await resetSharedDatabase(admin);
  await admin.query(CHAIN_FIXTURE);
  const applied = await migrateDatabase(admin);
  report.migrations = { applied, target: { host: target.hostname, database: target.pathname.slice(1), disposable: true },
    latest: (await admin.query("SELECT name, checksum FROM mission_control_schema_migrations ORDER BY name DESC LIMIT 1")).rows[0] };
  await seedLargeLists(admin);
  report.migrations.search_index_bytes = Number((await admin.query("SELECT pg_relation_size('social_accounts_connection_search_trgm_idx'::regclass) AS bytes")).rows[0].bytes);
  await admin.query("ALTER ROLE blast_web SET statement_timeout='8s'; ALTER ROLE blast_web SET lock_timeout='3s'");
  const wallet = randomBytes(32).toString('base64url');
  const address = `0x${'b'.repeat(64)}`;
  await admin.query('INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, now())', [address, HUB]);
  await admin.query(`INSERT INTO social_wallet_sessions (session_id, token_hash, wallet_address, challenge_id, created_at, expires_at, last_used_at)
    VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now(), now()+interval '2 hours', now())`, [createHash('sha256').update(wallet).digest('hex'), address]);
  Object.assign(credentials, { wallet, owner: bearer('did:privy:scale-hub'), other: bearer('did:privy:scale-1') });
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  report.origin = `http://127.0.0.1:${port}`;
  await sampleResources();
  assert(!stoppedForPressure);
  const log = await fs.open(`${dir}/connections-app.log`, 'w');
  child = spawn(process.execPath, [`${root}/node_modules/next/dist/bin/next`, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: `${root}/apps/web`, env: { ...env, DATABASE_URL: urlAs(databaseUrl, 'blast_web'), DATABASE_POOL_MAX: '10', SOCIAL_ROUTE_METRIC_SAMPLE_RATE: '0',
      NODE_OPTIONS: `${env.NODE_OPTIONS} --import ${root}/apps/web/loadtest/lib/loop-monitor.mjs` }, stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  await fs.writeFile(`${dir}/connections-ownership.json`, JSON.stringify({ server_pid: child.pid, port, database_port: target.port, cleanup: 'pending' }));
  child.on('error', error => { report.server_error = error.message; });
  monitor = setInterval(() => void sampleResources().catch(error => { report.monitor_error = error.message; stoppedForPressure = true; }), 1000);
  for (let attempt = 0; attempt < 120; attempt++) {
    assert.equal(child.exitCode, null, 'Next server exited; inspect connections-app.log');
    try {
      const response = await fetch(`${report.origin}/privacy`, { dispatcher, signal: AbortSignal.timeout(3000) });
      await response.arrayBuffer();
      if (response.ok) {
        gateCookie = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
        if (gateCookie.includes('blast_gate=')) break;
      }
    } catch { /* Readiness retries do not enter measured stages. */ }
    await sleep(500);
  }
  assert(gateCookie?.includes('blast_gate='));
  const base = '/api/social/profiles/hub/connections';
  const counts = [undefined, 'owner', 'wallet'].map(auth => ({ label: `counts-${auth ?? 'public'}`, path: base, auth }));
  // Baselines run serially so they do not create an unmeasured concurrent workload.
  // react-doctor-disable-next-line react-doctor/async-await-in-loop
  for (const spec of counts) spec.expected = await verified(spec, { status: 200, body: { followers: 90000, following: spec.auth ? SIZE : 90000 } });
  const pages = [];
  // Each pagination baseline depends on the preceding response and cursor.
  for (const tab of ['followers', 'following']) {
    const first = { label: `${tab}-first`, path: `${base}?tab=${tab}&limit=50` };
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    first.expected = await request(first);
    assertVisible(first.expected, first);
    assert.equal(first.expected.status, 200);
    assert.equal(first.expected.body.accounts.length, 50);
    assert(first.expected.body.next_cursor);
    const second = await request({ path: `${first.path}&cursor=${first.expected.body.next_cursor}` });
    assert.equal(new Set([...first.expected.body.accounts, ...second.body.accounts].map(account => account.callsign)).size, 100);
    const cursor = Buffer.from(JSON.stringify(['hub', tab, '', '2026-10-14T12:01:40.123456Z', '00000000-0000-4000-8000-000000002711'])).toString('base64url');
    const deep = { label: `${tab}-deep`, path: `${first.path}&cursor=${cursor}` };
    deep.expected = await request(deep);
    assertVisible(deep.expected, deep);
    assert.equal(deep.expected.status, 200);
    assert.equal(deep.expected.body.accounts.length, 50);
    assert(deep.expected.body.accounts.every(account => Number(account.callsign.slice(6)) <= 10001));
    pages.push(first, deep);
  }
  const searches = [];
  // Owner baselines use one request at a time before the measured stages.
  for (const auth of ['owner', 'wallet']) {
    const spec = { label: `following-first-${auth}`, path: `${base}?tab=following&limit=50`, auth };
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    spec.expected = await request(spec);
    assertVisible(spec.expected, spec);
    assert.equal(spec.expected.status, 200);
    assert(spec.expected.body.accounts.some(account => account.private));
    pages.push(spec);
  }
  // Search baselines are serial; concurrency is controlled by stage() below.
  for (const tab of ['followers', 'following']) {
    for (const q of ['person9', 'person12345', 'no_match_anywhere']) {
      const spec = { label: `${tab}-search-${q}`, path: `${base}?tab=${tab}&q=${q}&limit=50` };
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      spec.expected = await request(spec);
      assertVisible(spec.expected, spec);
      assert.equal(spec.expected.status, 200);
      const expectedLength = q === 'person9' ? 50 : q === 'person12345' ? 1 : 0;
      assert.equal(spec.expected.body.accounts.length, expectedLength);
      searches.push(spec);
    }
  }
  const privateSearch = { path: `${base}?tab=following&q=person99990`, auth: 'owner' };
  const foundPrivate = await request(privateSearch);
  assert.equal(foundPrivate.status, 200);
  assert.equal(foundPrivate.body.accounts[0]?.private, true);
  searches.push({ ...privateSearch, label: 'following-private-search-owner', expected: foundPrivate });
  await verified({ ...privateSearch, auth: undefined }, { status: 200, body: { accounts: [], next_cursor: null } });
  await verified({ ...privateSearch, publicView: true }, { status: 200, body: { accounts: [], next_cursor: null } });
  await verified({ ...privateSearch, auth: 'wallet', publicView: true }, { status: 200, body: { accounts: [], next_cursor: null } });
  assert.equal((await request(counts[0], { cookie: '' })).status, 401);
  assert.equal((await request(counts[0], { origin: 'https://attacker.invalid' })).status, 403);
  await verified(counts[0], { status: 200, body: { followers: 90000, following: 90000 } });
  const invalidToken = await request(counts[0], { authorization: `${credentials.owner}invalid` });
  assert.deepEqual(invalidToken, counts[0].expected, 'optional invalid auth must not gain owner visibility');

  for (const concurrency of [1, 8, 32]) {
    await stage('counts', concurrency, counts);
    await stage('pages', concurrency, pages, 128);
    await stage('search', concurrency, searches);
    // Five page requests, two counts and two searches per cycle: test interference on the shared pool.
    await stage('mixed', concurrency, [...pages.slice(0, 4), pages[4], ...counts.slice(0, 2), searches[1], searches[2]], 144);
  }

  const prior = await request({ path: `${pages[0].path}&cursor=${pages[0].expected.body.next_cursor}` });
  const hidden = prior.body.accounts[0].callsign;
  await admin.query("UPDATE social_accounts SET privacy='private', sharing_since=NULL WHERE callsign=$1", [hidden]);
  await forEachConcurrent(Array.from({ length: 32 }, (_, i) => i), 32, async i => {
    const spec = i % 2 ? { path: `${pages[0].path}&cursor=${pages[0].expected.body.next_cursor}` } : { path: base };
    const result = await request(spec);
    assert.equal(result.status, 200);
    assertVisible(result, spec);
    if (i % 2) assert(!result.body.accounts.some(account => account.callsign === hidden));
    else assert.deepEqual(result.body, { followers: 89999, following: 89999 });
    report.privacy_checks++;
  });
  await admin.query("UPDATE social_accounts SET privacy='private', sharing_since=NULL WHERE account_id=$1", [HUB]);
  await forEachConcurrent(Array.from({ length: 64 }, (_, i) => i), 32, async i => {
    const path = [base, ...pages.map(spec => spec.path), ...searches.map(spec => spec.path)][i % (1 + pages.length + searches.length)];
    const auth = [undefined, 'other', 'owner', 'wallet'][i % 4];
    const publicView = i % 4 >= 2;
    const denied = await request({ path, auth, publicView });
    assert.equal(denied.status, 404);
    assert.equal(denied.body.error.code, 'not_found');
    assertVisible(denied, { path, auth, publicView });
    report.privacy_checks++;
  });
  await verified({ path: base, auth: 'owner' }, { status: 200, body: { followers: 89999, following: SIZE } });
  await verified({ path: base, auth: 'wallet' }, { status: 200, body: { followers: 89999, following: SIZE } });
  await admin.query("UPDATE social_accounts SET privacy='public' WHERE account_id=$1", [HUB]);
  const boundaryWait = 60000 - Date.now() % 60000;
  if (boundaryWait < 15000) await sleep(boundaryWait + 10);
  await forEachConcurrent(Array.from({ length: 600 }, (_, i) => i), 8, async () => {
    assert.equal((await request({ path: '/api/social/profiles/missing/connections' }, { 'x-forwarded-for': '192.0.2.201' })).status, 404);
  });
  const limited = await request({ path: base }, { 'x-forwarded-for': '192.0.2.201' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  report.rate_limit_checks = 601;
  report.completed_at = new Date().toISOString();
  report.operational_errors = report.stages.reduce((total, result) => total + result.errors.length, 0);
  await save();
  console.log('CONNECTIONS_HTTP_COMPLETE', JSON.stringify({ operational_errors: report.operational_errors, privacy_checks: report.privacy_checks }));
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  await save();
  throw error;
} finally {
  clearInterval(monitor);
  await dispatcher.destroy();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await admin.end();
  await fs.writeFile(`${dir}/connections-ownership.json`, JSON.stringify({ server_pid: child?.pid, database_port: target.port, cleanup: 'complete' }));
}
