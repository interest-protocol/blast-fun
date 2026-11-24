# Social package placement

Issues #798 and #777 use consumer ownership. The browser's wire contracts and
code used by more than one runtime stay in `@blast/core`. HTTP routes, their
SQL stores, and server-only reads belong to `@blast/server`. Social worker
steps and their private helpers belong to `apps/workers` beside their tests.
Do not make server or core depend on workers.

The seven worker entry points are milestone generation, notification generation,
referral collection, wallet registration, portfolio snapshots, intent resolution,
and claim settlement. Shared claim event decoding, transaction logging,
portfolio reads, presale visibility SQL, and naming/entry projections remain in
core because both workers and server use them. Browser contract exports also
remain in core, including exports reached through `@blast/core/web/contracts/*`.

The social operator CLI and its SQL live in the server package. Run it from the
repository root with `npm run social:operator -- <arguments>`, or from the server
package with `npm run social:operator -- <arguments>`. The same authentication,
audit, and transaction rules apply.

Tests follow the behavior they exercise. Worker completion scenarios that also
read server results live in `apps/workers/test/social`. The workers' server
dependency is a development dependency for those scenarios; worker production
entry points only import core and their declared runtime dependencies. The
wallet-registration test and worker query-plan assertions were separated from
web portfolio and server schema suites so those packages do not import workers.
Core retains its pure portfolio valuation tests; fullnode balance tests follow
the worker-owned balance reader.

Cross-runtime scale harnesses live in `scripts/loadtest`. Run them from the
repository root with Node's runtime hook, for example:

```sh
node --no-warnings --import ./scripts/register-runtime-types.mjs --experimental-strip-types scripts/loadtest/social-intents-scale.ts bench
```

The milestone harness, which exercises only worker steps, lives in
`apps/workers/loadtest/social-milestones-scale.ts` and runs with the same root
command pattern. Harnesses require an explicit disposable loopback PostgreSQL
URL in `SOCIAL_SCALE_DATABASE_URL`; `seed` resets that database. Output remains
under the working directory's `loadtest/results`.

This move changes imports and ownership only. The verification compares every
moved production file with its previous contents after normalizing module
specifiers. Source-text privacy checks are covered by closed response-schema
validation and the route/worker integration tests that inspect actual log lines.
