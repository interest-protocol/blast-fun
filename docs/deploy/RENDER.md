# Hosting the Blast backend

The [Render blueprint](../../render.yaml) defines the API, hints, worker
and scheduled job processes. The API and hints processes share the backend
image. The API uses its default command. Hints runs `bun run src/hints-main.ts`
and serves browser event streams. See the [backend settings](../../apps/backend-api/.env.example)
and [worker guide](workers.md) for their inputs.

## Choose a local workflow explicitly

Next.js loads the web environment from `apps/web`. Use the
[local setup](../../README.md#start-locally) and disposable PostgreSQL and Valkey
for verification. Match the indexer and sponsor to the selected deployment
identity. Keep credentials in the server environment and public build-time
configuration under `NEXT_PUBLIC_*`. Restart after changing server settings and
rebuild after changing public build-time settings.

## Shared read cache and partner quotas

Configure `BLAST_CACHE_REDIS_URL`, `BLAST_QUOTA_REDIS_URL` and a stable
`BLAST_REDIS_NAMESPACE`. The shared read cache can evict data. Quota storage
requires persistence and no eviction. Use TLS and restrict network access.
See the [partner storage contract](../security/partner-read-api.md#redis-storage-and-public-caching)
for outage and counter semantics.

## Standalone backend services

Set `BLAST_BACKEND_API_ORIGIN` and `BLAST_BACKEND_GATEWAY_SECRET` on the web
server for API traffic. Set `BLAST_BACKEND_HINTS_ORIGIN` and
`BLAST_BACKEND_HINTS_GATEWAY_SECRET` for streams. Match the quota namespace
between the frontend and API. Replicas sharing the same recognition database
also need the same capacity fingerprint and recognition-store configuration.

Render's 300-second shutdown allowance requires
`BLAST_BACKEND_MAX_PRIVATE_WORK_MS=280000` for a 290-second application drain.
Workers finish their current pass after SIGTERM. Verify the host's shutdown
and ingress behavior before relying on those limits. See the
[backend limits and verification](../../apps/backend-api/README.md#resource-and-deployment-limits).

## Read-only verification

Check liveness, readiness and an ordinary authenticated read separately.
A healthy process may still be unable to serve product requests. Check
the serving revision, deployment identity and data freshness. Verify
the streaming and worker entry points with their own probes.
