# Web build memory

The web production build keeps the Next.js TypeScript check, React Compiler,
partner tests and compiled-candidate partner release gate enabled. Its tsconfig
still includes application code, scripts, tests and generated Next route types.

## Bound the two independent pools

`apps/web/package.json` defaults `TURBO_TASKS_AVAILABLE_PARALLELISM` to `2` only for
`next build`. Turbopack in Next.js 16.4.6 uses this value for
its Node evaluation pool, including Babel/React Compiler and PostCSS loaders.
`experimental.cpus: 1` controls other Next workers and does not bound this pool.
The inherited environment may override it; use `TURBO_TASKS_AVAILABLE_PARALLELISM=1`
on the shared VPS to preserve its single-worker budget. The two-worker Elastic
comparison is recorded separately from the conservative one-worker measurements
below. Keep the safe child-process strategy; Node 24's worker-thread teardown protection
must not be bypassed to save memory.

`apps/web/tsconfig.json` sets `compilerOptions.checkers: 1`. The app uses the
native TypeScript 7.0.2 compiler. Its default is four checker instances, with
separate type/instantiation caches, even with `GOMAXPROCS=1`. One checker still
checks the complete project and reports errors. This native option is not
supported by the root TypeScript 6 API package, which exists for tooling; run
the app's own typecheck command. Next's CLI checker resolves the app-local TS7.

These settings reduce overlapping build processes and duplicate checker state.
They do not change application authentication, runtime concurrency, validation,
tsconfig file scope, or the existing strict compiler flags.
The tradeoff is reduced build parallelism. Recheck both controls and measure a
cold build when upgrading Next or TypeScript: the Turbopack environment control
is supported by this pinned release's source rather than a stable Next config API.

The original dependency update from Next.js 16.4.0 to 16.4.1 was a separate security
patch, with the matching ESLint config and SWC packages pinned in the lockfile.
The first optimized 16.4.0 build completed every compilation/checking phase but
exited on the framework security advisory; no security check was suppressed.

## Verification

From the repository root (shared VPS commands keep one loader worker):

```sh
npm run typecheck -w @blast/web
TURBO_TASKS_AVAILABLE_PARALLELISM=1 npm run build -w @blast/web
```

Vercel retains the existing full release command from `apps/web/vercel.json`:

```sh
npm run test:partner-live && npm run build && npm run check:partner-live -- --built
```

For a cold-cache measurement, use an owned checkout and remove only its `.next`
directory before building. Sample the complete descendant process tree through
compilation, typechecking and page generation; measuring only the parent process
misses loader and native TypeScript memory. Sum-of-process RSS counts shared
pages more than once and must not be described as exact container memory. Use
container/cgroup accounting when available.

The develop `a2b3f1e` baseline compiled successfully but exceeded Vercel's 8-GB
container during the transition to typechecking. Local sampling reproduced
the overlap: eight loader children remained alive while Turbopack persisted its
cache and the native compiler started. The baseline reached 9,166,964 KiB of
combined sampled RSS; the native TypeScript process peaked at 2,736,840 KiB in that full build. These local
measurements used one Go runtime worker and a nonbinding 6-GiB Go soft limit,
so they are not an exact recreation of the hosted container's parallelism.

The patched cold build passed with a sampled combined peak of **6,364,272 KiB**
(**6.07 GiB**), versus **9,166,964 KiB** (**8.74 GiB**) in the baseline, a
**30.6% reduction**. Its full app build took **302.9 seconds**, versus **137.6
seconds** in the baseline. The extra time is an explicit cost of serial loader
work. Both used the same host controls; the original baseline used Next 16.4.0
and the final result includes the required 16.4.1 security patch. Sum-of-RSS is
not a guarantee of fitting a particular container. Vercel's owner-selected
Elastic build machine remains enabled; no build-resource setting is overridden
by this change.

The passing build resolved **9,500 files**. Four generated Next type files total
about **135 KiB**; generated route types are not the dominant source of bloat.
Large declaration graphs include viem, Base UI, ox, Sui, React Aria and Solana.
Their resolved-file counts do not establish memory cost, and active wallet/SDK
features must not be removed just to shrink those counts. Scripts and tests
remain included. A separate earlier standalone baseline resolved 9,999 files
through a different local dependency layout; do not compare that file count as
if scope had been reduced by this patch.

The local measurements above cover `npm run build`. The complete hosted release
command and existing signed-in account were verified separately below.

The optimized standalone full-scope check also passed, resolving 9,500 files
with 586,580 types and 1,184,638 instantiations. It took 44.7 seconds wall time
with a maximum RSS of 2,160,320 KiB. Its Go CPU/heap profiles attribute retained
memory to parsed AST storage, symbols, and instantiated types; they do not
attribute heap allocations to individual imported npm packages. Avoid claiming
that a large declaration-file count proves one dependency caused the OOM.

Validation also includes all 24 partner live-gate unit tests, three partner-v1
checks in the build, a deliberate type error rejected through Next's actual
checker wrapper, and React Doctor's config-only changed-file check (100/100,
zero JS/TS source files changed).

## Elastic build choice

Keep the owner-selected Elastic machine, two Turbopack loader workers and one
TypeScript checker. Two forced cold-cache deployments both started on four
vCPUs with 8 GB memory and passed the full hosted release command, including
compiled-candidate partner reads, documentation authentication/revocation and
temporary-key cleanup:

| Loader workers | Commit | Builder start to Build Completed | Release command |
| --- | --- | --- | --- |
| 1 | `f81c6771` | 313.4 seconds | 246.4 seconds |
| 2 | `136a0493` | 201.1 seconds | 145.0 seconds |

The two-worker trial reduced total build time by **35.8%** on the same allocation.
At the published Elastic price of **$0.0035 per allocated CPU-minute**, those
observed build windows estimate **$0.073 versus $0.047**. These are directional
estimates, not invoices: later cache upload, other billable overhead, credits and
taxes are outside this comparison. Elastic chooses the machine; repeat the
comparison if the allocated core count changes. One cold run per configuration
does not establish p95 build time or long-term OOM reliability.

Exact hosted peak memory was **not captured**. The tracked `vercel.json`
build command overrode a deployment-scoped profiling command, so neither GNU
time nor cgroup peak markers ran. A passing build on an 8-GB allocation proves
that trial completed; it does not quantify remaining headroom. Do not attribute
the local one-worker 6.07-GiB sampled peak to the hosted two-worker build. No
profiler, extra dependency or diagnostic runtime code was shipped.

Dev is ready on deployment `dpl_CWwXAW5KxUKCrDisox7hYHuuKi5c` (`136a0493`).
The user's local browser verified the existing signed-in session after the
Privy configuration repair: `/api/social/me` returned 200 with a non-null account,
string account ID/callsign and wallets array. The account loaded, public posts
rendered and no account-creation requests were sent. Independent bounded probes
on the final deployment returned feed 200 and invalid-token `/api/social/me` 401;
the old deployment returned 503 with `INVALID_CONFIGURATION` for that same probe.
No session reset or account replacement was needed. Production was not redeployed.

Hosted comparison references:

- [Elastic pricing](https://vercel.com/pricing)
- [Tracked build command precedence](https://vercel.com/docs/project-configuration/vercel-json#buildcommand)
- [Passing two-worker dev deployment](https://vercel.com/interest-protocol/blast-v2/CWwXAW5KxUKCrDisox7hYHuuKi5c)

Security patch references:

- [App Router Server Actions denial of service](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)
- [Image optimization security fix](https://github.com/advisories/GHSA-2464-fhr4-w9xw)
- [Typed-array cache security fix](https://github.com/advisories/GHSA-673q-mjm6-r5xr)

Exact version source references:

- [Turbopack parallelism override](https://github.com/vercel/next.js/blob/v16.4.1/turbopack/crates/turbo-tasks/src/parallel.rs)
- [Node evaluation pool](https://github.com/vercel/next.js/blob/v16.4.1/turbopack/crates/turbopack-node/src/evaluate.rs)
- [TypeScript checker pool](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/compiler/checkerpool.go)
