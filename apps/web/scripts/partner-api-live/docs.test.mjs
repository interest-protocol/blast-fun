import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createDocsCheck, validateDocsResponse } from './docs.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./responses.fixture.json', import.meta.url)));
const reply = (status, body) => ({ status: 200, body: { status,
  headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' }, body: JSON.stringify(body) } });
const refused = { error: { code: 'partner_key_invalid' } };

test('docs relay envelope must contain a live schema-valid response or the exact revocation error', () => {
  assert.deepEqual(validateDocsResponse(reply(200, fixtures.status), 200), fixtures.status);
  assert.deepEqual(validateDocsResponse(reply(401, refused), 401), refused);
});
test('outer 200 cannot hide API errors, stale data, malformed JSON, caching or delayed revocation', () => {
  for (const response of [reply(503, {}), reply(200, {}), reply(200, { ...fixtures.status, lag_ms: 300001 })])
    assert.throws(() => validateDocsResponse(response, 200));
  assert.throws(() => validateDocsResponse(reply(200, fixtures.status), 401));
  assert.throws(() => validateDocsResponse(reply(401, { error: { code: 'wrong_error' } }), 401));
  const bad = reply(200, fixtures.status); bad.body.body = 'blast_pk_SECRET';
  assert.throws(() => validateDocsResponse(bad, 200), error => !error.message.includes('SECRET'));
  const cached = reply(200, fixtures.status); cached.body.headers['cache-control'] = 'public';
  assert.throws(() => validateDocsResponse(cached, 200));
});

test('a status failure reports the actual outer and inner status codes and nothing else from the response', () => {
  const failure = (response, expected) => {
    try { validateDocsResponse(response, expected); } catch (error) { return error.message; }
    assert.fail('expected a gate failure');
  };
  assert.equal(failure(reply(429, {}), 200), 'Docs API response did not return 200 (got 429).');
  assert.equal(failure(reply(200, fixtures.status), 401), 'Docs API response did not return 401 (got 200).');
  assert.equal(failure({ status: 502, body: {} }, 200), 'Docs relay did not return HTTP 200 (got 502).');
  assert.equal(failure({ status: 200, body: { body: '{}' } }, 200), 'Docs API response did not return 200 (got missing).');
  assert.equal(failure({ status: 200, body: null }, 200), 'Docs API response did not return 200 (got missing).');
  // A status that is not an HTTP code is never echoed: it could carry anything the relay returned.
  for (const status of ['blast_pk_SECRET', 200.5, 42, { secret: 'blast_pk_SECRET' }])
    assert.equal(failure({ status: 200, body: { status, body: 'blast_pk_SECRET' } }, 200), 'Docs API response did not return 200 (got malformed).');
  assert.equal(failure({ status: 'blast_pk_SECRET', body: {} }, 200), 'Docs relay did not return HTTP 200 (got malformed).');
});

test('missing or closed browser cannot silently skip the revocation phase', async () => {
  const docs = createDocsCheck();
  try { await assert.rejects(docs.revoked(performance.now()), /closed before revocation/); }
  finally { await docs.close(); }
});
