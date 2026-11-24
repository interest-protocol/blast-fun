import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

export const PARTNER = 'ci-partner-read-api';
export const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url)));
const schemaId = 'https://blast.fun/release-gate/partner-v1';
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: schemaId, components: contract.components });
const validators = Object.fromEntries(Object.entries(contract.operations).map(([id, operation]) => [id,
  ajv.compile(JSON.parse(JSON.stringify(operation.schema).replaceAll('"#/components/', `"${schemaId}#/components/`))),
]));
const SUI = '0x' + '2'.padStart(64, '0') + '::sui::SUI';
const KEY = /^blast_pk_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class GateFailure extends Error {}
function requireCondition(ok, message) { if (!ok) throw new GateFailure(message); }

export function checkedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new GateFailure('Invalid target origin.'); }
  requireCondition(url.origin === value && !url.username && !url.password &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')),
  'Target must be an HTTPS origin or the loopback build server.');
  return url.origin;
}

export function checkedFixtureId(value) {
  requireCondition(typeof value === 'string' && UUID.test(value),
    'BLAST_PARTNER_RELEASE_FIXTURE_UUID must be a canonical lowercase UUID reserved in backend capacity.');
  return value;
}

export function checkedAdminOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new GateFailure('Invalid backend operator origin.'); }
  requireCondition(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))),
  'Invalid backend operator origin.');
  return url.origin;
}

async function jsonBody(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new GateFailure('Missing response body.');
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw new GateFailure('Response exceeded 2 MB.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Errors contain stage/status only. Never log a key, response body, or fetch exception. */
export function createHttp({ origin, adminOrigin, token, fetcher = fetch, readFetcher = fetcher, signal }) {
  checkedOrigin(origin);
  adminOrigin = checkedAdminOrigin(adminOrigin);
  requireCondition(typeof token === 'string' && token.length >= 32, 'A configured backend operator credential is required.');
  async function request(path, { key, method = 'GET', change, admin = false, cleanup = false } = {}) {
    const target = new URL(path, admin ? adminOrigin : origin);
    requireCondition(path.startsWith('/') && !path.startsWith('//') && target.origin === (admin ? adminOrigin : origin),
      'Request escaped its configured origin.');
    const timeout = AbortSignal.timeout(15_000);
    const headers = admin ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      : (key ? { 'X-Blast-Partner-Key': key } : {});
    let response;
    try {
      response = await (admin ? fetcher : readFetcher)(target, {
        method, headers, body: change ? JSON.stringify(change) : undefined,
        redirect: 'error', cache: 'no-store',
        signal: signal && !cleanup ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const body = method === 'HEAD' ? null : await jsonBody(response);
      requireCondition(method === 'HEAD' || response.headers.get('content-type')?.includes('application/json'), 'Expected JSON response.');
      return { status: response.status, body, headers: response.headers };
    } catch (error) {
      if (error instanceof GateFailure) throw error;
      throw new GateFailure('Request failed, timed out, redirected, or returned invalid JSON.');
    }
  }
  return {
    read: (path, key, method) => request(path, { key, method }),
    admin: (change, cleanup = false) => request('/api/admin/partner-keys', {
      admin: true, method: change ? 'POST' : 'GET', change, cleanup,
    }),
  };
}

export function validateRead(id, response) {
  if (response.status !== 200) {
    // Fixed labels distinguish dependencies without logging response values.
    const reasons = new Map([
      ['Market data is unavailable. Try again shortly.', 'rate-limiter'],
      ['Market data is temporarily unavailable. Please retry.', 'upstream'],
      ['Market data is not configured here.', 'configuration'],
    ]);
    const groups = response.body?.groups;
    const coinGroup = Array.isArray(groups) && groups.length === 1 ? groups[0] : null;
    const indexerLag = id === 'search' && response.status === 503 && coinGroup?.group === 'coins' &&
      coinGroup.section?.state === 'unavailable' && coinGroup.section.reason === 'indexer-lag';
    const reason = indexerLag ? 'indexer-lag' : reasons.get(response.body?.error?.message) ?? 'unclassified';
    const requestId = response.headers.get('x-request-id') ?? '';
    const reference = UUID.test(requestId) ? ` Request ID ${requestId}.` : '';
    throw new GateFailure(`Expected 200; received ${response.status} (${reason}).${reference}`);
  }
  requireCondition(response.headers.get('x-blast-api-version') === '1', 'Missing v1 response header.');
  requireCondition(response.headers.get('cache-control')?.includes('no-store'), 'Partner response allows caching.');
  validateBody(id, response.body);
}

export function validateBody(id, body) {
  if (!validators[id](body)) {
    // Pinned schema paths describe the failed rules without exposing response values.
    const rules = [...new Set(validators[id].errors.map(error => error.schemaPath))].slice(0, 6);
    throw new GateFailure(`Response violates the pinned ${id} schema (${rules.join(', ')}).`);
  }
  if (id === 'status') {
    requireCondition(Number.isSafeInteger(body.checkpoint) && body.checkpoint > 0,
      'Market checkpoint is missing.');
    requireCondition(Number.isFinite(body.lag_ms) && body.lag_ms <= 300_000,
      'Market data is more than five minutes behind.');
  }
  if (id === 'search') {
    requireCondition(body.groups.length > 0 && body.groups.every(group =>
      group.group === 'coins' && ['available', 'empty'].includes(group.section.state)),
    'Requested search group is missing, stale, or unavailable.');
  }
  if (id === 'discovery') {
    requireCondition(['available', 'empty'].includes(body.section.state),
      'Discovery is stale or unavailable.');
  }
}

/** Admission must finish before entering the cleanup-owning fixture lifecycle. */
async function operatorAdmission(http, signal) {
  let status = null;
  try {
    signal?.throwIfAborted();
    const admission = await http.admin();
    status = admission.status;
    requireCondition(status === 200 && Array.isArray(admission.body?.partners) && Array.isArray(admission.body?.keys),
      'Backend operator admission was not confirmed.');
    signal?.throwIfAborted();
    return null;
  } catch {
    return { stage: 'operator-preflight', category: 'operator_admission_refused', status,
      message: 'Backend operator admission was not confirmed.' };
  }
}

// Functional checks must fit even the smallest reserved response lane.
async function sequentially(items, operation) {
  if (items.length === 0) return [];
  const [item, ...remaining] = items;
  const result = await operation(item);
  return [result, ...await sequentially(remaining, operation)];
}

/**
 * The versioned presale reads: three list pages, then detail, prices, search and status.
 */
async function presaleReads({ readBatch, report, setStage }) {
  const lists = ['live', 'upcoming', 'ended'].map(status =>
    ['presales', `/api/v1/presales?status=${status}&limit=2`]);
  const pages = await readBatch(lists);
  const presaleId = pages.flatMap(page => page.presales)[0]?.presale_id;
  requireCondition(presaleId, 'No real presale exists for the detail check.');
  report.presaleDetail = 'populated';
  const cases = [
    ['featured', '/api/v1/presales/featured'],
    ['presale', `/api/v1/presales/${presaleId}`],
    ['prices', `/api/v1/prices?coin=${encodeURIComponent(SUI)}&presale=${presaleId}&window=24h&points=2`],
    ['search', '/api/v1/search?q=SUI&group=coins&limit=2'],
    ['status', '/api/v1/market/status'],
  ];
  const bodies = await readBatch(cases);
  setStage('presale');
  requireCondition(bodies[1].presale.presale_id === presaleId, 'Detail returned a different presale.');
  return [...lists, ...cases].map(([, path]) => path);
}

/**
 * One real bonding-curve pool and its candles. Discovery's newest launch names it: a curve's pool
 * ID is its launch ID. Returns the paths to revoke.
 */
async function poolReads({ readBatch, report }) {
  const discovery = ['discovery', '/api/v1/discovery?view=new&limit=1'];
  const [listed] = await readBatch([discovery]);
  const launchId = listed.section.data?.rows[0]?.launchId;
  requireCondition(launchId, 'No bonding-curve launch exists for the pool check.');
  requireCondition(listed.metrics?.[launchId], 'Discovery sent no metrics for its launch.');
  report.poolDetail = 'populated';
  const pool = ['pool', `/api/v1/market/pools/blast_curve/${launchId}`];
  const candles = ['candles', `${pool[1]}/candles?interval=1m&limit=2`];
  const paths = [discovery, pool, candles].map(([, path]) => path);
  const [detail] = await readBatch([pool]);
  requireCondition(detail.pool.pool_key === `blast_curve:${launchId}`, 'Pool read returned a different pool.');
  const [bars] = await readBatch([candles]);
  requireCondition(bars.interval === '1m', 'Candles returned a different interval.');
  report.candles = bars.candles.length > 0 ? 'populated' : 'empty';
  return paths;
}

/** Issue/revoke use the same authenticated HTTP route as the admin console. */
export async function runCheck({ http, cleanup, signal, validate = validateRead, docs, fixtureId = randomUUID() }) {
  if (cleanup.signal) signal = signal ? AbortSignal.any([signal, cleanup.signal]) : cleanup.signal;
  const runId = fixtureId;
  const label = `release-gate:${runId}`;
  const partnerId = `${PARTNER}-${runId}`;
  const report = { checks: [], cleanupConfirmed: false, passed: false };
  const admissionFailure = await operatorAdmission(http, signal);
  if (admissionFailure) return { ...report, failure: admissionFailure };
  let key; let keyId; let stage = 'prepare';
  let locked = false; let creationAttempted = false; let targetProven = false; let revocationConfirmed = false;
  function record(operation, status, extra = {}) { report.checks.push({ operation, status, ...extra }); }
  async function read(id, path) {
    signal?.throwIfAborted();
    const result = await http.read(path, key);
    validate(id, result);
    record(id, result.status);
    return result.body;
  }
  async function finishFixture() {
    // The backend remains the authoritative mutation target even when the check's deadline
    // expired or its public read failed. This independent revoke does not use the aborted signal.
    if (UUID.test(keyId) && !revocationConfirmed) {
      try { await http.admin({ action: 'revoke', id: keyId }, true); } catch { /* DB cleanup must still run. */ }
    }
    // Independent primary-DB cleanup also finds a key whose issuance response was lost.
    // It cannot turn a failed revoke assertion into a passing gate.
    try {
      if (locked && creationAttempted) {
        // Lost creation responses can still be confirmed against this freshly cleared fixture.
        if (!targetProven) targetProven = await cleanup.prove(partnerId);
        await cleanup.run(label);
        requireCondition(targetProven, 'Cleanup target was not proven.');
        report.cleanupConfirmed = true;
      }
    } catch {
      report.passed = false;
      report.cleanupConfirmed = false;
      report.cleanupFailure = 'Could not confirm test-key cleanup on the primary.';
    } finally {
      if (locked) {
        try { await cleanup.release(); }
        catch {
          report.passed = false;
          report.cleanupConfirmed = false;
          report.cleanupFailure = 'Could not release the reserved fixture lock.';
        }
      }
    }
  }
  try {
    checkedFixtureId(runId);
    signal?.throwIfAborted();
    requireCondition(await cleanup.claim(runId), 'The reserved release fixture is already in use.');
    locked = true;
    await cleanup.stale();
    // Remove only this locked fixture, including a previous interrupted run. A subsequent
    // fresh creation can then prove that the backend and cleanup database are the same target.
    await cleanup.run(label);
    signal?.throwIfAborted();
    creationAttempted = true;
    const created = await http.admin({ action: 'create-partner', id: partnerId, origins: [] });
    requireCondition(created.status === 200, 'Cannot prepare a fresh dedicated test partner.');
    targetProven = await cleanup.prove(partnerId);
    requireCondition(targetProven, 'Backend and cleanup database do not share the created release fixture.');
    signal?.throwIfAborted();
    stage = 'issue';
    const issued = await http.admin({ action: 'issue', partnerId, label });
    // Record the id before inspecting the remaining response so cleanup still works on malformed issuance.
    keyId = issued.body?.apiKey?.id;
    key = issued.body?.apiKey?.key;
    requireCondition(issued.status === 200 && UUID.test(keyId) && KEY.test(key) &&
      issued.body.apiKey.partner_id === partnerId && issued.body.apiKey.label === label,
    'Issuance did not return a valid key for this test run.');
    record('issue', 200);
    stage = 'unversioned-access';
    await sequentially(['/api/social/presales', '/api/launchpad/search?q=SUI'], async (path) => {
      const refused = await http.read(path, key);
      requireCondition(refused.status === 403 && refused.body?.error?.code === 'partner_read_forbidden' &&
        refused.headers.get('cache-control')?.includes('no-store'), 'Unversioned route accepted partner access or returned an unexpected refusal.');
      record('refused ' + path.split('?')[0], 403);
    });
    async function readBatch(cases) {
      return sequentially(cases, ([id, path]) => { stage = id; return read(id, path); });
    }
    const routes = [
      ...await presaleReads({ readBatch, report, setStage: (next) => { stage = next; } }),
      ...await poolReads({ readBatch, report }),
    ];
    stage = 'HEAD';
    const head = await http.read(routes[0], key, 'HEAD');
    requireCondition(head.status === 200 && head.body === null && head.headers.get('cache-control')?.includes('no-store'), 'HEAD did not preserve read access and no-store.');
    record('HEAD', 200);
    if (docs) {
      stage = 'docs-success';
      report.checks.push(...await docs.success(key));
    }
    stage = 'revoke';
    const revoked = await http.admin({ action: 'revoke', id: keyId });
    requireCondition(revoked.status === 200 && revoked.body?.apiKey?.id === keyId &&
      revoked.body.apiKey.revoked_at, 'Admin revocation was not confirmed.');
    revocationConfirmed = true;
    record('revoke', 200);
    const acknowledged = performance.now();
    // No sleep/retry: the very first request after acknowledgement must reject the key.
    stage = 'revocation';
    async function expectRevoked(path) {
      const startedAfterMs = Math.round(performance.now() - acknowledged);
      const response = await http.read(path, key);
      requireCondition(response.status === 401 && response.body?.error?.code === 'partner_key_invalid',
        `Revoked key was not rejected immediately (HTTP ${response.status}).`);
      record('revoked ' + path.split('?')[0], 401, { startedAfterMs });
    }
    await expectRevoked(routes[0]);
    if (docs) {
      stage = 'docs-revocation';
      report.checks.push(...await docs.revoked(acknowledged));
      stage = 'revocation';
    }
    await sequentially(routes.slice(1), expectRevoked);
    const state = await http.admin();
    requireCondition(state.status === 200 && state.body?.keys?.some(k => k.id === keyId && k.revoked_at),
      'Revoked key is missing its admin audit record.');
    report.passed = true;
  } catch (error) {
    report.failure = { stage, message: error instanceof GateFailure ? error.message : 'Check failed or was interrupted.' };
  } finally {
    await finishFixture();
    key = undefined;
  }
  return report;
}
