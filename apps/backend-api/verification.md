# Bun/Elysia consolidation verification — 2026-10-24

The local implementation now uses Bun 1.4.2 and Elysia 1.4.30. Canonical
public-read/admission/operator modules live in `@blast/server`; private account
and session routes stay in Next.js. The separate admin repository uses Eden
1.4.10 with types inferred from its actual authenticated Elysia proxy app.
Nothing in this stage was deployed, published or tested against Render, hosted
Neon/Vercel, or a chain RPC.

Source-bound evidence lives in workspace
`outputs/verification/2026-10-24-bun-admin-consolidation/`, beginning at
`README.md`. Both checkouts contain local uncommitted changes. Baselines are web
`242cd2c9af9ca60c307dd61180603e8afccaa369` and admin
`16f4cb9200c05f0f2d0c24523e29c695e3fa0270`.

## Checks

- Complete shared-server and web strict typechecks passed; 25 shared Node tests,
  the same 25 under Bun, and 370 affected web tests passed. Backend typecheck,
  all 28 default backend tests and scoped lint passed. Checks remain enforced.
- The complete cold Next.js 16.4.1 production build passed with typechecking
  enabled: Turbopack compiled in 4.3 minutes, TypeScript took 35.3 seconds and
  all 34 static pages were generated before final optimization completed. The
  Next command took 5:00.96; peak summed process-tree RSS was 6,048,428,032 bytes
  (5.63 GiB), during compilation/typechecking overlap. Summed RSS can count shared
  pages more than once and is not a container peak. This was a cold `.next`
  cache, not a fresh dependency install. A private read-only dependency view
  exposed the existing shared dependencies inside Turbopack's root; exact
  downloaded font bytes were served only on isolated loopback. No external
  network route, real environment file or hosted product was available. Earlier
  dependency/font-fixture setup failures are retained separately. Application
  source stayed unchanged and all owned processes exited. Evidence:
  `extraction/checks/web-cold-build/README.md`. Future runs should budget at
  least 6 GiB expected peak plus the required 4 GiB host reserve.
- All five extracted PostgreSQL integration files were exercised. Two moved
  migration-test directory URLs required a trailing slash; their rollback/reapply
  checks passed after correction. The usage suite now automatically provisions
  disposable Valkey and passed without skipping its quota-telemetry assertions.
- Real Bun processes, local PostgreSQL and Valkey verified admin issuance,
  labels, policy changes and immediate revocation on another instance; policy
  changes preserved key hashes and consumed quotas. Genuine synthetic Privy and
  wallet sessions still worked. A pre-existing non-null account and wallet
  session were unchanged by admin operations. Signed read proofs and partner
  keys could not authorize admin commands. No account was recreated.
- All 586 preservation-baseline files matched, including core account/session/
  quota implementation and the admin password middleware. Extracted business
  logic retained its semantics; static import resolution found no web, Next,
  React or signer dependency in the shared runtime closure.
- Admin: 55 tests, complete typecheck, static production build and built-JS
  isolation checks passed. Eden uses same-origin cookies and no browser bearer;
  its type-only app import does not include the server session/proxy code in the
  built JS. The existing 954 kB main chunk warning remains; there is no measured
  pre-Eden size baseline and no browser/hosted claim.
- The actual production image built with pinned Node/npm dependency stage and
  pinned Bun runtime, retaining npm lock authority. Image size: 107,551,733 bytes.
  All 593 runtime source files matched. No frontend source or Next package was
  present. Network-disabled, read-only, non-root startup under 512 MiB reached
  exactly the expected missing-configuration refusal after resolving imports.
- Astra independently approved the local stage after identifying and verifying
  a shutdown correction: drain now waits for admitted operations even when their
  HTTP response has already timed out. The failing regression was retained, then
  passed. The outer ten-second shutdown deadline remains.

## Mixed load on frozen production source

The final run seeded 10,005 keys, used eight concurrent callers and real 512 MiB
cgroups per Bun backend, and ran each profile for 30 seconds. It covered warm and
cold partner reads, the frontend relay, Privy users, wallet sessions and anonymous
reads. Both profiles passed with 23,560 measured requests in total. Mid-run
checks covered policy/revocation freshness, Redis disconnect/fail-closed recovery,
backend restart and survival of shared daily counters without duplicate charges.

| Synthetic store RTT | Requests | Aggregate requests/s | Warm partner p95 | Cold partner p95 | Privy user p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local | 18,602 | 619.92 | 14.33 ms | 15.14 ms | 16.21 ms |
| 12 ms | 4,958 | 165.16 | 48.72 ms | 49.93 ms | 36.18 ms |

Largest sampled backend peak RSS was 138,840 KiB (about 136 MiB), within the
512 MiB ceiling. The driver/runner measurement is separate from database and
container memory. These are synthetic local measurements with loopback Rust/
gas-pool HTTP fixtures and capacity-specific quotas, not proof of faster framework
performance or hosted capacity. Production default quotas were tested separately.
The private `/api/social/me` account-loading route was not a load-test target.

The final physical/load command used unchanged production source. During that
command, only two test asset URLs, integration-runner setup and CI wiring changed
after its broad source snapshot; `final-source-after-checks.json` records those differences explicitly.
Failed exploratory logs remain retained and are not represented as passing runs.

## Remaining limits

Bun's missing documented absolute pre-header deadline/socket cap requires
verified ingress protection before rollout. Shared admin password access, absent
MFA and non-individual audit attribution remain accepted open security gaps.
Dedicated database role grants, replica ceilings and Render proxy behavior still
need hosted acceptance. The reward discovery route correctly returned 503 in the
physical fixture without a validated deployment manifest; its independent SQL
suite passed with an explicit fixture scope. No real deployment identity was
changed to bypass that gate.

Fable's prior attempt was blocked by usage before inference; this stage has no
Fable score. Existing Rust engine repair and its outstanding full-release evidence
remain a separate paused task. The Node results below describe the earlier
runtime and must not be presented as Bun measurements.

---

# Local admission verification — 2026-10-24

This report covers the standalone admission process, shared frontend relay and
opt-in committed-reader routing. It does not establish hosted production readiness
or the Rust committed reader's correctness. No hosted backend, database or frontend
was called, and no transaction was submitted.

## Immutable sustained baseline and final source

The checkout is `codex/partner-architecture-audit`, based on
`385aa5a41c072ee53fa7533c9c91e155914bb2c9`. Raw logs and manifests are retained
under workspace `outputs/verification/2026-10-24-backend-admission/`.

`sustained-final-02/` contains a completed immutable run: all 4,573 nonignored
checkout files matched before and after the complete command, digest
`6db60315d9fd87c1febd4b72ee44ff9fc16dc705be315f26ce9f29649f605f55`.
The owned 51-file source candidate had digest
`6a410d9fb5abbafac1f5df93d473d1fd8af4ab0b74c27a4e051483c60386f3c3`.
Both five-minute profiles and the following physical contract suite passed.
Earlier logs remain separate and are superseded by this immutable baseline.

After this run, Fable's review led to focused corrections: decoded-body response
headers, a backend deadline below the relay deadline with route-family error
codes, refusal of ambiguous client identity, shared cache protection while
clearing expired cookies, and Docker context safeguards. Exact bucket parity
and transport/build regressions were added. That 56-file runtime/build candidate's digest is
`57b8c55bcc3d6fe06fbbbc9e8b48d8af3a3da4894edd42118dabd70c604e5ac9`; `post-fable-transport-05/source-manifest.json`
records the 12 changed files relative to the immutable baseline. Final focused
checks and a short physical rerun cover these corrections. The final candidate
has not completed another full five-minute capacity run; sustained measurements
below belong to the immutable baseline, not the later transport/build changes.

A subsequent CI-only change adds `.github/workflows/backend-architecture.yml`
and the fail-closed `scripts/backend-image-contract.mjs` verifier with its focused
test. It does not change the runtime or sustained workload. The workflow will
build the actual production image with BuildKit on GitHub and verify native
static imports in a network-disabled, unconfigured container. Its installation,
type/unit/context/physical checks and image build must all pass; no hosted product
call or deployment is included. That GitHub execution and requiring its status in
branch protection remain pending; an unrun workflow does not close the image gate.

## Contract and session checks

Physical processes use real disposable PostgreSQL and Valkey, two backend
replicas, and the actual frontend relay function. The upstream Rust HTTP protocol
is represented by a loopback fixture returning tiny JSON. Checks cover:

- All 18 route bindings and their exact pre-admitted endpoint buckets;
  HEAD/OPTIONS, canonical paths and origin policy. Private account/mutation
  routes stay outside the relay.
- Fresh primary key policy/revocation, original hashes and counter IDs, atomic
  key/global/endpoint admission, and exactly one direct/relay charge.
- Signatures binding credentials, method/path, client IP and quota namespace;
  cross-replica nonce rejection and spoofed forwarding/context rejection.
- Genuine synthetic Privy JWTs and live wallet sessions without account creation
  or identity changes. Expired sessions clear both cookies over direct internal
  transport and frontend relay, with private/no-store at browser and CDN layers.
- The unchanged real 600/min global partner budget refuses excess partner reads
  while first-party session reads remain available.
- Original social, market and discovery refusal codes and Retry-After values
  (only 429 and 5xx carry Retry-After; 4xx refusals never do);
  real four-second backend deadlines precede the relay's five-second deadline.
- Real gzip responses pass through relay/native HTTP without stale encoding or
  length headers; both cookies and normal cache policy survive.
- All 28 canonical committed-reader HTTP paths and WebSocket routing; reader
  failure never retries against the writer. Raw activity routing remains a
  separate default-off opt-in.

The public presale detail/list/featured handlers never read viewer identity.
Only the separate private viewer POST uses the wallet resolver; it remains on the
frontend. The shared route kit returns inner responses without replacing their
cache policy, except that adding expired-session cookies now explicitly prevents
shared caching. Primary key grants are schema-parsed before policy-cache keys are
built, so database JSON property order does not change cache identity.

## Final package checks

The final runtime passed backend and full web typechecks, scoped ESLint, 12 native
backend tests, 30 shared route-kit/header-session/me-runtime boundary tests, and
both short constrained physical profiles plus the full physical contract suite.
Full web typechecking peaked at 2,159,332 KiB RSS. The final backend typecheck,
including the Docker context test, peaked at 637,400 KiB RSS. React Doctor
scored 100/100 on the final frontend source (492,532 KiB peak RSS, 10 seconds);
its final log is retained beside the other checks. `git diff --check` passed.

The Docker CLI context test verified 1,106 required COPY files and exclusion of
22 synthetic private paths, including environment backups, Git, dependencies and
artifacts. It tested both the root fallback and strict backend patterns against
a loopback fake daemon; no image was built or pulled. For strict patterns, the
fixture mirrors the Dockerfile-specific patterns into its root ignore file to
exercise Docker's actual matcher through the legacy archive transport. This is
not a verification of BuildKit filename selection or dependency installation.

A keep-alive regression sends 1,101 reads over one socket. The server retains
connection, idle, header-size, in-flight-work and request-duration bounds without
closing healthy busy sockets at an arbitrary request count.

## Sustained results — immutable baseline

Each profile used 10,005 registered keys, eight concurrent requests, cold/warm
partner reads, relay reads, genuine Privy/wallet sessions and anonymous reads.
The load issued 157,939 requests in total, with no unexpected authentication,
transport or storage failures outside the explicit fault assertions. Each
profile paused at its midpoint to change/revoke key policies across replicas,
disconnect/reconnect Redis and restart a backend, proving daily counters survived
without duplicate relay charging.

| PG/Redis RTT | Requests | Requests/s | Warm p95 ms | Cold p95 ms | Relay p95 ms | Privy p95 ms | Wallet p95 ms | Peak backend RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 111,730 | 372.42 | 25.13 | 30.54 | 43.04 | 38.99 | 42.89 | 161.2 |
| 12 ms | 46,209 | 154.01 | 58.00 | 63.24 | 81.75 | 51.49 | 68.37 | 167.9 |

Each backend had a 256 MiB V8 old-space ceiling inside an actual 512 MiB
memory/swap cgroup. PostgreSQL/Valkey were separate disposable containers. The
harness mounted existing Node/sources into a Debian container filesystem; it did
not build the production image. The relay was the actual shared function in a
small process rather than a full Next deployment. Synthetic capacity policies
remain separate from the unchanged 600/min production partner budget.

These shared-host, tiny-upstream measurements are comparative fixture results,
not production latency promises or worst-case payload memory bounds.

## Remaining deployment gates

Build/verify the actual production image and dependency closure with BuildKit;
host disk space was insufficient here. Verify proxy socket identities and exact
forwarding-header overwrite behavior before trusting a deployed proxy. Missing
or ambiguous client identity now fails before admission rather than sharing an
unavailable-identity quota bucket. Provision service-specific database privileges
and choose aggregate connection/replica ceilings. Integrate the actual Rust
reader and repeat representative maximum-payload memory/capacity checks. Leave
opt-ins disabled until release gates pass. Existing accounts, sessions, key IDs
and quota identities are preserved; no migration or credential rotation occurred.
