import { isDeepStrictEqual } from 'node:util';
import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';
import { GateFailure, validateBody } from './check.mjs';

const ORIGIN = 'https://docs.blast.fun';
const RELAY = ORIGIN + '/api/partner-playground';
const TIMEOUT = 25_000;

function requireCondition(ok, message) { if (!ok) throw new GateFailure(message); }

/** The only response metadata a failure may report: an HTTP status code, or a marker. Never a body or header. */
function statusLabel(value) {
  if (value === undefined || value === null) return 'missing';
  return Number.isInteger(value) && value >= 100 && value <= 599 ? String(value) : 'malformed';
}

/** Validate the actual relay result, not its outer HTTP 200 envelope or a static example. */
export function validateDocsResponse(response, expected) {
  requireCondition(response.status === 200, `Docs relay did not return HTTP 200 (got ${statusLabel(response.status)}).`);
  const result = response.body;
  requireCondition(result?.status === expected,
    `Docs API response did not return ${expected} (got ${statusLabel(result?.status)}).`);
  requireCondition(result.headers?.['content-type']?.includes('application/json') &&
    result.headers?.['cache-control']?.includes('no-store'), 'Docs API response is not uncached JSON.');
  let body;
  try { body = JSON.parse(result.body); } catch { throw new GateFailure('Docs API response is not valid JSON.'); }
  if (expected === 200) validateBody('status', body);
  else requireCondition(body?.error?.code === 'partner_key_invalid', 'Docs did not show a revoked-key error.');
  return body;
}

async function settle(jobs) {
  const results = await Promise.allSettled(jobs);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

/** One ephemeral Chromium context, two tabs. No traces, screenshots, HARs or saved auth state. */
export function createDocsCheck(signal) {
  let browser; let context; let clients = []; let issuedKey;
  const close = async () => { await browser?.close(); browser = undefined; clients = []; issuedKey = undefined; };
  const interrupted = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', interrupted, { once: true });

  async function prepare(key) {
    signal?.throwIfAborted();
    issuedKey = key;
    const executablePath = await chromium.executablePath();
    // Do not pass database/admin credentials to the browser process. Keep browser security enabled.
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LD_LIBRARY_PATH', 'FONTCONFIG_PATH']
      .filter(name => process.env[name]).map(name => [name, process.env[name]]));
    browser = await playwright.launch({ executablePath, env, headless: true, timeout: TIMEOUT,
      args: chromium.args.filter(arg => !['--disable-web-security', '--allow-running-insecure-content',
        '--disable-site-isolation-trials'].includes(arg)),
    });
    signal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1414, height: 1000 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    clients = await settle([prepareReference(key), preparePlayground(key)]);
  }

  async function prepareReference(key) {
    const page = await context.newPage();
    await page.goto(ORIGIN + '/developers/partner-api/endpoints/#tag/market-data/market-status');
    await page.locator('#reference[data-state="ready"]').waitFor();
    await page.getByRole('button', { name: 'Test Request (get /api/v1/market/status)', exact: true }).click();
    await page.getByRole('region', { name: 'Request: Market status', exact: true })
      .getByRole('textbox', { name: 'Value', exact: true }).fill(key);
    const response = page.getByRole('region', { name: 'Response', exact: true });
    return { name: 'docs-reference', page,
      send: page.getByRole('button', { name: 'Send get request to https://www.blast.fun/api/v1/market/status', exact: true }),
      status: expected => response.getByRole('link', { name: expected === 200 ? '200 OK' : '401 Unauthorized', exact: true }),
      body: response.getByRole('textbox'),
    };
  }

  async function preparePlayground(key) {
    const page = await context.newPage();
    await page.goto(ORIGIN + '/developers/partner-api/playground/');
    const root = page.getByRole('region', { name: 'Try the partner API', exact: true });
    await root.getByLabel('Endpoint', { exact: true }).selectOption('status');
    await root.getByLabel('Partner API key', { exact: true }).fill(key);
    return { name: 'docs-playground', page,
      send: root.getByRole('button', { name: 'Send request' }),
      status: expected => root.locator('[data-status]').filter({ hasText: `HTTP ${expected} ·` }),
      body: root.getByLabel('Response body', { exact: true }),
    };
  }

  async function send(client, expected, acknowledged) {
    signal?.throwIfAborted();
    // Observe a NEW real network response from this click. Never mock/intercept or retry the request.
    const responsePromise = client.page.waitForResponse(r => r.url() === RELAY && r.request().method() === 'POST');
    const startedAfterMs = acknowledged === undefined ? undefined : Math.round(performance.now() - acknowledged);
    const [response] = await settle([responsePromise, client.send.click()]);
    const request = response.request().postDataJSON();
    requireCondition(request.endpoint === 'status' && request.key === issuedKey, 'Docs sent the wrong endpoint or key.');
    const body = validateDocsResponse({ status: response.status(), body: await response.json() }, expected);
    await client.status(expected).waitFor();
    await client.body.waitFor();
    // CodeMirror's DOM and the playground's <pre> must show this exact response, not just a status badge.
    let displayed;
    try { displayed = JSON.parse(await client.body.textContent()); }
    catch { throw new GateFailure('Docs rendered an invalid response body.'); }
    requireCondition(isDeepStrictEqual(displayed, body), 'Docs displayed a stale or different response body.');
    return { operation: client.name, status: expected, ...(acknowledged === undefined ? {} : { startedAfterMs }) };
  }

  return {
    async success(key) {
      try { await prepare(key); return await settle(clients.map(client => send(client, 200))); }
      catch (error) {
        // Playwright errors may include fill arguments and page content. Never expose them.
        throw new GateFailure(error instanceof GateFailure ? error.message : 'Docs browser could not complete the successful request.');
      }
    },
    async revoked(acknowledged) {
      try {
        requireCondition(clients.length === 2 && browser?.isConnected(), 'Docs browser closed before revocation verification.');
        return await settle(clients.map(client => send(client, 401, acknowledged)));
      }
      catch (error) { throw new GateFailure(error instanceof GateFailure ? error.message : 'Docs browser could not display immediate revocation.'); }
    },
    async close() { signal?.removeEventListener('abort', interrupted); await close(); },
  };
}
