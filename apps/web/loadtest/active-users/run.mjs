// Run from the repo root via scripts/with-disposable-postgres.sh. Never accepts a remote origin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Agent, fetch } from 'undici';
import pg from 'pg';
import { urlAs } from '../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts';
import { seedActiveUsers, refreshFixture, accountId, cashAtoms } from './fixture.ts';
import { isolatedDatabase, requestsFor, percentile, takeScheduled } from './workload.mjs';
import { forEachConcurrent } from '../lib/concurrent.mjs';

const root = process.cwd();
const smoke = process.env.ACTIVE_LOAD_MODE === 'smoke';
assert(smoke || process.env.ACTIVE_LOAD_MODE === undefined, 'Only smoke or the default Next acceptance mode');
const target = isolatedDatabase(process.env.MISSION_CONTROL_TEST_DATABASE_URL);
const dir = path.resolve(process.env.ACTIVE_LOAD_DIR ?? 'apps/web/loadtest/.data/active-users');
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const users = Number(process.env.ACTIVE_LOAD_USERS ?? (smoke ? 20 : 2000));
const holdSeconds = Number(process.env.ACTIVE_LOAD_HOLD_SECONDS ?? (smoke ? 15 : 3600));
const instances = Number(process.env.ACTIVE_LOAD_INSTANCES ?? (smoke ? 1 : 4));
assert(Number.isInteger(users) && users >= 4 && users <= 3000);
assert(Number.isInteger(instances) && instances >= 1 && instances <= 8);
assert(Number.isFinite(holdSeconds) && holdSeconds >= 5 && holdSeconds <= 7200);
const report = { mode: smoke ? 'route-smoke (excludes Next proxy/rendering)' : 'production-next-http',
  target_users: users, instances, started_at: new Date().toISOString(), stages: [],
  limitations: ['No CDN, TLS, browser rendering, SSE, transaction execution or real provider quotas', 'Primary and replica roles share one disposable PostgreSQL server'] };
const admin = new pg.Pool({ connectionString: target.href, max: 2 });
const dispatcher = new Agent({ connections: 256, pipelining: 1 });
const children = [];
let monitor, stopped = false, inFlight = 0;
const pending = new Set();
const abort = new AbortController();

async function headroom() {
  const available = Number((await fs.readFile('/proc/meminfo', 'utf8')).match(/MemAvailable:\s+(\d+)/)?.[1] ?? 0);
  const pressure = Number((await fs.readFile('/proc/pressure/memory', 'utf8')).match(/full avg10=([\d.]+)/)?.[1] ?? 100);
  assert(available >= 4 * 1024 * 1024 && pressure < 1, 'VPS reserve/pressure exceeded; stopping this run');
}
async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
function token(n, key, appId) {
  const now = Math.floor(Date.now() / 1000);
  const data = [{ alg: 'ES256', typ: 'JWT' }, { iss: 'privy.io', aud: appId,
    sub: `did:privy:capacity-${n}`, sid: `capacity-${n}`, iat: now - 60, exp: now + 14400 }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `Bearer ${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function save() {
  await fs.writeFile(path.join(dir, 'results.json'), JSON.stringify(report, null, 2) + '\n');
}
process.once('SIGINT', () => { stopped = true; abort.abort(); });
process.once('SIGTERM', () => { stopped = true; abort.abort(); });

try {
  await headroom();
  await fs.writeFile(path.join(dir, 'egress.jsonl'), '', { mode: 0o600 });
  let env, key;
  if (smoke) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    key = pair.privateKey;
    env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production',
      PRIVY_APP_ID: 'capacity-isolated', PRIVY_JWT_VERIFICATION_KEY: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      RATE_LIMIT_SUBJECT_PEPPER: randomBytes(32).toString('hex'), BLAST_GATE_SECRET: randomBytes(32).toString('hex'),
      NEXT_PUBLIC_SITE_URL: 'http://127.0.0.1:39170' };
  } else {
    const buildDir = process.env.WALLET_SCALE_HTTP_DIR;
    assert(buildDir && path.isAbsolute(buildDir), 'Build with wallet-http-build.mjs and set WALLET_SCALE_HTTP_DIR');
    await fs.access(path.join(root, 'apps/web/.next/BUILD_ID'));
    env = JSON.parse(await fs.readFile(path.join(buildDir, 'app-env.json'), 'utf8'));
    key = await fs.readFile(path.join(buildDir, 'signing.pem'));
    assert.equal(env.LOADTEST_EGRESS_MODE, 'block');
    assert(!env.LOADTEST_EGRESS_ALLOW);
  }
  env = { ...env, BLAST_SOCIAL_ENABLED: 'true', BLAST_PRESALE_ENABLED: 'true', BLAST_TRADING_ENABLED: 'true',
    BLAST_LAUNCHPAD_ENABLED: 'false', DATABASE_URL: urlAs(target.href, 'blast_web'),
    DATABASE_REPLICA_URL: urlAs(target.href, 'blast_replica'), DATABASE_POOL_MAX: '10', DATABASE_REPLICA_POOL_MAX: '10',
    SOCIAL_ROUTE_METRIC_SAMPLE_RATE: '0', NEXT_TELEMETRY_DISABLED: '1',
    LOADTEST_EGRESS_MODE: 'block', LOADTEST_EGRESS_ALLOW: '', LOADTEST_EGRESS_LOG: path.join(dir, 'egress.jsonl'),
    NODE_OPTIONS: `--import ${root}/apps/web/loadtest/lib/egress-guard.mjs` };
  report.fixture = await seedActiveUsers(admin, Math.max(users, smoke ? 100 : 10000), smoke ? 10 : 1000);
  const apps = [];
  for (let i = 0; i < instances; i++) {
    await headroom();
    const port = await freePort();
    const log = await fs.open(path.join(dir, `app-${i}.log`), 'w');
    const args = smoke
      ? ['--no-warnings', '--import', `${root}/scripts/test-tsx-hooks.mjs`, `${root}/apps/web/loadtest/active-users/route-server.mjs`]
      : [`${root}/node_modules/next/dist/bin/next`, 'start', '--hostname', '127.0.0.1', '--port', String(port)];
    const child = spawn(process.execPath, args, { cwd: `${root}/apps/web`, env: { ...env, PORT: String(port) }, stdio: ['ignore', log.fd, log.fd] });
    await log.close();
    children.push(child);
    child.on('error', error => { stopped = true; report.server_error = error.message; });
    const origin = `http://127.0.0.1:${port}`;
    let cookie, ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.equal(child.exitCode, null, 'App exited; inspect its log');
      try {
        const response = await fetch(`${origin}/privacy`, { dispatcher, signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        if (response.ok && (smoke || cookie.includes('blast_gate='))) { ready = true; break; }
      } catch { /* bounded readiness loop */ }
      await sleep(250);
    }
    assert(ready, 'App failed readiness');
    apps.push({ origin, cookie });
  }
  await fs.writeFile(path.join(dir, 'ownership.json'), JSON.stringify({ pids: children.map(child => child.pid), origins: apps.map(app => app.origin), disposable_database_port: target.port }));
  const credentials = Array.from({ length: users }, (_, n) => token(n + 1, key, env.PRIVY_APP_ID));
  async function request(n, route, authorization = credentials[n - 1]) {
    const app = apps[n % apps.length];
    const response = await fetch(`${app.origin}${route}`, { dispatcher, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
      headers: { authorization, cookie: app.cookie, origin: env.NEXT_PUBLIC_SITE_URL, 'sec-fetch-site': 'same-origin',
        'x-forwarded-for': `10.42.${Math.floor(n / 250)}.${n % 250 + 1}` } });
    return { response, body: await response.json() };
  }
  function verify(n, route, { response, body }) {
    assert.equal(response.status, 200, `${route}: ${response.status}`);
    assert(response.headers.has('x-request-id'));
    if (route.includes('/me/')) assert.match(response.headers.get('cache-control'), /private, no-store/);
    if (route === '/api/social/me') assert.equal(body.account.account_id, accountId(n));
    if (route.includes('/portfolio?')) assert.equal(body.balances?.sui.atoms, cashAtoms(n), 'Wrong account or incomplete balance');
    if (route.includes('/portfolio/coins')) assert(body.coins.some(coin => coin.balance === cashAtoms(n)), 'Wallet page lost the account cash');
  }
  // A failure must not be mistaken for a fast successful response.
  assert.equal((await request(1, '/api/social/me/portfolio?view=summary', '')).response.status, 401);
  assert.equal((await request(1, '/api/social/me/portfolio?view=summary', 'Bearer invalid')).response.status, 401);
  const preflight = Array.from({ length: Math.min(4, users) }, (_, index) =>
    requestsFor(index + 1).map(({ path: route }) => ({ n: index + 1, route }))).flat();
  await forEachConcurrent(preflight, 4, async ({ n, route }) => verify(n, route, await request(n, route)));
  const traders = await request(1, '/api/social/home/traders?window=24h');
  assert.equal(traders.response.status, 200);
  assert(traders.body.traders.length > 0, 'Fixture must exercise trader accounting, not an empty leaderboard');
  const started = performance.now();
  const schedules = Array.from({ length: users }, (_, index) => requestsFor(index + 1).map((job, j) => ({
    ...job, next: started + ((index * 7919 + j * 3571) % (smoke ? 1000 : job.interval)),
  })));
  monitor = setInterval(() => {
    void headroom().then(() => refreshFixture(admin, 50_000_000)).catch(error => { report.monitor_error = error.message; stopped = true; abort.abort(); });
  }, 10000);
  const stages = smoke ? [{ target: users, seconds: holdSeconds, ramp: 0 }] :
    [...[250, 500, 1000].filter(n => n < users).map(target => ({ target, seconds: 60, ramp: 30 })),
      { target: users, seconds: 120, ramp: 120 }, { target: users, seconds: holdSeconds, ramp: 0 }];
  let previous = 0;
  for (const stage of stages) {
    const from = performance.now(), until = from + stage.seconds * 1000;
    const stats = { target: stage.target, seconds: stage.seconds, ramp_seconds: stage.ramp, offered: 0, completed: 0, errors: 0, dropped: 0, routes: {}, users_seen: new Set() };
    while (performance.now() < until && !stopped) {
      const now = performance.now();
      const active = stage.ramp ? Math.min(stage.target, previous + Math.ceil((stage.target - previous) * (now - from) / (stage.ramp * 1000))) : stage.target;
      for (let index = 0; index < active; index++) {
        for (const job of schedules[index]) {
          const scheduled = takeScheduled(job, now);
          if (!scheduled) continue;
          const { due, missed } = scheduled;
          stats.dropped += missed;
          stats.offered++;
          if (inFlight >= 256) { stats.dropped++; continue; }
          inFlight++;
          const route = stats.routes[job.path] ??= { count: 0, errors: 0, histogram: new Map() };
          const work = request(index + 1, job.path).then(result => {
            verify(index + 1, job.path, result);
            stats.users_seen.add(index + 1);
          }).catch(error => { stats.errors++; route.errors++; stats.first_error ??= error.message; }).finally(() => {
            const latency = Math.ceil((performance.now() - due) / 10) * 10;
            route.histogram.set(latency, (route.histogram.get(latency) ?? 0) + 1);
            route.count++; stats.completed++; inFlight--; pending.delete(work);
          });
          pending.add(work);
        }
      }
      await sleep(50);
    }
    await Promise.all(pending);
    const seen = stats.users_seen.size;
    const routes = Object.fromEntries(Object.entries(stats.routes).map(([name, value]) => [name, {
      count: value.count, errors: value.errors, p95_ms: percentile(value.histogram, 0.95), p99_ms: percentile(value.histogram, 0.99),
    }]));
    report.stages.push({ ...stats, users_seen: seen, routes });
    await save();
    console.log(JSON.stringify({ target: stage.target, completed: stats.completed, errors: stats.errors, dropped: stats.dropped, users_seen: seen }));
    assert(!stopped, 'Run interrupted or resource monitor stopped it');
    assert.equal(stats.dropped, 0, 'Load generator dropped scheduled work');
    assert.equal(stats.errors, 0, stats.first_error);
    if (!stage.ramp) {
      assert.equal(seen, stage.target, 'Every active identity must complete work');
      if (!smoke) for (const [name, result] of Object.entries(routes)) {
        assert(result.p95_ms < 500 && result.p99_ms < 1500, `Latency SLO failed: ${name}`);
      }
    }
    previous = stage.target;
  }
  const egress = await fs.readFile(path.join(dir, 'egress.jsonl'), 'utf8');
  assert(!egress.trim().split('\n').filter(Boolean).some(line => JSON.parse(line).blocked), 'Unexpected external dependency attempted during the isolated run');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  clearInterval(monitor);
  abort.abort();
  await Promise.allSettled(pending);
  await dispatcher.destroy();
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
  await admin.end();
  report.finished_at = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ passed: report.passed, failure: report.failure, report: path.join(dir, 'results.json') }));
}
