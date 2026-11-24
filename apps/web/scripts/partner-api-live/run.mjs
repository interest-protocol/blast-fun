import { deploymentIdentity } from '../../../../packages/core/src/lib/config/deployment-identity.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHttp, checkedFixtureId, runCheck } from './check.mjs';
import { createCleanup } from './cleanup.mjs';
import { createDocsCheck } from './docs.mjs';
import { createCandidateFetch, gateConfiguration, refuseInvalidWebConfiguration, refusePreviewCredentials, startupReport, StartupFailure, uiOnlyFeaturePreview, waitForServer } from './runtime.mjs';

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const build = args.length === 1 && args[0] === '--built';
const remote = args.length === 2 && args[0] === '--origin';
const controller = new AbortController();
const interrupt = () => { process.exitCode = 1; controller.abort(); };
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
let server; let cleanup; let deadline; let docs;
let stage = 'preflight';

async function availablePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
async function stopServer() {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const stopped = once(server, 'exit');
  server.kill('SIGTERM');
  const killTimer = setTimeout(() => server.kill('SIGKILL'), 5000);
  await stopped; clearTimeout(killTimer);
}
async function closeSafely(close) {
  try { await close(); } catch (error) {
    console.error(JSON.stringify(startupReport(error, 'cleanup'))); process.exitCode = 1;
  }
}

try {
  if (!build && !remote) throw new StartupFailure('preflight', 'arguments');
  if (build && uiOnlyFeaturePreview(process.env)) {
    // A feature preview runs branch code: an operator credential in its environment is a leak, not a check.
    refusePreviewCredentials(process.env);
    // The preview server parses these settings on every request; a bad one fails the build, not the site.
    refuseInvalidWebConfiguration(process.env);
    // Recorded as skipped, never as passed: this build ships no partner API release candidate.
    console.log(JSON.stringify({ gate: 'partner-api-live', skipped: 'ui_only_feature_preview',
      target: deploymentIdentity(process.env).target, commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null }));
  } else {
    const config = gateConfiguration(process.env, { built: build, origin: remote ? args[1] : undefined });
    const fixtureId = checkedFixtureId(process.env.BLAST_PARTNER_RELEASE_FIXTURE_UUID);
    let origin = config.origin; let transport;
    deadline = setTimeout(interrupt, 240_000);
    cleanup = createCleanup(config.databaseUrl);
    // Lock loss cancels ordinary work; authenticated cleanup revocation keeps its independent timeout.
    const requestSignal = AbortSignal.any([controller.signal, cleanup.signal]);
    if (build) {
      const port = await availablePort(); origin = `http://127.0.0.1:${port}`;
      transport = createCandidateFetch(origin, { compiled: true });
      const environment = { ...process.env, NODE_ENV: 'production', VERCEL: '1' };
      delete environment.PRESALE_ADMIN_TOKEN;
      // No server output is piped to the deployment log: a broken handler could echo credentials.
      stage = 'spawn';
      server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
        cwd, env: environment, stdio: 'ignore',
      });
      server.once('error', interrupt);
      stage = 'readiness';
      await waitForServer({ origin, transport, server, signal: requestSignal });
    } else transport = createCandidateFetch(origin);
    stage = 'checks';
    docs = createDocsCheck(requestSignal);
    const report = await runCheck({ http: createHttp({ origin, adminOrigin: config.adminOrigin, token: config.token,
      readFetcher: transport, signal: requestSignal }), cleanup, signal: requestSignal, docs, fixtureId });
    console.log(JSON.stringify({ gate: 'partner-api-live', target: build ? 'compiled-release-candidate' : 'hosted-release-candidate',
      candidateIngress: build ? 'verifier-local-platform-simulation' : 'actual-hosted-ingress', docs: 'actual-docs.blast.fun',
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null, ...report }));
    if (!report.passed) process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify(startupReport(error, stage)));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await closeSafely(() => cleanup?.close());
  await closeSafely(() => docs?.close());
  await closeSafely(stopServer);
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
