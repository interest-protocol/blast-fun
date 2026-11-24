import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCandidateFetch } from './runtime.mjs';
import { frontendClientAddress } from '../../../../packages/core/src/modules/backend-api/frontend-ingress.ts';
import { checkedFixtureId, checkedOrigin, createHttp, GateFailure, PARTNER, runCheck, validateRead } from './check.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./responses.fixture.json', import.meta.url)));
const key = 'blast_pk_' + 'a'.repeat(43);
const keyId = 'b9c905c7-de88-4bb4-8a7d-944c2b402937';
const headers = () => new Headers({ 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-blast-api-version': '1' });
const response = (body, status = 200) => ({ body: structuredClone(body), status, headers: headers() });
function operationFor(path) {
  if (path.startsWith('/api/v1/presales?')) return 'presales';
  if (path.endsWith('/featured')) return 'featured';
  if (path.startsWith('/api/v1/presales/')) return 'presale';
  if (path.startsWith('/api/v1/prices?')) return 'prices';
  if (path.startsWith('/api/v1/search?')) return 'search';
  if (path.startsWith('/api/v1/discovery?')) return 'discovery';
  if (path.includes('/candles?')) return 'candles';
  if (path.startsWith('/api/v1/market/pools/')) return 'pool';
  return 'status';
}
/** A fresh lineage: no presales, and with `emptyLaunches` no curve launch either. */
function emptied(result, id, { emptyPresales, emptyLaunches }) {
  if (emptyPresales && ['presales', 'featured'].includes(id)) result.body.presales = [];
  if (emptyPresales && id === 'presales') result.body.next_cursor = null;
  if (emptyLaunches && id === 'discovery') Object.assign(result.body, { section: { state: 'empty', provenance: fixtures.discovery.section.provenance }, metrics: {} });
  return result;
}
function harness({ broken, badIssue, failRevoke, delayedRevocation, loseIssue, failCleanup, emptyPresales, emptyLaunches = emptyPresales, missingResponse, aliasAccepted, losePartner } = {}) {
  let revoked = false; let issued = false; let label; let partnerId; let revokedReads = 0;
  const cleaned = []; const routes = [];
  return {
    cleaned, routes,
    http: {
      async admin(change) {
        if (!change) return response({ partners: [], keys: [{ id: keyId, revoked_at: revoked ? '2026-10-21T00:00:00Z' : null }] });
        if (change.action === 'create-partner') {
          partnerId = change.id;
          assert.match(partnerId, /^ci-partner-read-api-[0-9a-f-]{36}$/);
          if (losePartner) throw new Error('Lost partner creation response');
          return response({}, 200);
        }
        if (change.action === 'issue') {
          issued = true; label = change.label;
          assert.equal(change.partnerId, partnerId);
          assert.equal(partnerId, `${PARTNER}-${label.slice(13)}`);
          if (loseIssue) throw new Error('Transport exception containing ' + key);
          return response({ apiKey: { key: badIssue ? 'invalid' : key, id: keyId, partner_id: partnerId, label } });
        }
        if (failRevoke) return response({}, 503);
        revoked = true; return response({ apiKey: { id: keyId, revoked_at: '2026-10-21T00:00:00Z' } });
      },
      async read(path, supplied, method) {
        assert.equal(supplied, key); routes.push(path);
        if (!path.startsWith('/api/v1/')) {
          return aliasAccepted ? response(fixtures.presales) : response({ error: { code: 'partner_read_forbidden' } }, 403);
        }
        if (revoked) {
          revokedReads++;
          return delayedRevocation && revokedReads === 1 ? response(fixtures.presales) : response({ error: { code: 'partner_key_invalid' } }, 401);
        }
        if (method === 'HEAD') return response(null);
        const id = operationFor(path);
        if (broken === id) return response({}, 503);
        if (emptyPresales && id === 'presale') return missingResponse ?? response({ error: { code: 'not_found' } }, 404);
        return emptied(response(fixtures[id]), id, { emptyPresales, emptyLaunches });
      },
    },
    cleanup: {
      async claim() { return true; },
      async prove() { return true; },
      async release() {},
      async stale() {},
      async run(value) {
        if (!partnerId) return;
        if (issued) assert.equal(value, label);
        assert.equal(partnerId, `${PARTNER}-${value.slice(13)}`);
        cleaned.push(value);
        if (failCleanup) throw new Error('secret connection string');
        revoked = true;
      },
    },
  };
}

test('real-key lifecycle covers all nine operations, all presale phases, HEAD, and immediate revocation', async () => {
  const h = harness(); const result = await runCheck(h);
  assert.equal(result.passed, true); assert.equal(result.cleanupConfirmed, true);
  for (const op of ['presales', 'featured', 'presale', 'prices', 'search', 'status', 'discovery', 'pool', 'candles', 'HEAD', 'issue', 'revoke'])
    assert.ok(result.checks.some(c => c.operation === op), op);
  assert.equal(result.checks.filter(c => c.status === 401).length, 11);
  assert.equal(h.cleaned.length, 1); assert.ok(!JSON.stringify(result).includes(key));
});
test('functional checks respect a single request lane through aliases, reads, HEAD and revocation', async () => {
  const h = harness(); let active = 0; let peak = 0;
  h.http = Object.fromEntries(Object.entries(h.http).map(([method, send]) => [method, async (...args) => {
    assert.equal(active, 0, 'The reserved request lane is occupied.');
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      return await send(...args);
    } finally { active--; }
  }]));
  const report = await runCheck(h);
  assert.equal(report.passed, true);
  assert.equal(report.cleanupConfirmed, true);
  assert.equal(peak, 1);
  assert.equal(report.checks.filter(check => check.status === 403).length, 2);
  assert.equal(report.checks.filter(check => check.operation === 'presales').length, 3);
  assert.ok(report.checks.some(check => check.operation === 'HEAD'));
  assert.equal(report.checks.filter(check => check.status === 401).length, 11);
});
test('unversioned partner access blocks release and still revokes the temporary key', async () => {
  const h = harness({ aliasAccepted: true }); const result = await runCheck(h);
  assert.equal(result.passed, false); assert.equal(result.failure.stage, 'unversioned-access');
  assert.equal(result.cleanupConfirmed, true); assert.equal(h.cleaned.length, 1);
});

for (const id of ['presales', 'featured', 'presale', 'prices', 'search', 'status', 'discovery', 'pool', 'candles']) {
  test(`${id} 503 blocks release and revokes the temporary key`, async () => {
    const h = harness({ broken: id }); const result = await runCheck(h);
    assert.equal(result.passed, false); assert.equal(result.failure.stage, id);
    assert.equal(result.cleanupConfirmed, true); assert.equal(h.cleaned.length, 1);
  });
}

test('search 503 reports indexer lag and its request ID, then cleans up the fixture', async () => {
  const requestId = '56dc9ae8-ef49-41d7-b5c7-516a17f9efb2';
  const h = harness();
  const read = h.http.read;
  h.http.read = async (...args) => {
    if (operationFor(args[0]) !== 'search') return read(...args);
    const unavailable = response({ groups: [{ group: 'coins', section: { state: 'unavailable', reason: 'indexer-lag' } }] }, 503);
    unavailable.headers.set('x-request-id', requestId);
    return unavailable;
  };
  const result = await runCheck(h);
  assert.equal(result.passed, false);
  assert.deepEqual(result.failure, {
    stage: 'search',
    message: `Expected 200; received 503 (indexer-lag). Request ID ${requestId}.`,
  });
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(h.cleaned.length, 1);
});

test('search diagnostics omit unrecognized reasons and malformed request IDs', () => {
  const unavailable = response({ groups: [{ group: 'coins', section: { state: 'unavailable', reason: key } }] }, 503);
  unavailable.headers.set('x-request-id', key);
  assert.throws(() => validateRead('search', unavailable), { message: 'Expected 200; received 503 (unclassified).' });
});

test('empty presale inventory is an explicit failure, never a silently skipped detail test', async () => {
  const h = harness({ emptyPresales: true }); const result = await runCheck(h);
  assert.equal(result.passed, false); assert.match(result.failure.message, /No real presale/); assert.equal(h.cleaned.length, 1);
});
test('explicit empty bootstrap verifies a missing detail and revocation', async () => {
  const h = harness({ emptyPresales: true });
  const result = await runCheck({ ...h, allowEmptyPresales: true });
  assert.equal(result.passed, true);
  assert.equal(result.presaleDetail, 'empty-bootstrap');
  assert.equal(result.poolDetail, 'empty-bootstrap');
  // A random pool is never read with the live key, only checked as refused after revocation.
  assert.equal(h.routes.filter(path => path.startsWith('/api/v1/market/pools/')).length, 2);
  assert.ok(result.checks.some(c => /^revoked \/api\/v1\/market\/pools\/blast_curve\/0x[0-9a-f]{64}\/candles$/.test(c.operation) && c.status === 401));
  assert.equal(result.cleanupConfirmed, true);
  assert.ok(result.checks.some(c => c.operation === 'presale-missing' && c.status === 404));
  assert.ok(result.checks.some(c => /^revoked \/api\/v1\/presales\/0x[0-9a-f]{64}$/.test(c.operation) && c.status === 401));
  assert.ok(h.routes.some(path => path.startsWith('/api/v1/prices?') && !new URL(path, 'https://fixture.test').searchParams.has('presale')));
});
for (const [operation, makeInconsistent] of [
  ['presales', body => { body.next_cursor = 'remaining'; }],
  ['featured', body => { body.presales = fixtures.presales.presales; }],
]) {
  test(`empty bootstrap rejects inconsistent ${operation} evidence`, async () => {
    const h = harness({ emptyPresales: true });
    const read = h.http.read;
    h.http.read = async (...args) => {
      const result = await read(...args);
      if (result.status === 200 && result.body && operationFor(args[0]) === operation)
        makeInconsistent(result.body);
      return result;
    };
    const result = await runCheck({ ...h, allowEmptyPresales: true });
    assert.equal(result.passed, false);
    assert.equal(result.failure.stage, operation);
    assert.equal(result.cleanupConfirmed, true);
  });
}
test('bootstrap approval retains the positive detail check for populated lists', async () => {
  const result = await runCheck({ ...harness(), allowEmptyPresales: true });
  assert.equal(result.passed, true);
  assert.equal(result.presaleDetail, 'populated');
  assert.ok(result.checks.some(c => c.operation === 'presale' && c.status === 200));
});
for (const [status, code] of [[503, 'not_found'], [404, 'other'], [401, 'partner_key_invalid']]) {
  test(`empty bootstrap rejects unexpected detail HTTP ${status} ${code}`, async () => {
    const h = harness({ emptyPresales: true, missingResponse: response({ error: { code } }, status) });
    const result = await runCheck({ ...h, allowEmptyPresales: true });
    assert.equal(result.passed, false);
    assert.equal(result.failure.stage, 'presale-missing');
    assert.equal(result.cleanupConfirmed, true);
  });
}
test('no bonding-curve launch fails without bootstrap approval', async () => {
  const h = harness({ emptyLaunches: true }); const result = await runCheck(h);
  assert.equal(result.passed, false); assert.match(result.failure.message, /No bonding-curve launch/);
  assert.equal(result.cleanupConfirmed, true);
});
test('the curve pool and its candles are read with the discovered launch ID, then refused after revocation', async () => {
  const h = harness(); const result = await runCheck(h);
  const pool = `/api/v1/market/pools/blast_curve/${fixtures.discovery.section.data.rows[0].launchId}`;
  assert.equal(result.poolDetail, 'populated');
  assert.equal(result.candles, 'populated');
  assert.ok(h.routes.includes(pool) && h.routes.includes(`${pool}/candles?interval=1m&limit=2`));
  assert.ok(result.checks.some(c => c.operation === `revoked ${pool}` && c.status === 401));
  assert.ok(result.checks.some(c => c.operation === `revoked ${pool}/candles` && c.status === 401));
});
test('a pool read answering for another pool blocks release', async () => {
  const h = harness(); const read = h.http.read;
  h.http.read = async (...args) => {
    const result = await read(...args);
    if (result.status === 200 && operationFor(args[0]) === 'pool')
      result.body.pool.pool_key = `blast_curve:0x${'f'.repeat(64)}`;
    return result;
  };
  const result = await runCheck(h);
  assert.equal(result.passed, false); assert.equal(result.failure.stage, 'pool');
  assert.match(result.failure.message, /different pool/);
});
test('a revoked key accepted once blocks release even if later requests would return 401', async () => {
  const h = harness({ delayedRevocation: true }); const result = await runCheck(h);
  assert.equal(result.passed, false); assert.equal(result.failure.stage, 'revocation');
  assert.match(result.failure.message, /immediately/); assert.equal(h.cleaned.length, 1);
});
for (const option of ['badIssue', 'loseIssue', 'losePartner', 'failRevoke', 'failCleanup']) {
  test(`${option}: failure is sanitized and independent cleanup is attempted`, async () => {
    const h = harness({ [option]: true }); const result = await runCheck(h);
    assert.equal(result.passed, false); assert.equal(h.cleaned.length, 1);
    assert.equal(result.cleanupConfirmed, option !== 'failCleanup');
    assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(result).includes('secret connection'));
  });
}
test('schema, freshness, version and caching regressions fail even with HTTP 200', () => {
  for (const id of Object.keys(fixtures)) assert.doesNotThrow(() => validateRead(id, response(fixtures[id])));
  assert.throws(() => validateRead('presales', response({ presales: [] })), /schema/);
  const missing = response(fixtures.presales); missing.headers.delete('x-blast-api-version');
  assert.throws(() => validateRead('presales', missing), /v1/);
  const cached = response(fixtures.presales); cached.headers.set('cache-control', 'public');
  assert.throws(() => validateRead('presales', cached), /caching/);
  assert.throws(() => validateRead('status', response({ ...fixtures.status, lag_ms: 300001 })), /behind/);
  const search = structuredClone(fixtures.search); search.groups[0].section = { state: 'unavailable', reason: 'no-source' };
  assert.throws(() => validateRead('search', response(search)), /unavailable/);
});
test('schema failures identify pinned rules without logging response values', () => {
  const invalid = structuredClone(fixtures.presale);
  invalid.presale.name = key;
  invalid.presale.start_ms = 'private-response-value';
  assert.throws(() => validateRead('presale', response(invalid)), error =>
    error instanceof GateFailure && /start_ms\/type/.test(error.message) &&
    !error.message.includes(key) && !error.message.includes('private-response-value'));
});
test('transport confines admin credentials to admin calls, refuses redirects and sanitizes invalid JSON', async () => {
  const calls = [];
  const options = { origin: 'https://candidate.test', adminOrigin: 'https://backend.test', token: 'private-admin-token'.repeat(2) };
  const http = createHttp({ ...options, fetcher: async (url, init) => {
    calls.push({ url, init }); return Response.json({ ok: true });
  } });
  await http.admin({ action: 'issue', partnerId: PARTNER, label: 'test' }); await http.read('/api/v1/presales', key);
  assert.equal(calls[0].url.href, 'https://backend.test/api/admin/partner-keys');
  assert.equal(calls[1].url.href, 'https://candidate.test/api/v1/presales');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + options.token);
  assert.equal(calls[0].init.headers['X-Blast-Partner-Key'], undefined);
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers['X-Blast-Partner-Key'], key);
  assert.ok(calls.every(c => c.init.headers['x-vercel-forwarded-for'] === undefined));
  assert.ok(calls.every(c => c.init.redirect === 'error' && c.init.cache === 'no-store'));
  const bad = createHttp({ ...options, fetcher: async () => new Response(key) });
  await assert.rejects(bad.admin(), error => error instanceof GateFailure && !error.message.includes(key));
  await assert.rejects(http.read('https://elsewhere.test/api/v1/presales', key), GateFailure);
  await assert.rejects(http.read('//elsewhere.test/api/v1/presales', key), GateFailure);
  assert.equal(calls.length, 2);
  assert.throws(() => createHttp({ ...options, token: '' }), GateFailure);
  assert.throws(() => createHttp({ ...options, adminOrigin: 'https://user:secret@backend.test' }), GateFailure);
  for (const value of ['https://a.test/path', 'https://user:password@a.test', 'http://a.test', 'https://a.test/'])
    assert.throws(() => checkedOrigin(value));
});
test('a run cancelled before operator admission performs no cleanup writes', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort();
  const result = await runCheck({ ...h, signal: controller.signal });
  assert.equal(result.passed, false); assert.equal(h.cleaned.length, 0);
  assert.equal(result.failure.stage, 'operator-preflight');
});
test('an interrupted authorized run still performs cleanup and fails closed', async () => {
  const h = harness(); const controller = new AbortController(); const admin = h.http.admin;
  h.http.admin = async change => {
    const response = await admin(change);
    if (change?.action === 'issue') controller.abort();
    return response;
  };
  const result = await runCheck({ ...h, signal: controller.signal });
  assert.equal(result.passed, false); assert.equal(h.cleaned.length, 1);
});

test('docs controls receive the issued key and must pass both phases around admin revocation', async () => {
  const h = harness(); const phases = [];
  const docs = {
    async success(supplied) {
      assert.equal(supplied, key); phases.push('success');
      assert.equal((await h.http.read('/api/v1/market/status', key)).status, 200);
      return [{ operation: 'docs-reference', status: 200 }, { operation: 'docs-playground', status: 200 }];
    },
    async revoked(acknowledged) {
      assert.equal(typeof acknowledged, 'number'); phases.push('revoked');
      assert.equal((await h.http.read('/api/v1/market/status', key)).status, 401);
      return [{ operation: 'docs-reference', status: 401 }, { operation: 'docs-playground', status: 401 }];
    },
  };
  const report = await runCheck({ ...h, docs });
  assert.equal(report.passed, true); assert.deepEqual(phases, ['success', 'revoked']);
  assert.equal(report.checks.filter(c => c.operation.startsWith('docs-')).length, 4);
});

for (const phase of ['success', 'revoked']) {
  test(`docs ${phase} failure blocks release and still revokes the test key`, async () => {
    const h = harness();
    const docs = { async success() { return []; }, async revoked() { return []; } };
    docs[phase] = async () => { throw new Error('Browser exception containing ' + key); };
    const report = await runCheck({ ...h, docs });
    assert.equal(report.passed, false); assert.equal(report.cleanupConfirmed, true);
    assert.equal(report.failure.stage, phase === 'success' ? 'docs-success' : 'docs-revocation');
    assert.equal(h.cleaned.length, 1); assert.ok(!JSON.stringify(report).includes(key));
  });
}

test('503 diagnostics identify only known market failure reasons', () => {
  const cases = [
    ['Market data is unavailable. Try again shortly.', 'rate-limiter'],
    ['Market data is temporarily unavailable. Please retry.', 'upstream'],
    ['Market data is not configured here.', 'configuration'],
    [key, 'unclassified'],
  ];
  for (const [message, reason] of cases) {
    assert.throws(() => validateRead('status', response({ error: { message } }, 503)), error =>
      error instanceof GateFailure && error.message.includes(reason) && !error.message.includes(key));
  }
});

test('compiled transport reaches backend admin and satisfies the unchanged production ingress contract', async (t) => {
  const calls = [];
  async function listen(handler) {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const adminOrigin = await listen((request, response) => {
    calls.push({ destination: 'backend', headers: request.headers });
    response.writeHead(request.headers.authorization === 'Bearer ' + 'existing-operator-token'.repeat(2) ? 200 : 401,
      { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  const origin = await listen((request, response) => {
    calls.push({ destination: 'candidate', headers: request.headers });
    const incoming = new Request('http://127.0.0.1' + request.url, { headers: request.headers });
    const address = frontendClientAddress(incoming, { vercel: true, localRun: false });
    response.writeHead(request.url.startsWith('/api/admin/') ? 404 : address ? 200 : 503,
      { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  const controller = new AbortController();
  const token = 'existing-operator-token'.repeat(2);
  const http = createHttp({ origin, token, signal: controller.signal, adminOrigin,
    readFetcher: createCandidateFetch(origin, { compiled: true }) });
  const admin = await http.admin({ action: 'issue' });
  const read = await http.read('/api/v1/market/status', key);
  controller.abort();
  const cleanupRevoke = await http.admin({ action: 'revoke', id: keyId }, true);
  assert.deepEqual([admin.status, read.status], [200, 200]);
  assert.equal(cleanupRevoke.status, 200);
  assert.deepEqual(calls.map(call => call.destination), ['backend', 'candidate', 'backend']);
  assert.equal(calls[0].headers['x-vercel-forwarded-for'], undefined);
  assert.equal(calls[0].headers['x-blast-partner-key'], undefined);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers['x-vercel-forwarded-for'], '127.0.0.1');
  assert.equal(calls[2].headers.authorization, 'Bearer ' + 'existing-operator-token'.repeat(2));
  assert.equal(calls[2].headers['x-vercel-forwarded-for'], undefined);
});

test('compiled ingress cannot be attached to a remote target and backend configuration is mandatory', () => {
  assert.throws(() => createCandidateFetch('https://web.test', { compiled: true }));
  assert.throws(() => createHttp({ origin: 'http://127.0.0.1:3000', token: 'operator'.repeat(8) }));
});

const reservedFixture = 'a1111111-2222-4333-8444-555555555555';
test('a mismatched backend and cleanup database never issue a key or claim cleanup', async () => {
  const h = harness(); const actions = [];
  h.cleanup.claim = async () => true;
  h.cleanup.prove = async () => false;
  const admin = h.http.admin;
  h.http.admin = async change => { if (change) actions.push(change.action); return admin(change); };
  const report = await runCheck({ ...h, fixtureId: reservedFixture });
  assert.equal(report.passed, false);
  assert.deepEqual(actions, ['create-partner']);
  assert.equal(h.routes.length, 0);
  assert.equal(report.cleanupConfirmed, false);
});

test('a busy reserved fixture is refused before database or backend mutation', async () => {
  const h = harness(); const mutations = [];
  h.cleanup.claim = async () => false;
  h.cleanup.stale = async () => { mutations.push('stale'); };
  h.cleanup.run = async () => { mutations.push('remove'); };
  const admin = h.http.admin;
  h.http.admin = async change => {
    if (!change) return admin();
    mutations.push('admin'); throw new Error('Unexpected mutation');
  };
  const report = await runCheck({ ...h, fixtureId: reservedFixture });
  assert.equal(report.passed, false);
  assert.equal(report.cleanupConfirmed, false);
  assert.deepEqual(mutations, []);
});

test('the configured fixture retains its exact capacity tenant and cleanup identity', async () => {
  const h = harness(); const claimed = [];
  h.cleanup.claim = async id => { claimed.push(id); return true; };
  h.cleanup.prove = async id => id === `${PARTNER}-${reservedFixture}`;
  const report = await runCheck({ ...h, fixtureId: reservedFixture });
  assert.equal(report.passed, true);
  assert.deepEqual(claimed, [reservedFixture]);
  assert.equal(h.cleaned.at(-1), `release-gate:${reservedFixture}`);
});

test('missing or invalid fixture identities fail before any mutation', async () => {
  assert.throws(() => checkedFixtureId(undefined), /BLAST_PARTNER_RELEASE_FIXTURE_UUID/);
  for (const fixtureId of ['', 'not-a-uuid', reservedFixture.toUpperCase()]) {
    const h = harness(); let mutated = false;
    const admin = h.http.admin;
    h.http.admin = async change => {
      if (!change) return admin();
      mutated = true; throw new Error('Unexpected mutation');
    };
    h.cleanup.stale = h.cleanup.run = async () => { mutated = true; };
    const report = await runCheck({ ...h, fixtureId });
    assert.equal(report.passed, false);
    assert.equal(report.cleanupConfirmed, false);
    assert.equal(mutated, false);
  }
});

test('an aborted read still revokes a known issued key through authenticated cleanup transport', async () => {
  const h = harness(); const controller = new AbortController(); const revoked = [];
  const admin = h.http.admin;
  h.http.admin = async (change, cleanup) => {
    if (change?.action === 'revoke') revoked.push({ id: change.id, cleanup });
    return admin(change);
  };
  h.http.read = async () => { controller.abort(); throw new Error('Interrupted read'); };
  const report = await runCheck({ ...h, signal: controller.signal });
  assert.equal(report.passed, false);
  assert.deepEqual(revoked, [{ id: keyId, cleanup: true }]);
});

test('losing the fixture lock after identity proof aborts before key issuance', async () => {
  const h = harness(); const lock = new AbortController(); const actions = [];
  h.cleanup.signal = lock.signal;
  h.cleanup.prove = async () => { lock.abort(); return true; };
  const admin = h.http.admin;
  h.http.admin = async change => { if (change) actions.push(change.action); return admin(change); };
  const report = await runCheck(h);
  assert.equal(report.passed, false);
  assert.deepEqual(actions, ['create-partner']);
  assert.equal(h.routes.length, 0);
});
