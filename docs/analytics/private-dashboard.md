# Private analytics dashboard source

`apps/web/analytics/` is a separate Node 24 project. It is intentionally outside
root workspace discovery. The product app does not boot it, share its auth or
load its database configuration. Its existing Vercel deployment disablement stays
in place. This change does not choose a host, open a service, set DNS, install
production secrets or activate analytics.blast.fun.

Run commands from `apps/web/analytics/` with its own installed dependency tree:

```sh
npm ci --workspaces=false
npm run typecheck
npm test
npm run test:contract
MISSION_CONTROL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm run test:integration
npm run test:artifact
npm start
```

The integration command requires a disposable loopback PostgreSQL owned by the
task. It creates and drops a separate database and two restricted logins. Never
point it at the application database or Neon. Use the workspace resource
preflights and one test worker. The root gate does not discover these commands.
The usual product migration rehearsal is still required before publication.

## Configuration

The local server reads only these runtime values:

| Value                         | Meaning                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| ANALYTICS_DASHBOARD_ORIGIN    | Exact HTTPS origin, without credentials, path, query or fragment                    |
| ANALYTICS_SESSION_KEY         | Canonical base64url encoding of a random 32-byte AES key                            |
| ANALYTICS_API_URL             | Exact HTTPS origin of the private aggregate API                                     |
| ANALYTICS_API_TOKEN           | 32–4096 non-whitespace characters, retained on the server                           |
| ANALYTICS_ACCESS_DATABASE_URL | Direct warehouse login granted only blast_analytics_access; remote TLS verify-full  |
| PORT                          | Decimal local port, default 8080                                                    |
| NODE_ENV                      | Explicit development permits HTTP loopback origins and binds the server to loopback |

Configuration and operational errors use fixed messages. Never log the values,
access codes, hashes or cookies. Neither database availability nor API availability
is needed by public `GET /live`; it certifies process liveness only.

Access codes come from the existing operator-only warehouse mint function. They
contain 256 random bits and expire after one database hour. The dashboard hashes
the submitted code once and calls the existing atomic redemption function. Its
login role has no table, mint or aggregate-read rights. The encrypted session
stores only the hash subject, expires absolutely after four hours, and binds its
AES-GCM associated data to the origin. HTTPS cookies use the \_\_Host- prefix,
Secure, HttpOnly and SameSite=Strict. Signing out clears the browser cookie.

## Prepared standalone artifact

`npm run prepare` copies the one authored strict Zod4 contract from
`apps/workers/src/modules/analytics/contract.ts` unchanged into gitignored
`generated/aggregate-contract.ts`. Only the HTTP envelope lives in dashboard
source. A new source import beyond Zod stops preparation for review. The schema
is never a public asset. Runtime modules import only their local generated copy.
The contract test byte-compares the authored and generated modules, then uses the
actual current API handler over loopback HTTP.

Preparation also copies the canonical Blast UI tokens and shared control,
PageHeader, EmptyState and Skeleton CSS unchanged. Native static markup is the
narrow standalone presentation adapter: it preserves the primitives' classes,
attributes, sizes, focus, states and semantics without loading Next, React,
product auth or product pools. The native select and modal keep browser keyboard
and focus behavior. Modern Web Guidance: `forms`, `dialog`.
The chart uses the same pinned TradingView Lightweight Charts library as the
product; its bundled module is served locally with the library attribution.
The three self-hosted fonts and their licenses live in the dashboard asset tree.

`npm run test:artifact` copies only this project, prepared inputs and its own
dependencies to a scratch directory outside the checkout. There it verifies the
input hashes and starts the server with dummy loopback addresses. No workspace
source paths, external API or database are available. Private HTML still passes
through the authenticated handler; no static hosting directory is certified.

## Data meaning and bounds

The API schema accepts v2 aggregate responses only, with exact string money,
checkpoints and counts. Account telemetry remains null and the UI states that it
is not collected. Active wallets are onchain addresses, not accounts or people.
Coverage starts at a configured checkpoint, never at the start of chain history.
Transactions include only selected launch, presale and trade facts. Registered
pool turnover counts each swap hop once. Unpriced receipts remain visible and
priced USD never claims complete coverage when receipts lack prices. Quote atoms
are distinct by asset and cannot be summed across assets. UTC buckets and the
exclusive window end remain visible.

The server admits at most 32 active requests, two active login requests and 30
login attempts per minute per process. Login streams have a 1024-byte limit and a
one-second deadline. Only exact paths, methods, origin and host are accepted.
The access pool has one connection and bounded connect/query/statement/lock waits.
The upstream reader shares one in-flight read, rejects redirects, streams at most
1,000,000 bytes, and bounds fetch plus body to three seconds. Valid data is cached
for 60 seconds. Cached freshness is recomputed from the source and generated
timestamps. Delivery failure can retain a last good delivery for less than one
day, always explicitly stale and degraded. HTML and JSON use no-store and noindex.

The browser retains exact strings/BigInt for displays and copies. Chart values
are normalized bounded approximate coordinates; their axis does not pretend to
be exact USD. The exact daily table uses the same receipt rows. Dates are checked
before conversion to Number/Date. Dates outside the chart range retain an exact
millisecond fallback in the table and coverage text.

This source port supplies the dashboard part of #399 and integration work for
#398. It closes neither release issue. Provider inventory, warehouse/API hosting,
actual role/TLS setup, operator secrets, DNS and production lag/latency acceptance
remain separate work. Account telemetry #400 requires its own identity/privacy
review and authorized collection source.
