import { checkedAdminOrigin, checkedOrigin, GateFailure } from './check.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { databaseConnectionUrl } from '../../../../packages/core/src/modules/database/topology.ts';
import { deploymentIdentity } from '../../../../packages/core/src/lib/config/deployment-identity.ts';
import { quotaNamespace } from '../../../../packages/core/src/lib/web-security/redis-rate-limits.ts';
import { parseWebConfig } from '../../src/lib/web-config.ts';

export class StartupFailure extends GateFailure {
  constructor(stage, category, status = null) {
    super(`Partner API gate ${stage} failed (${category}${status === null ? '' : `; HTTP ${status}`}).`);
    this.stage = stage; this.category = category; this.status = status;
  }
}

export function startupReport(error, stage) {
  const failure = error instanceof StartupFailure
    ? { stage: error.stage, category: error.category, readinessStatus: error.status }
    : { stage, category: 'startup_or_dependency_failure', readinessStatus: null };
  return { gate: 'partner-api-live', passed: false, cleanupConfirmed: false, failure };
}

/**
 * A generic Vercel feature preview (target `preview`, not the custom develop environment) is UI-only:
 * it publishes without the live check. Every pushed branch builds there with its own code, so it never
 * holds an operator credential; check a preview from a trusted context with `--origin` instead.
 * develop and production run the full check.
 */
export function uiOnlyFeaturePreview(environment) {
  return deploymentIdentity(environment).target === 'preview';
}

/** Operator credentials a feature preview build must never be given (branch code runs with them). */
export const PREVIEW_FORBIDDEN_CREDENTIALS = Object.freeze(['PRESALE_ADMIN_TOKEN', 'CRON_SECRET']);

/** Fails a feature preview build that was handed an operator credential, naming none of its values. */
export function refusePreviewCredentials(environment) {
  if (PREVIEW_FORBIDDEN_CREDENTIALS.some((name) => environment[name] !== undefined))
    throw new StartupFailure('preflight', 'preview_operator_credential');
}

/** Validate configuration before either cleanup or key issuance can run. No network I/O. */
export function gateConfiguration(environment, { built = false, origin } = {}) {
  let databaseUrl; let adminOrigin; let candidateOrigin;
  try { databaseUrl = databaseConnectionUrl(environment.DATABASE_URL); }
  catch { throw new StartupFailure('preflight', 'database_configuration'); }
  const token = environment.PRESALE_ADMIN_TOKEN;
  if (typeof token !== 'string' || token.length < 32)
    throw new StartupFailure('preflight', 'operator_credential');
  try {
    const authorization = `Bearer ${token}`;
    if (new Headers({ authorization }).get('authorization') !== authorization) throw new Error();
  }
  catch { throw new StartupFailure('preflight', 'operator_credential'); }
  if (built) refuseInvalidWebConfiguration(environment);
  try { adminOrigin = checkedAdminOrigin(environment.BLAST_BACKEND_API_ORIGIN); }
  catch { throw new StartupFailure('preflight', 'backend_origin'); }
  if ((environment.BLAST_BACKEND_GATEWAY_SECRET?.length ?? 0) < 32)
    throw new StartupFailure('preflight', 'backend_gateway_configuration');
  let identity;
  try {
    identity = deploymentIdentity(environment);
    quotaNamespace(environment.BLAST_REDIS_NAMESPACE, identity);
  }
  catch { throw new StartupFailure('preflight', 'quota_namespace_configuration'); }
  if (identity.target !== 'local' && !identity.production && (!identity.branch || identity.branch === 'local'))
    throw new StartupFailure('preflight', 'unsupported_topology');
  if (!built) {
    try { candidateOrigin = checkedOrigin(origin); }
    catch { throw new StartupFailure('preflight', 'candidate_origin'); }
    if (candidateOrigin === adminOrigin) throw new StartupFailure('preflight', 'unsupported_topology');
  }
  return { databaseUrl, adminOrigin, token, origin: candidateOrigin };
}

/**
 * The build parses the settings the deployed server will (`web-config.ts`), so a bad one fails the
 * build, not requests. Production requires its five; the checks after this still require the relay
 * values everywhere this gate runs. The category names the variable (the message's first word),
 * never its value.
 */
export function refuseInvalidWebConfiguration(environment) {
  try { parseWebConfig(environment); }
  catch (error) {
    const name = error instanceof Error ? error.message.split(' ', 1)[0] : '';
    throw new StartupFailure('preflight', /^[A-Z][A-Z0-9_]*$/.test(name) ? `web_configuration:${name}` : 'web_configuration');
  }
}

/** Only the verifier's owned compiled child receives simulated platform ingress. */
export function createCandidateFetch(origin, { compiled = false, fetcher = fetch } = {}) {
  checkedOrigin(origin);
  const owner = new URL(origin);
  if (compiled && !(owner.protocol === 'http:' && owner.hostname === '127.0.0.1' && owner.port))
    throw new GateFailure('Compiled ingress requires the owned loopback origin.');
  return async (input, init = {}) => {
    const target = new URL(input);
    const method = init.method ?? 'GET';
    const allowedPath = target.pathname.startsWith('/api/v1/') ||
      ['/api/social/presales', '/api/launchpad/search'].includes(target.pathname);
    if (target.origin !== origin || !allowedPath || !['GET', 'HEAD'].includes(method))
      throw new GateFailure('Candidate read escaped its configured transport.');
    const headers = new Headers(init.headers);
    if (headers.has('authorization') || headers.has('cookie'))
      throw new GateFailure('Candidate transport refuses private credentials.');
    headers.delete('x-vercel-forwarded-for');
    if (compiled) headers.set('x-vercel-forwarded-for', '127.0.0.1');
    return fetcher(target, { ...init, headers, redirect: 'error', cache: 'no-store' });
  };
}

/** Admission, rather than a generic 200/503, establishes that the candidate is ready. */
export async function waitForServer({ origin, transport, server, signal,
  attempts = 120, intervalMs = 250, requestTimeoutMs = 1000 }) {
  const childStopped = new AbortController();
  const stopped = () => childStopped.abort();
  server.once('exit', stopped);
  const active = signal ? AbortSignal.any([signal, childStopped.signal]) : childStopped.signal;
  let status = null;
  function assertActive() {
    if (signal?.aborted) throw new StartupFailure('readiness', 'interrupted', status);
    if (server.exitCode !== null || server.signalCode !== null || childStopped.signal.aborted)
      throw new StartupFailure('readiness', 'candidate_stopped', status);
  }
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      assertActive();
      try {
        const response = await transport(new URL('/api/v1/presales', origin), {
          signal: AbortSignal.any([active, AbortSignal.timeout(requestTimeoutMs)]),
        });
        status = response.status;
        await response.body?.cancel();
        assertActive();
        if (status === 401) return;
      } catch { assertActive(); }
      if (attempt + 1 < attempts) await delay(intervalMs, undefined, { signal: active });
    }
    throw new StartupFailure('readiness', 'admission_not_ready', status);
  } catch (error) {
    assertActive();
    if (error instanceof StartupFailure) throw error;
    throw new StartupFailure('readiness', 'admission_not_ready', status);
  } finally { server.removeListener('exit', stopped); }
}
