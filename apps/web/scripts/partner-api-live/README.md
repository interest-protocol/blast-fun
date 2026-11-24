# Partner API release check

Vercel's mandatory web build runs `test:partner-live`, compiles Next, then runs
`check:partner-live -- --built`. Keep all three steps enabled. The live check
issues and revokes UUID-scoped release fixtures, runs primary-database cleanup,
and exercises the actual reference and playground at `https://docs.blast.fun`.
Run it only with authorization for that registry and fixture cleanup.

Generic feature previews (deployment target `preview`)
are always UI-only (#490). They skip the live check, log
`{"skipped":"ui_only_feature_preview"}` instead of a pass, and publish. Every
pushed branch builds there with its own build scripts and `next.config.ts`, so a
preview build can read anything in its environment. A feature preview build
given `PRESALE_ADMIN_TOKEN` or `CRON_SECRET` (generic or branch-scoped) fails
with `preview_operator_credential` rather than run with it. That guard only
catches misconfiguration (branch code can delete it); the control is keeping
these values, and production or develop values of `DATABASE_URL`,
`BLAST_BACKEND_GATEWAY_SECRET` and `BLAST_GATE_SECRET`, out of every Preview
scope, with Vercel Git Fork Protection on. Point previews at a preview-only
backend, database and gateway secret. The custom develop environment and
production always run the full check, so a missing token still fails those
builds. To check a preview, run `check:partner-live -- --origin <preview URL>`
from a trusted operator context, never from a Git-triggered build.

The split architecture has two distinct targets:

- Candidate reads go through the compiled Next frontend (or the approved hosted
  origin passed with `--origin`). Public reads still use the real backend relay.
- Operator requests go directly to `BLAST_BACKEND_API_ORIGIN` at
  `/api/admin/partner-keys`, with the backend's real `PRESALE_ADMIN_TOKEN`.
  The frontend has no operator alias. No random preview token can replace this
  independent backend credential.

Before any fixture cleanup or issuance, the gate performs a bounded read-only
operator GET against that backend route and requires its authenticated
`partners`/`keys` response. Refusal, redirect, invalid response, unavailability
or cancellation stops the gate without cleanup writes. Once admission succeeds,
the existing lifecycle retains independent cleanup after failures. Operator
tokens must survive HTTP header handling exactly; trailing spaces/tabs are
rejected rather than trimmed.

For `--built`, the runner binds its Next child to an ephemeral `127.0.0.1` port.
Only that child runs with the verifier's explicit Vercel platform context. The
shared readiness/read transport asserts a fixed client address only for reads
on that exact origin, rejects redirects, and refuses operator paths. It never
asserts platform identity to a remote origin or sends the operator bearer on
reads. Product ingress policy is unchanged. The JSON report labels this as
`verifier-local-platform-simulation`; it does **not** prove actual hosted
platform ingress. `--origin` exercises real hosted ingress without an asserted
platform header. Both modes retain actual docs success and immediate revocation
checks. A compiled pass therefore still needs separate hosted verification.

## Required configuration

Set these in the authorized gate environment before running it. Their presence
alone cannot establish that the frontend, backend, cleanup database and docs
registry match.

| Configuration | Required relationship |
| --- | --- |
| `DATABASE_URL` | Primary PostgreSQL target for the same partner registry the backend uses, with permission for `public.partner_cleanup_release_fixture(text)`. Preserve the repository's connection/TLS rules. |
| `PRESALE_ADMIN_TOKEN` | Existing backend operator bearer, at least 32 characters. Required for develop, production and a trusted `--origin` run; a generic feature preview build given it fails. Never synthesize a replacement. The runner removes it from the compiled Next child environment. |
| `BLAST_BACKEND_API_ORIGIN` | Backend's HTTPS origin (HTTP loopback only for local fixtures), with no userinfo, path, query or fragment. |
| `BLAST_PARTNER_RELEASE_FIXTURE_UUID` | Canonical lowercase UUID reserved for this gate. The backend's reviewed capacity must contain the exact tenant `ci-partner-read-api-<UUID>`; the matching cleanup label is `release-gate:<UUID>`. No random tenant or wildcard reservation substitutes for it. |
| `BLAST_BACKEND_GATEWAY_SECRET` | Same existing gateway secret as the backend, at least 32 characters. |
| `BLAST_REDIS_NAMESPACE` | Existing valid network/deployment identity for this candidate. Never point previews at production quota counters merely to pass the check. |
| `BLAST_DEPLOYMENT_TARGET`, `BLAST_DEPLOYMENT_BRANCH` | Set by hand for `--origin` runs; a Vercel build reads its own platform variables, and `--built` runs only on Vercel because its server starts with `VERCEL=1`. Preserve candidate identity. Previews require an explicit branch. Backend `BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE` must equal the existing `quotaNamespace` derived from those exact values and `BLAST_REDIS_NAMESPACE`. |

For an explicitly authorized, reviewed PR, run the check with `--origin` from a
trusted operator context holding the required credentials; never scope them to
the preview branch, where later unreviewed pushes would build with them. Use a
dedicated backend with that branch's expected quota namespace and site origin. When it shares the existing registry database, its
`BLAST_PARTNER_RECOGNITION_NAMESPACE`, quota Redis, pepper and exact capacity
document must match the existing coordinator; count it within `maxReplicas`.
See the backend configuration guide. Do not add privileged credentials to generic
previews, change the candidate identity, or start an incompatible coordinator.
Remove the dedicated backend after the PR closes.

After operator admission, the gate takes a PostgreSQL session advisory try-lock
for that UUID before any fixture mutation and holds it through cleanup. An
overlapping run using the same fixture is refused before mutation. For Neon,
the cleanup connection uses the same endpoint, database and runtime login with
the direct hostname; a transaction pooler cannot retain this session lock. The
gate clears only its locked fixture, creates it freshly through the backend,
then proves its presence in the cleanup database before issuing a key. A target
mismatch prevents issuance and cannot claim confirmed cleanup. Lock loss aborts
ordinary HTTP/docs work; a known issued key still receives an independent,
authenticated backend revoke attempt before database cleanup.

The actual docs controls call `https://www.blast.fun/api/v1/market/status`.
The reserved key must be recognized by that real API registry, and its first
post-revocation request must refuse it. An isolated backend/database that cannot
establish this relationship is an unsupported verification setup. Do not
retarget docs to a local substitute, change registry/quota identity, or suppress
these assertions. Establish an authorized compatible backend/registry setup
before executing a live fixture run; the check fails closed if real recognition
or revocation does not work.

## Fresh presale bootstrap

For an authorized fresh-lineage candidate in `BLAST_PRESALE_ENABLED=team`
mode, set `BLAST_PARTNER_EMPTY_PRESALE_BOOTSTRAP=true` on that candidate only. With three
successful, complete empty status lists, the gate checks the featured list is
empty and uses the issued partner key to request a randomly chosen missing
presale. It requires the v1 JSON `404 not_found` response with `no-store`, then
checks that revocation immediately blocks the same detail route. The price check
uses SUI without presale context. An empty discovery list skips the curve pool
and candle reads under the same flag (`poolDetail: empty-bootstrap`), but a
random pool and its candles are still checked as refused after revocation. The
docs, admission, HEAD, audit and cleanup checks still run.

An `empty-bootstrap` report authorizes the private bootstrap stage only. After
the first separately authorized real sale is indexed, remove the flag and rerun
the full gate against the same canonical lineage. Require `presaleDetail` and
`poolDetail` both `populated`, with a matching authenticated detail and
presale-scoped prices, before public promotion. `candles: empty` means the
newest launch has no trades yet; the pool and its candles still validated. No sale creation or chain transaction is part of this gate.

## Safe failure diagnostics

Startup failures are nonzero structured JSON with a fixed phase/category and
last readiness HTTP status. They contain no raw URL, exception, response body or
credential. Fix the named boundary and rerun against the exact commit:

| Category/status | Next check |
| --- | --- |
| `database_configuration` | Supply the authorized primary URL in the required format; verify cleanup grants separately. |
| `operator_credential` | Configure the existing real backend operator token for this gate environment. |
| `operator-preflight`, `operator_admission_refused` | Verify the configured backend route recognizes the exact operator bearer and returns the expected authenticated registry response. No cleanup or issuance has run. |
| `backend_origin` / `backend_gateway_configuration` | Configure the backend origin and matching existing gateway secret. |
| `quota_namespace_configuration` / `unsupported_topology` | Reconcile the candidate branch/environment and backend's expected derived namespace, preserving preview isolation and real docs registry recognition. |
| `readiness`, HTTP 503 | Check frontend relay configuration and backend availability. The gate never treats 503 as readiness. |
| `readiness`, HTTP 403 | Check the existing gateway secret, derived namespace and backend ingress policy. |
| `readiness`, HTTP 404/200 | Check candidate route and admission wiring; only the intended missing-key 401 establishes readiness. |
| `candidate_stopped` / `interrupted` | Check compiled child startup/resources or the explicit cancellation, then retry within the resource budget. |
| `search`, HTTP 503 (`indexer-lag`) | Check the backend's `read.degraded` metric for `search` and the committed checkpoint age on the configured primary and replica. If replay is catching up, wait for a fresh replica and rerun the full gate. |

For failed reads, use the reported request ID to find the backend or relay's
`http.error` metric. For search, compare nearby `read.degraded` entries and the
replica watermark. Search stops serving data after two minutes of checkpoint
lag. The live gate requires a fresh result, either `available` or `empty`,
before it can pass.

## Pinned contract

`contract.json` holds each checked operation's documented 200 schema, taken
from the published docs spec. Besides the presale, price, search and status
reads, the gate reads discovery (`view=new`), then that newest launch's
bonding-curve pool and its one-minute candles (a curve's pool ID is its launch
ID), and checks revocation on all of them. Never edit the contract by hand.
After the docs site publishes a contract change, re-pin it with the docs commit
it was built from and review the diff:

```sh
node scripts/partner-api-live/pin-contract.mjs <docs commit>
```

Focused local regressions run with `npm run test:partner-live`. Their ephemeral
HTTP and synthetic credential fixtures prove transport/error contracts, not
live configuration, data freshness, real docs, or hosted ingress.
