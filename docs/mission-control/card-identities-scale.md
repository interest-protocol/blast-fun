# Social card identity verification

The card identity endpoint serves public crew/edition metadata in batches of at
most 50 callsigns. It does not render card images. React Query coalesces mounted
avatars and keeps identities fresh for 60 seconds; successful public responses
allow CDN caching for 10 seconds with 20 seconds of stale-while-revalidate.

Published PNG previews use the browser's default HTTP cache. Unpublished artwork
uses the authenticated owner route with `private, no-store`. Both image routes
reuse the existing bounded render cache, object storage and render queue.

## Query verification

On 2026-10-09, a disposable PostgreSQL 18 database contained 10,014 accounts,
9,999 cards (the full season capacity), all 14 editions and 15 non-cardholders.
The benchmark used the real `blast_web` role and default runtime pool settings.
After three warmups, 50 varied requests per batch size produced:

| Callsigns | Planning + execution p50 | p95 | Maximum |
| --- | --- | --- | --- |
| 1 | 0.81 ms | 1.20 ms | 3.87 ms |
| 50 | 0.99 ms | 1.77 ms | 3.35 ms |

The original join could hash-join a sequential scan of all 9,999 cards for a
50-callsign batch. The lateral lookup with `LIMIT 1` keeps the lookup on the
existing unique profile/card indexes. The harness asserts that none of its
captured execution plans use a sequential scan. No schema migration is needed.

Extracting crew and edition from `card_record` still decompressed the embedded
avatar twice per card. The lookup now joins the card's immutable membership for
its crew number and uses `cardEditionForCrew`, exactly as the renderer does when
creating that card. No artwork JSON is selected. This lowered the 50-callsign
query p95 from 11.85 ms to 1.77 ms. The real runtime-role integration still
matches all 14 rendered editions and withholds unpublished card IDs.

## Origin load limit remains unverified

The production-build HTTP scenario returned correct data and cache headers for
all 6,000 requests, but **failed** its 200 requests/second and p95 < 300 ms gates:

| Scheduled rate | Completed | Actual rate | p50 | p95 | Maximum |
| --- | --- | --- | --- | --- | --- |
| 200/s | 6,000 | 40.52/s | 3,722 ms | 7,381 ms | 10,534 ms |

A subsequent run after removing the artwork JSON read completed all 6,000
correct responses at 176.39/s, with p50 888 ms and p95 1,248 ms. Lint, typecheck
and React Doctor ran concurrently on that shared host, so this run is diagnostic
and still does not satisfy the origin gate.

The original harness waited for each second's responses before scheduling the
next second. Late responses caused subsequent arrivals to bunch into catch-up
bursts. After removing that barrier, a repeat with no concurrent quality checks
completed all 6,000 correct responses in 30.03 seconds at **199.82/s**, with
**p50 33.83 ms, p95 939.15 ms and maximum 2,122.57 ms**. Throughput passes;
the p95 gate still fails on this shared host. The threshold remains 300 ms.

The requests used varied 50-callsign batches and went directly to one local
origin, without a CDN. Empty lookups also missed the latency gate: a 200-request
one-callsign probe had p95 2,572 ms, a 50-callsign empty probe had p95 3,039 ms,
and requests rejected before any card query had p95 3,731 ms. A later 50/s run
encountered a 503 with connection-pool acquisition timeouts. A direct 200-write
rate-limiter probe on the real runtime role completed in 1,068 ms. Query plans
under HTTP traffic still used indexes (50-callsign SQL p95 15.55 ms).

This establishes an origin request-path/environment limit, but does not isolate
its root cause or prove production capacity. Do not treat a clean React Doctor
score or indexed SQL as evidence that the 200/s origin gate passes. The PR stays
draft; repeat the load scenario on an isolated host with production-equivalent
compute, pool/network settings and CDN behavior before claiming launch capacity.
The local app processes and disposable database are stopped after verification.

## CDN verification requires a configured preview

The head deployment `dpl_2RQfwiLj9JDbsMArKqCVhVMBMcAQ` is READY, but its
preview environment has neither social flags nor a database URL. An authenticated
Vercel CLI request can obtain the real gate cookie from `/privacy`; the subsequent
card-identity request answers 404 with `Cache-Control: no-store`, before the
handler runs. That does not verify a public cache hit. No preview environment
variables or production flags were changed.
An authenticated Vercel request without a gate cookie answers 401
`gate_required` with `Cache-Control: no-store`.

On an isolated preview configured with a test database and public social mode,
verify consecutive identical valid reads produce a CDN HIT, different query
strings return their own identities, and missing/expired gate cookies cannot
receive a cached success. Repeat anonymous and authenticated owner-image requests
and confirm `private, no-store` and no CDN HIT. Green build checks cannot replace
these checks.

## Reproduce

From `apps/web`, set `SOCIAL_SCALE_DATABASE_URL` to a dedicated, disposable
loopback database named `blast_lt_<14-digit timestamp>`. **Seed resets that
database.** The harness rejects non-loopback or incorrectly named databases.

```sh
node --no-warnings --import ../../scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-card-identities-scale.ts seed
node --no-warnings --import ../../scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-card-identities-scale.ts bench
```

Start the production build locally with `DATABASE_URL` using a `blast_web` login
for that same database, `BLAST_SOCIAL_ENABLED=true`, and local gate/pepper secrets.
Set `CARD_IDENTITY_APP_URL` to its loopback HTTP URL, then run:

```sh
node --no-warnings --import ../../scripts/test-tsx-hooks.mjs --experimental-strip-types loadtest/social-card-identities-scale.ts http
```

The HTTP scenario defaults to 200 requests/second for 30 seconds, each with 50
varied identities. It includes unknown names, non-cardholders and unpublished
cards; checks public cache headers and absence of `Set-Cookie`; and verifies all
returned identities. Distinct local caller IPs exercise the real rate limiter
without exhausting one caller's allowance. It asserts p95 below 300 ms and at
least 95% of the scheduled arrival rate. Raw JSON results and query plans go to
the ignored `loadtest/results` directory. `SOCIAL_SCALE_RATE` can select a lower
rate from 1 to 200 for diagnosis; lowering it does not erase a failed higher-rate
run.

These measurements use one local app process and PostgreSQL on a shared machine.
They do not measure production network latency, CDN hit rates, multiple app
instances or card-image render throughput.
