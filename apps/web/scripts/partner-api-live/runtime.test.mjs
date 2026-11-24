import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { frontendClientAddress } from '../../../../packages/core/src/modules/backend-api/frontend-ingress.ts';
import { createHttp, runCheck } from './check.mjs';
import { createCandidateFetch, gateConfiguration, startupReport, waitForServer } from './runtime.mjs';

async function listener(t, handle) {
  const server = createServer(handle);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('compiled reads reach the real ingress contract only through the owned loopback transport', async t => {
  const received = [];
  const origin = await listener(t, (req, res) => {
    const request = new Request(origin + req.url, { headers: req.headers });
    received.push({ path: req.url, address: frontendClientAddress(request, { vercel: true, localRun: false }) });
    res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}');
  });
  assert.equal(frontendClientAddress(new Request(origin), { vercel: true, localRun: false }), null);
  const transport = createCandidateFetch(origin, { compiled: true });
  const response = await transport(new URL('/api/v1/presales', origin)); await response.body.cancel();
  assert.deepEqual(received, [{ path: '/api/v1/presales', address: '127.0.0.1' }]);
  const other = await listener(t, (_req, res) => { received.push('escaped'); res.end('{}'); });
  await assert.rejects(transport(new URL('/api/v1/presales', other)));
  await assert.rejects(transport(new URL('/api/v1/presales', origin.replace('127.0.0.1', 'localhost'))));
  await assert.rejects(transport(new URL('https://public.test/api/v1/presales')));
  await assert.rejects(transport(new URL('/api/admin/partner-keys', origin)));
  assert.equal(received.length, 1);
  assert.throws(() => createCandidateFetch('https://public.test', { compiled: true }));
});

test('compiled read redirects cannot forward asserted identity to another origin', async t => {
  let escaped = false;
  const other = await listener(t, (_req, res) => { escaped = true; res.end('{}'); });
  const origin = await listener(t, (_req, res) => { res.writeHead(307, { location: other + '/api/v1/presales' }); res.end(); });
  await assert.rejects(createCandidateFetch(origin, { compiled: true })(new URL('/api/v1/presales', origin)));
  assert.equal(escaped, false);
});

test('hosted read transport never asserts a platform address', async () => {
  let headers;
  const transport = createCandidateFetch('https://candidate.test', { fetcher: async (_url, init) => {
    headers = new Headers(init.headers); return Response.json({});
  } });
  await transport(new URL('https://candidate.test/api/v1/presales'), { headers: { 'x-vercel-forwarded-for': '192.0.2.8' } });
  assert.equal(headers.has('x-vercel-forwarded-for'), false);
});

test('readiness and subsequent reads share compiled ingress while real operator HTTP stays separate', async t => {
  const received = [];
  const candidate = await listener(t, (req, res) => {
    received.push({ owner: 'candidate', path: req.url, headers: req.headers });
    res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}');
  });
  const backend = await listener(t, (req, res) => {
    received.push({ owner: 'backend', path: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const transport = createCandidateFetch(candidate, { compiled: true });
  await waitForServer({ origin: candidate, transport, server: waiting, ...quickWait });
  const http = createHttp({ origin: candidate, adminOrigin: backend, token: 'private-operator-sentinel'.repeat(2), readFetcher: transport });
  await http.read('/api/v1/presales', 'private-key-sentinel');
  await http.admin({ action: 'issue', partnerId: 'fixture', label: 'fixture' });
  assert.equal(received.length, 3);
  for (const entry of received.filter(entry => entry.owner === 'candidate')) {
    assert.equal(entry.headers['x-vercel-forwarded-for'], '127.0.0.1');
    assert.equal(entry.headers.authorization, undefined);
  }
  const operator = received.find(entry => entry.owner === 'backend');
  assert.equal(operator.path, '/api/admin/partner-keys');
  assert.equal(operator.headers.authorization, 'Bearer ' + 'private-operator-sentinel'.repeat(2));
  assert.equal(operator.headers['x-vercel-forwarded-for'], undefined);
  assert.equal(operator.headers['x-blast-partner-key'], undefined);
  assert.ok(!Object.keys(operator.headers).some(name => name.startsWith('x-blast-gateway-')));
});

const waiting = { exitCode: null, signalCode: null, once() {}, removeListener() {} };
const quickWait = { attempts: 2, intervalMs: 1, requestTimeoutMs: 100 };

test('readiness accepts only real admission 401 and reports refused statuses without response bodies', async t => {
  for (const status of [401, 503, 404, 200]) {
    const origin = await listener(t, (_req, res) => {
      res.writeHead(status); res.end('secret-response-sentinel');
    });
    const ready = waitForServer({ origin, transport: createCandidateFetch(origin, { compiled: true }), server: waiting, ...quickWait });
    if (status === 401) await ready;
    else await assert.rejects(ready, error => error.stage === 'readiness' && error.category === 'admission_not_ready' &&
      error.status === status && !error.message.includes('secret-response-sentinel'));
  }
});

test('readiness bounds a hanging request, cancellation and child exit and removes owned exit listeners', async t => {
  const origin = await listener(t, () => {});
  const transport = createCandidateFetch(origin, { compiled: true });
  await assert.rejects(waitForServer({ origin, transport, server: waiting, ...quickWait, attempts: 1, requestTimeoutMs: 10 }),
    error => error.stage === 'readiness' && error.category === 'admission_not_ready' && error.status === null);
  const controller = new AbortController();
  const cancelled = waitForServer({ origin, transport, server: waiting, signal: controller.signal, ...quickWait });
  controller.abort(new Error('secret-abort-sentinel'));
  await assert.rejects(cancelled, error => error.category === 'interrupted' && !error.message.includes('secret-abort-sentinel'));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 30)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await assert.rejects(waitForServer({ origin, transport, server: child, ...quickWait, requestTimeoutMs: 5000 }),
    error => error.category === 'candidate_stopped');
  assert.equal(child.listenerCount('exit'), 0);
});

const configured = {
  DATABASE_URL: 'postgres://fixture:private-database-sentinel@127.0.0.1:1/fixture',
  PRESALE_ADMIN_TOKEN: 'private-operator-sentinel'.repeat(2),
  BLAST_BACKEND_API_ORIGIN: 'https://backend.test',
  BLAST_BACKEND_GATEWAY_SECRET: 'private-gateway-sentinel'.repeat(2),
  BLAST_PARTNER_RELEASE_FIXTURE_UUID: 'a1111111-2222-4333-8444-555555555555',
  BLAST_REDIS_NAMESPACE: 'fixture-preview', BLAST_DEPLOYMENT_TARGET: 'develop', BLAST_DEPLOYMENT_BRANCH: 'ci-fixture',
};

test('operator admission refuses invalid targets and credentials before any cleanup or issuance', async t => {
  let escaped = false;
  const other = await listener(t, (_req, res) => { escaped = true; res.end('{}'); });
  for (const scenario of [401, 403, 404, 503, 'redirect', 'invalid-json', 'wrong-service', 'unavailable', 'timeout']) {
    const events = [];
    const origin = await listener(t, (req, res) => {
      events.push(`${req.method}:${req.url}`);
      if (scenario === 'timeout') return;
      if (scenario === 'unavailable') { req.destroy(); return; }
      if (scenario === 'redirect') { res.writeHead(307, { location: other + '/api/admin/partner-keys' }); res.end(); return; }
      res.writeHead(typeof scenario === 'number' ? scenario : 200, { 'content-type': 'application/json' });
      res.end(scenario === 'invalid-json' ? 'private-response-sentinel' : JSON.stringify({ error: 'private-response-sentinel' }));
    });
    const result = await runCheck({
      http: createHttp({ origin: 'https://candidate.test', adminOrigin: origin, token: configured.PRESALE_ADMIN_TOKEN,
        signal: scenario === 'timeout' ? AbortSignal.timeout(100) : undefined }),
      cleanup: { stale: async () => events.push('cleanup:stale'), run: async () => events.push('cleanup:run') },
    });
    assert.equal(result.passed, false, String(scenario));
    assert.equal(result.cleanupConfirmed, false, String(scenario));
    assert.equal(result.failure.stage, 'operator-preflight', String(scenario));
    assert.equal(result.failure.status, typeof scenario === 'number' ? scenario : scenario === 'wrong-service' ? 200 : null);
    assert.deepEqual(events, ['GET:/api/admin/partner-keys'], String(scenario));
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
  assert.equal(escaped, false);
});

test('authenticated operator admission precedes cleanup and retains cleanup after a subsequent write failure', async t => {
  const events = [];
  const origin = await listener(t, (req, res) => {
    events.push(req.method);
    res.writeHead(req.method === 'GET' ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.method === 'GET' ? { partners: [], keys: [] } : {}));
  });
  const result = await runCheck({
    http: createHttp({ origin: 'https://candidate.test', adminOrigin: origin, token: configured.PRESALE_ADMIN_TOKEN }),
    fixtureId: configured.BLAST_PARTNER_RELEASE_FIXTURE_UUID,
    cleanup: {
      claim: async () => { events.push('lock'); return true; },
      stale: async () => events.push('cleanup:stale'),
      run: async () => events.push('cleanup:run'),
      prove: async () => { events.push('proof'); return false; },
      release: async () => events.push('unlock'),
    },
  });
  assert.deepEqual(events, ['GET', 'lock', 'cleanup:stale', 'cleanup:run', 'POST', 'proof', 'cleanup:run', 'unlock']);
  assert.equal(result.failure.stage, 'prepare');
  assert.equal(result.passed, false); assert.equal(result.cleanupConfirmed, false);
});

test('preflight validates split-owner configuration without substituting operator credentials', () => {
  const config = gateConfiguration(configured, { built: true });
  assert.equal(config.token, configured.PRESALE_ADMIN_TOKEN);
  assert.equal(config.adminOrigin, 'https://backend.test');
  const cases = [
    ['DATABASE_URL', undefined, 'database_configuration'],
    ['DATABASE_URL', 'https://private-database-sentinel', 'database_configuration'],
    ['PRESALE_ADMIN_TOKEN', undefined, 'operator_credential'],
    ['PRESALE_ADMIN_TOKEN', 'short', 'operator_credential'],
    ['PRESALE_ADMIN_TOKEN', 'private-operator-sentinel\r\n'.repeat(2), 'operator_credential'],
    ['PRESALE_ADMIN_TOKEN', 'a'.repeat(31) + '\t', 'operator_credential'],
    ['PRESALE_ADMIN_TOKEN', 'a'.repeat(32) + ' ', 'operator_credential'],
    ['BLAST_BACKEND_API_ORIGIN', undefined, 'backend_origin'],
    ['BLAST_BACKEND_API_ORIGIN', 'https://user:private-origin-sentinel@backend.test', 'web_configuration:BLAST_BACKEND_API_ORIGIN'],
    ['BLAST_BACKEND_GATEWAY_SECRET', undefined, 'backend_gateway_configuration'],
    ['BLAST_REDIS_NAMESPACE', undefined, 'quota_namespace_configuration'],
    ['BLAST_REDIS_NAMESPACE', 'invalid namespace', 'web_configuration:BLAST_REDIS_NAMESPACE'],
    ['BLAST_DEPLOYMENT_BRANCH', undefined, 'unsupported_topology'],
  ];
  for (const [field, value, category] of cases)
    assert.throws(() => gateConfiguration({ ...configured, [field]: value }, { built: true }), error => {
      const report = startupReport(error, 'preflight');
      assert.equal(report.failure.category, category);
      assert.equal(report.passed, false);
      assert.ok(!JSON.stringify(report).includes('sentinel'));
      return true;
    });
  const vercelBuild = { ...configured, VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'develop' };
  assert.throws(() => gateConfiguration(vercelBuild, { built: true }), error => error.category === 'unsupported_topology');
  assert.doesNotThrow(() => gateConfiguration({ ...vercelBuild, VERCEL_GIT_COMMIT_REF: 'develop' }, { built: true }));
  assert.throws(() => gateConfiguration(configured, { origin: 'https://backend.test' }), error => error.category === 'unsupported_topology');
  assert.throws(() => gateConfiguration(configured, { origin: 'https://user:private-origin-sentinel@candidate.test' }), error => error.category === 'candidate_origin');
  assert.ok(!JSON.stringify(startupReport(new Error('private-exception-sentinel'), 'spawn')).includes('sentinel'));
});

const production = {
  ...configured, NODE_ENV: 'production', BLAST_DEPLOYMENT_TARGET: 'production', BLAST_DEPLOYMENT_BRANCH: undefined,
  BLAST_REDIS_NAMESPACE: 'mainnet:deploy_1-a', BLAST_GATE_SECRET: 'private-gate-sentinel'.repeat(2),
  NEXT_PUBLIC_SITE_URL: 'https://www.blast.test',
};

// This fails if a production build can publish without one of the five values
// the deployed web server requires, or if the refusal carries anything but the
// variable's name.
test('a production build is refused when any of its five required web settings is missing, naming it', () => {
  assert.doesNotThrow(() => gateConfiguration(production, { built: true }));
  for (const name of ['BLAST_BACKEND_API_ORIGIN', 'BLAST_BACKEND_GATEWAY_SECRET', 'BLAST_REDIS_NAMESPACE', 'BLAST_GATE_SECRET', 'NEXT_PUBLIC_SITE_URL'])
    assert.throws(() => gateConfiguration({ ...production, [name]: undefined }, { built: true }), error => {
      const report = startupReport(error, 'preflight');
      assert.equal(report.failure.category, `web_configuration:${name}`);
      assert.ok(!JSON.stringify(report).includes('sentinel'));
      return true;
    }, name);
});

// This fails if a develop or preview build starts requiring the production-only
// web settings, or if a set but invalid optional one stops failing the build.
test('a non-production build does not require the production web settings, but refuses an invalid one', () => {
  const develop = { ...configured, BLAST_GATE_SECRET: undefined, NEXT_PUBLIC_SITE_URL: undefined };
  assert.doesNotThrow(() => gateConfiguration(develop, { built: true }));
  const preview = { ...develop, VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feature-x', NODE_ENV: 'production' };
  assert.doesNotThrow(() => gateConfiguration(preview, { built: true }));
  assert.throws(() => gateConfiguration({ ...develop, CRON_SECRET: 'private-cron-sentinel' }, { built: true }), error =>
    error.category === 'web_configuration:CRON_SECRET' && !error.message.includes('sentinel'));
});

// This fails if a remote `--origin` check (which never deploys) starts parsing
// the local shell's web settings.
test('an --origin check skips the web settings parser', () => {
  const remote = { ...production, BLAST_GATE_SECRET: undefined, CRON_SECRET: 'private-cron-sentinel' };
  assert.equal(gateConfiguration(remote, { origin: 'https://candidate.test' }).origin, 'https://candidate.test');
});

// This fails if a generic feature preview build publishes without parsing the
// web settings its server reads on every request (a half deployment pair would
// then fail every page instead of the build).
test('the actual runner refuses a feature preview whose web settings do not parse, and passes a valid one', () => {
  const preview = { PATH: process.env.PATH, VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview',
    VERCEL_GIT_COMMIT_REF: 'feature-x', NODE_ENV: 'production' };
  const run = (env) => spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, '--built'], {
    env, encoding: 'utf8', timeout: 15000,
  });
  const valid = run(preview);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout.trim()).skipped, 'ui_only_feature_preview');
  const halfPair = run({ ...preview, BLAST_NETWORK: 'mainnet' });
  assert.equal(halfPair.status, 1);
  const report = JSON.parse(halfPair.stderr.trim());
  assert.equal(report.failure.stage, 'preflight');
  assert.equal(report.failure.category, 'web_configuration:BLAST_NETWORK');
});

test('the actual runner fails safely before startup or fixture writes when required backend configuration is absent', () => {
  const result = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, '--built'], {
    env: { PATH: process.env.PATH, ...configured, BLAST_BACKEND_API_ORIGIN: '' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stderr.trim());
  assert.equal(report.failure.stage, 'preflight'); assert.equal(report.failure.category, 'backend_origin');
  assert.equal(report.passed, false); assert.equal(report.cleanupConfirmed, false);
  assert.ok(!JSON.stringify(result).includes('sentinel'));
});

test('the actual runner rejects missing or invalid reserved fixture identities before opening its database', () => {
  for (const fixtureId of [undefined, 'invalid', configured.BLAST_PARTNER_RELEASE_FIXTURE_UUID.toUpperCase()]) {
    const env = { PATH: process.env.PATH, ...configured };
    if (fixtureId === undefined) delete env.BLAST_PARTNER_RELEASE_FIXTURE_UUID;
    else env.BLAST_PARTNER_RELEASE_FIXTURE_UUID = fixtureId;
    const result = spawnSync(process.execPath, [new URL('./run.mjs', import.meta.url).pathname, '--built'], {
      env, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stderr.trim());
    assert.equal(report.failure.stage, 'preflight');
    assert.equal(report.passed, false); assert.equal(report.cleanupConfirmed, false);
    assert.ok(!JSON.stringify(result).includes('sentinel'));
  }
});
