# Partner read API

Partners should use the versioned `/api/v1` endpoints with `X-Blast-Partner-Key`. Use a
backend proxy where possible: browser bundles and browser requests expose the
key to visitors. A copied key can spend that partner's quota. CORS restricts
which browsers can read responses; it does not stop someone calling with a
copied key from their server.

## Public endpoints

Only GET and HEAD are authorized:

- `/api/v1/discovery` and `/api/v1/search`
- `/api/v1/market/status`
- `/api/v1/market/coins/{coinType}` and its `/holders` and `/metadata` reads
- `/api/v1/market/launches/{launchId}/activity`
- `/api/v1/market/pools/{venue}/{poolId}` and its `/candles`: Blast curve, Cetus and Bluefin
- `/api/v1/market/pools/{venue}/{poolId}/trades`: Cetus and Bluefin
- `/api/v1/market/launches/{launchId}/rewards` and `/reward-rounds`: a launch's fees in its
  curve's and its vault's ledgers, and its holder-reward rounds
- `/api/v1/market/wallets/{address}/launches`, `/launch-rewards` and
  `/launch-holder-rewards`: the launches an address created, the creator fees it can claim, and
  the holder rewards paid to it. These name the address in the path and return public chain data
  about it; they are not account reads and carry no viewer state
- `/api/v1/market/partners`, `/api/v1/market/partners/{partnerId}` and its `/launches`: the
  launchpad's partners, what each has been paid, and the launches naming it
- `/api/v1/market/launchpad/policy`: the launchpad's settings as its admin events left them
- `/api/v1/market/launchpad/daily-stats?date=YYYY-MM-DD`: completed UTC day
  counts and volume for the canonical Sui mainnet bonding curves
- `/api/v1/prices`
- `/api/v1/presales`, `/api/v1/presales/featured`, and
  `/api/v1/presales/{presaleId}`
- `/api/v1/presales/{presaleId}/proof?wallet={address}`: the wallet's allowlist leaf and Merkle
  proof, which a wallet needs to commit to an allowlisted presale. Anyone may ask for any
  wallet; the answers match the first-party route: 200 with the proof, 404 `not_eligible`
  (unlisted wallet, or a sale that is not allowlisted), 404 `allowlist_unknown`, 400
  `invalid_parameter`, and 503 `deployment_unavailable`, `deployment_mismatch` or
  `service_unavailable` with `Retry-After`. A served proof stays the same for that sale, so cache 200 answers per
  presale and wallet

Object IDs use the full lowercase `0x` + 64 hex form. Pool venues are
`blast_curve`, `cetus`, and `bluefin`. Query parameters, pagination, validation,
and response bodies are the same as the existing endpoints. Private account
reads, viewer state, admin routes, allowlist uploads and binds, transaction builders and all
writes are excluded. New read routes are excluded until explicitly reviewed.

Verified keys authorize these allowlisted reads independently of frontend launch
flags. They do not grant access to pages, private APIs or writes. Cookies and
bearer credentials are removed before forwarding a partner read. Existing first-party requests are unchanged. The presale
agent key (`X-Blast-Api-Key`) is separate and grants no partner access.

### Daily launchpad stats

Send `GET /api/v1/market/launchpad/daily-stats?date=2026-11-23` with your usual
`X-Blast-Partner-Key` header. The date covers midnight UTC through the next
midnight, exclusive. The response is one object with `date`, `launches`,
`graduations`, and `volume`.

Launches count created bonding curves. Graduations count on-chain migrations,
including curves created on an earlier date. Volume counts the quote side of
executed curve buys and sells once per trade. The result lists each quote
currency separately as `{ quote_coin_type, amount_atomic }`. Amounts are integer
strings in the quote currency's smallest unit. The scope is the canonical Sui
mainnet bonding-curve deployment. Presales, legacy curves, and trades on DEXs
after graduation are outside that scope.

A published day can return zero counts and an empty volume list. A date still
in progress or in the future returns 409 `day_not_complete`. A day with no
published stats returns 404 `daily_stats_not_published`. The hourly reporting
job normally publishes yesterday after midnight UTC. Fetch each date once
from your server and retry later if its publication is still pending.

## Admin website

Open `https://admin.blast.fun/partner-keys` with the existing admin password.
Add a partner, select it, label and issue a key, then copy the one-time secret.
If it leaks, choose **Revoke** beside its label and confirm permanent revocation.
For routine rotation, issue the replacement under the same partner before revoking
the old key. The console shows issuance and revocation audit records, never stored
secrets. Shared console actions are attributed to `operator:admin-console`, not individual
users of the shared password. The server-only `PRESALE_ADMIN_TOKEN` authenticates
its connection to `/api/admin/partner-keys`; browser sessions and same-origin
writes are checked by the console before forwarding. Existing CLI access remains
available below. Choose **Configure** beside a labelled key to select Standard, custom
minute/day limits, or explicitly acknowledged internal access. The console shows
the saved policy and its audit actor/time. Deploy the backend policy schema and
API before this console version; it rejects incomplete policy summaries. Migration `0127_partner_key_tiers`
is required for tiers; no new secret or environment variable is needed.

## Provision, rotate, revoke

Partner identities, approved origins and hashed keys live in PostgreSQL
(`partner_api_partners` and `partner_api_keys`, migration `0124_partner_api_keys`).
Each request checks the key against the **primary**, with no credential cache
and no read-replica fallback. Only the SHA-256 of the full random 256-bit key
is stored. The raw key is returned once when issued; listing never returns
secrets or hashes.

From `apps/web`, use the operator CLI. It requires the same operator credentials
as `presale:api-keys`: `MISSION_CONTROL_OPERATOR_ALLOWED_ID`,
`MISSION_CONTROL_OPERATOR_TOKEN_SHA256`, `BLAST_OPERATOR_ID`, and
`BLAST_OPERATOR_TOKEN`, plus the primary runtime `DATABASE_URL` (`blast_web`).
Keep credentials in private operator configuration; commands authenticate before
opening a database connection. Issuance and revocation record the operator ID.

```sh
# Create a partner; omit origins for backend-only access.
npm run partner:api-keys -- create-partner acme https://partner.example

# Issue a key; the JSON result contains its id and the one-time raw key.
npm run partner:api-keys -- create acme backend

# Inspect partners, origins, key IDs and revocation records, without secrets.
npm run partner:api-keys -- list

# Revoke a leaked key immediately, using the returned key UUID.
npm run partner:api-keys -- revoke <key-id>

# Replace all approved browser origins; omit origins to disable browser access.
npm run partner:api-keys -- set-origins acme https://new.partner.example
```

An authenticated operator can change policies without reissuing a key:

```sh
npm run partner:api-keys -- set-policy <key-id> standard
npm run partner:api-keys -- set-policy <key-id> custom 120 10000
npm run partner:api-keys -- set-policy <internal-key-id> internal
```

The server-only management endpoint also accepts:

```json
{"action":"set-policy","id":"<key-uuid>","policy":{"tier":"custom","requestsPerMinute":120,"requestsPerDay":10000}}
```

Use the private operator bearer (`PRESALE_ADMIN_TOKEN`), never a partner key, for
that endpoint. Payloads cannot supply the audit actor. Limits must be integers
from 1 to 2,147,483,647; the day allowance must be at least the minute allowance.
CLI limits use plain decimal digits. Changing standard-tier defaults requires
a migration to update its database defaults, existing rows and constraint alongside
the shared `PARTNER_STANDARD_LIMITS` code constant. Issuance defaults to `standard`; only authenticated
operators can promote a key. The append-only `partner_api_key_policy_events`
table records issuance and every effective policy change, with actor and time;
the runtime cannot update or delete that history. List output includes current
policy metadata but no key secret or hash. `internal` bypasses partner quotas,
but grants no additional endpoints or write permissions.

Deliver issued keys privately. Browser origins must be exact HTTPS origins,
without paths, trailing slashes, duplicates or wildcards (at most 20).
Rotation means issuing another key for the **same partner ID**, switching the
partner to it, and revoking the old key. Each key has its own allowance. A replacement
starts with the standard tier and fresh counters; explicitly apply the intended
policy before switching traffic. An internal key never automatically transfers its
unlimited status to a replacement. Revoking one key does not revoke other keys or
clear their counters. Multiple keys deliberately multiply a partner's available
quota, so operators must account for all active keys when onboarding.

Once the revoke command succeeds, subsequent authentication checks reject that
key on every instance connected to the same primary, **without redeploying**.
A request already authorized before the revocation committed can finish; no
revocation can undo an already delivered response. Revocation is permanent:
a database trigger prevents re-enabling the key or rewriting its revocation
audit. Repeating the command is safe and retains the first revoker and time.

Origin updates also apply before the next admitted read. Preflight approval requires an
active key for that origin's partner. A browser may retain a preflight for
five minutes, but every admitted read still checks the current key and origin;
that cache never delays revocation. An unavailable database fails closed with
503. There is no environment-variable key fallback.

## Quotas and errors

The same hashed-key registry supports these per-key policies:

| Tier | Minute allowance | UTC-day allowance |
| --- | --- | --- |
| `standard` | 300 | 50,000 |
| `custom` | Operator-selected positive integer | Operator-selected positive integer |
| `internal` | No partner quota | No partner quota |

Our frontend browser sends no private API key. Existing first-party routes keep
their own authentication and abuse controls. The server-only `BLAST_INFRA_API_KEY`
authenticates the Rust transport, independently of partner commercial quotas.
If an internal service calls `/api/v1`, issue a key in this registry and explicitly
set it to `internal`. Internal keys are server-only: requests carrying an `Origin`
are rejected, including origins registered for that partner. Never put an internal
key or the Rust/gas-pool credentials in a browser bundle or `NEXT_PUBLIC_*` variable.
Unlimited means no commercial minute/day or shared partner-admission quota; it
retains fresh primary authentication, revocation, read-only permissions,
pre-authentication abuse controls, per-key endpoint cost budgets, timeouts and
finite infrastructure capacity.

Limited keys consume the shared `partner_read` budget before product reads or
public-data cache lookup. Exact v1 GET/HEAD/OPTIONS operations delegate to the
regional, force-dynamic route with all three CDN cache headers set to no-store;
that route relays them to the backend API, whose admission performs Redis
recognition, fresh primary authorization, the origin check and quota admission,
in that order. Unknown
versioned paths, writes and partner requests to first-party paths are refused at
the Proxy boundary. Counters belong to the **key UUID**, across endpoints, IPs,
app instances and policy changes. HEAD counts too. Fixed minute/day windows are not
a smooth requests-per-second limit. Changing a policy does not reset its existing
counters; time spent on `internal` does not erase earlier usage. Reverting to a
limited policy in the same window resumes enforcement of that usage. Policy
changes and revocations apply at the next fresh authorization. Already-authorized
requests may finish.
Additional per-endpoint cost budgets can reject a request after its commercial
key budget is charged. Search is capped at 60/minute, discovery and market
status at 120/minute, public presales and prices at 300/minute, allowlist proofs at
120/minute **per verified key**, including internal keys. Custom commercial caps do not raise these cost
budgets. Partners sharing NAT egress have independent endpoint allowances;
changing IP cannot reset a key's endpoint usage. Key identity is passed as private
server context from fresh authentication; no request header selects it.
First-party unversioned paths retain IP-based endpoint controls and do not
accept partner keys. Configured quota Redis handles eligible public counters;
without Redis they use the primary. Other primary operations retain the normal
5-second acquire/8-second statement budgets. Product reads
and upstream calls have their own budgets; the short auth budgets do not establish a two-second end-to-end bound.
Alongside the individual budget, `partner_read_global` admits at most the partner
capacity's safe requests per minute, less its reserves, **across limited keys and
instances**. This conservative overload ceiling protects
shared first-party infrastructure; it is not a reserved allowance for each partner.
Redis checks and charges both budgets in one atomic script; a refusal spends neither.
Raise the shared ceiling
only after mixed partner/first-party load measurements on the deployed stack.
Partner responses disable shared caching; existing upstream/data caches remain.

429 includes `Retry-After` in seconds. Retry after that delay with jitter; cache
and coalesce reads on the partner backend. The quota is a request budget, not
a billing cap, and requests can have different costs. The individual and global windows use
the backend's atomic Redis limiter and `RATE_LIMIT_SUBJECT_PEPPER`; there is no
other quota store. Changing the namespace starts fresh allowances once.
Unavailable rate storage, or a Redis command whose outcome is uncertain, refuses
with 503 rather than granting uncapped access, and the read handler does not run.
Key storage and other database failures are also 503. A command that commits in
Redis but is reported as failed can still spend quota for a refused request; this
only reduces the remaining allowance.
Recognition checks every well-formed key against the Redis registry before any
primary lookup. Unrecognized keys are answered 401 without a database query and
spend unknown-key admission counters: at most 600/minute per IP and the smaller
of the partner capacity's unknown reserve and 3,000/minute across instances,
checked atomically before either counter increments. These are database-protection ceilings,
not additional commercial allowances or a reserved SLA: a distributed attack
can exhaust the global budget and cause valid partner requests to receive 429.
Frontend requests do not consume this partner budget.
Redis outages fail closed before registry access.

Recognition admission runs before any fresh grant, so its refusals never echo an
`Origin`: a browser sees them as an opaque CORS failure and cannot read
`Retry-After`; server-side callers get the status, code and `Retry-After`.
A key's operational per-minute cap counts every presented attempt, including
ones later refused with 401 or a scheduling 503, and answers 429
`partner_rate_limited`; 429 can therefore mean "too many attempts", not only
"commercial quota spent". Preflights for an allowed origin draw on a shared
reserve; each client network (IPv4 address, IPv6 /64) may use at most
`preflightPerIp` of it (default: a quarter of the reserve) and then receives
429, while an exhausted shared reserve answers 503. Browsers treat any non-2xx
preflight as a CORS failure. Many distinct networks can still exhaust the
reserve, and the per-network limit is only meaningful behind `trusted-proxy`
ingress with narrow CIDRs (in `direct` mode behind a platform proxy every user
shares the proxy's address).

Operator key and partner writes share one recognition lock with the replicas'
recovery. A write waits up to 5 s for it; after a full wait it has about 3 s of
its 8 s budget left for the snapshots and publish, so very large registries can
time out and should be retried. Each write leaves a pending trim. Recovery
normally makes one non-queuing attempt per 1–5 s tick and, once half of its 30 s
verification bound has passed, competes for the lock for up to 1 s. Writes that
hold the lock continuously, back to back or in parallel, can still keep every
trim out; replicas then answer 503 about 30 s after their last completed trim,
until the writes leave a gap.

Capacity mismatches are isolated by partner. A partner with no reservation, an
oversized key allowance, or active keys whose combined minute allowances exceed
its reservation is excluded from recognition and preflight origins. Other
partners can continue serving and administering keys, including during a Redis
rebuild. Stored policies and quota counters are unchanged. New keys or quota
increases that still exceed that partner's reservation are refused; reductions,
revocations and cleanup remain possible. Restoring a fitting reservation or
reducing/revoking keys allows recovery to recognize that partner again. Global
registry entry, byte and origin bounds still protect the shared service.

Key verification uses a separate primary pool, at most two connections per
backend process, a 1,000 ms acquisition budget, 500 ms statement
budget, and 750 ms client query budget. Key reads have a 100 ms lock budget.
Quota counters live in Redis and do not use this pool.
The primary remains on
every admitted read's critical path so acknowledged revocations deny access immediately; no positive key
cache or replica fallback trades that property for availability. Public list and
featured reads coalesce and retain successful results for at most 10 seconds;
detail reads coalesce only while in flight and never retain completed responses.
Malformed and unrecognized keys are rejected without a database query; only keys
that recognition knows reach the indexed primary hash lookup. Keep the Firewall's
ceilings in place too.

| Status | Partner error code | Meaning |
| --- | --- | --- |
| 401 | `partner_key_invalid` | Unknown, revoked or malformed key |
| 403 | `partner_read_forbidden` | Endpoint not in the allowlist |
| 403 | `partner_origin_forbidden` | Origin or preflight not permitted |
| 405 | `partner_read_only` | Unsupported method on an allowed endpoint |
| 429 | `partner_rate_limited` | Partner/global quota or key-lookup IP limit exhausted |
| 503 | `partner_api_unavailable` | Key database or limiter unavailable |

Bodies use the common `error.code` / `error.message` envelope. Existing endpoint
errors keep their own codes. A request without a partner header still needs the
normal first-party gate; a supplied invalid key never falls back to a gate cookie.

## Calls

```sh
curl 'https://www.blast.fun/api/v1/presales?limit=20' \
  -H "X-Blast-Partner-Key: $BLAST_PARTNER_KEY"
```

For a registered browser origin:

```js
const response = await fetch('https://www.blast.fun/api/v1/presales?limit=20', {
  credentials: 'omit',
  headers: { 'X-Blast-Partner-Key': partnerKey },
});
```

To fetch a coin's name, ticker, description, logo and project links, send
`GET /api/v1/market/coins/{coinType}/metadata` with the same partner key.
URL-encode the canonical coin type as one path segment. This read takes no query
parameters and covers confirmed Blast launches, indexed presales and indexed
external coins.

The response uses `coin_type`, `name`, `symbol`, `description`, `decimals`,
`icon_url`, `tagline` and a `links` object with `website`, `x`, `telegram`,
`docs` and `audit`. Missing values are null. Published Blast project links
take precedence over links embedded in the on-chain description. These are
project-provided URLs. An unknown coin returns 404 `not_found`.
The lookup shares the coin summary's per-key limit of 240
requests per minute. Cache and coalesce lookups on your backend.

The backend admission, reached through the regional v1 route, answers OPTIONS
preflights for registered origins, GET/HEAD, and the
partner header only. No cookie credentials are allowed. The actual request
must use a key belonging to that origin. `Retry-After` is exposed to browsers.
Preflights check origin eligibility against the Redis recognition registry, but do
not read product data or consume the authenticated quota.

## Rollout

Apply migrations `0124_partner_api_keys` and `0127_partner_key_tiers` on the release
primary before deploying the code, using the existing [migration procedure](../deploy/LAUNCH-DEPLOY.md#step-4-web-migrations-through-0104).
Then deploy once and create partners and keys through the CLI. Later issuance,
rotation, revocation, tier and origin updates require no deployment. Migration 0124
creates empty tables; 0127 preserves existing keys as standard and records an initial
policy audit event. The change from partner-account counters to key-UUID counters
starts a new quota allowance at rollout; schedule that change explicitly. Never
promote existing keys to internal as part of a schema migration. The earlier unshipped environment registry is not imported.
Remove any old `BLAST_PARTNER_API_KEYS` setting and reissue any keys from that
prototype. Retire old prototype deployments that still accept environment keys.

Keep the existing global and per-family Firewall ceilings. Before onboarding,
check that managed browser challenges permit these machine reads and browser
preflights on the allowlisted paths; any scoped exception must retain edge rate
rules. A header's presence is never proof of authentication. The app rejects
malformed keys locally without a database call. Confirm first-party calls, approved
and unapproved browser origins, revoked keys, 429 and 503 on a preview before
issuing production keys. No keys or Firewall changes are
created automatically by this code change.

References: [OWASP REST security](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
and [MDN CORS guidance](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/CORS).

## Versioning and compatibility

V1 is selected by the URL, independently of OpenAPI's `info.version`. The dedicated
`modules/partner-api/v1` registry and runtime bind only the documented read services.
Do not rewrite versioned traffic to frontend route files or infer new endpoints from them.
Partners must use `/api/v1/*`. Unversioned `/api/social/...` and `/api/launchpad/...`
routes are first-party only: a partner key or partner-key preflight receives
403 `partner_read_forbidden`, even with a valid browser gate cookie. These routes
retain the frontend's existing session, gate and abuse controls. A browser gate
cookie is not partner identification; anonymous public reads remain subject to
first-party controls rather than commercial partner quotas.
V1 requires a partner key even with browser cookies; its endpoints share each
key's quota and immediate revocation.

Breaking changes to required fields, types, units, nullability, existing enum values,
parameter meanings, defaults, pagination, statuses or error codes require v2. New
endpoints and optional response fields are additive. Keep v1 operational during an
announced migration; no retirement is scheduled. Publish migration/deprecation/retirement
dates before requiring a move. Keep cursors within their original endpoint/version/filters.

Backend contract fingerprints and the docs' committed OpenAPI wire-contract baseline
make schema drift a test failure. They are never regenerated during a build. Review
additive changes explicitly before updating a baseline; incompatible shared-service
changes need a v1 adapter and response tests, rather than accepting a new v1 baseline.
The fingerprints protect the shared social schemas; the docs baseline covers all twelve
operations, and runtime tests cover routing, query preservation, response/error forwarding,
HEAD, no-store and auth boundaries. They do not replace semantic compatibility review.

Chart range compatibility review (2026-10-26): the shared prices response adds
`1h`, `6h`, `7d` and `30d` to its `window` enum. These values are returned only
when explicitly requested. Existing default/explicit `24h` and `launch` requests
keep their response fields, units, nullability and automatic source tier; the
optional `interval` parameter changes tier selection only when supplied. The
existing query and window-plan regression tests pin the old defaults and launch
behavior. The v1 fingerprint update was independently reviewed as additive.
Clients opting into new windows must accept those values in response validators.

The presale detail `quote_price` description now reflects the existing lookup
by exact quote type. Only the JSON Schema description changed. V1 keeps the
same response fields, USD units, observation time, and null handling.

## Automated release gate

Vercel's build command runs `test:partner-live`, builds the candidate, then runs
`check:partner-live -- --built`. A failed check exits nonzero **before Vercel
publishes the deployment**. The check starts that exact compiled app on a private
loopback port using the deployment's real database/indexer configuration. It does
not test the previous production version and mistake that result for candidate
coverage. This applies to production and preview builds; unconfigured data
sources fail the gate rather than silently skipping it.

The gate also requires partner-key requests to representative unversioned social
and launchpad routes to return 403 `partner_read_forbidden`.

The gate uses `/api/admin/partner-keys`, the same authenticated route used by the
admin console, to prepare a backend-only `ci-partner-read-api-<run UUID>`
partner, issue a new key, and revoke it. It reads all three presale lifecycle
lists, selects an actual presale ID, then tests featured presales, detail, SUI and
presale prices, coin search, market status, and HEAD. Success requires HTTP 200,
the pinned public JSON schemas, the v1 header, and `no-store`. Status must have a
checkpoint no more than five minutes behind; the requested coin search group
must be available or empty. Empty price/history arrays remain valid. A database
with no presales fails explicitly because a real detail test cannot be completed.

After revocation acknowledgement, the **first** request to each tested URL must
return `401 partner_key_invalid`; no retry or delay can turn delayed revocation
into a pass. The admin audit record must also show revocation. Coming-soon
launchpad operations are deliberately excluded from the success matrix; their
503 is not treated as a passing live endpoint. Promote them into the matrix with
real resource selection when launchpad indexing is enabled.

Raw keys stay in memory. Output contains operation names, statuses, timing and
sanitized failures, never keys, admin tokens, response bodies, or database URLs.
An independent cleanup connection uses the runtime primary `DATABASE_URL` to
remove only this run's UUID-labelled keys, policy fixtures and temporary partner, even
when issuance loses its response or the candidate's revoke handler is broken.
Cleanup failure blocks release. SIGINT/SIGTERM abort checks and enter cleanup;
a hard process kill cannot run finally, so the next gate also removes abandoned
gate fixtures older than an hour. Migration `0128_partner_release_fixture_cleanup`
provides a restricted database function: it accepts only the reserved per-run
partner/label pair, leaves concurrent recent runs alone, and grants no general
DELETE permissions. Real partner keys and audit rows are preserved. Reserve the
`ci-partner-read-api-<UUID>` namespace for the gate.

Production requires its existing `PRESALE_ADMIN_TOKEN`. A preview without that
credential uses a random token only in its isolated loopback process; this does
not set a deployment environment variable or enable the deployed preview's admin
API. Frontend launch flags and the team password are inherited unchanged.

For an operator-run check against an already deployed host:

```sh
# Load private configuration: DATABASE_URL for that host's primary and its
# PRESALE_ADMIN_TOKEN. Never put either value directly in command arguments.
npm run check:partner-live -w @blast/web -- --origin https://www.blast.fun
```

The check also opens **https://docs.blast.fun** in one ephemeral Chromium browser.
Two tabs exercise the OpenAPI reference's **Test Request / Send** controls and the
playground's **Send request** form. Both enter this run's real key and request
market status through the published docs relay. Each requires a new network
response, HTTP 200 inside the relay envelope, the pinned schema and fresh
checkpoint, and an on-screen status and JSON body matching that response exactly.
After admin revocation, the next click in each existing tab must return and display
`401 partner_key_invalid` with the **same key**. Neither request is retried.
The gate fails on browser startup, navigation, missing controls, relay errors,
incorrect/stale UI output, or unsuccessful revocation. Primary cleanup still runs.

Chromium and Playwright are pinned development dependencies. The browser receives
no admin/database credentials and uses a fresh temporary profile; no traces, HARs,
screenshots, downloads or saved authentication state are recorded. Browser errors
are sanitized because Playwright diagnostics can include input values. Both tabs
and the browser close when the run finishes or is interrupted.

The check consumes roughly twenty-four requests from the CI partner's separate
quota and has a four-minute deadline, plus bounded cleanup. The browser check
covers the **currently published docs, its relay, and production API through the
public network**; the direct checks separately cover the newly compiled API.
It does not test an unpublished docs candidate or run automatically on docs-only
deployments. Run this same command after docs changes as well. The published
docs relay checks the production key store. Run this production gate only in a
trusted release context. Preview deployments must use isolated databases,
credentials, and a docs relay pointed at that same isolated API; sharing production
write credentials with arbitrary preview branch code is unsafe. An isolated
preview will fail the published production relay check, so provisioning its
matching docs environment is required before enabling that gate there. The admin
browser UI is not covered.
The source-pinned contracts and dated success fixtures live in
`apps/web/scripts/partner-api-live/`. Unit tests cover upstream failures, schema
drift, caching, stale data, lost issuance responses, cleanup failure, and a revoked
key accepted even once. `cleanup.integration.mjs` verifies cleanup with actual
`blast_web` PostgreSQL permissions on the disposable migration rehearsal database.

Build mechanism: [Vercel custom build commands](https://vercel.com/docs/builds/configure-a-build)
and [Next.js production server](https://nextjs.org/docs/app/api-reference/cli/next).

## Redis storage and public caching

Set server-only `BLAST_QUOTA_REDIS_URL` to the dedicated persisted, `noeviction`
Render Key Value service. Never point it at `BLAST_CACHE_REDIS_URL`. The optional
cache refuses a hosted quota endpoint shared by hostname and port, regardless of
password or default-port spelling, and records `shared_store_refused`. Render's
TLS `*-keyvalue.render.com` proxy is the sole exception: distinct, valid Render
service-ID usernames identify separate stores behind that shared host. Generic
ACL usernames never bypass the guard.
Loopback integration tests may deliberately share their disposable store. The client
verifies the effective memory policy and hosted AOF status on each connection
before admitting traffic. Keep these managed settings fixed; changes on an
existing connection require a consumer reconnect to be checked. Lua checks every window before incrementing any; Redis supplies the
clock and TTLs align to fixed UTC windows. Counter keys use HMAC subjects and
omit cap values, preserving usage when policies change. A configured connection
failure, timeout, OOM or invalid decision refuses with 503, without PostgreSQL
fallback or automatic replay of uncertain commands. Connections and command
queues are bounded; in-flight deadlines close stalled sockets. Successful command
latencies are sampled at 2%; failures retain fixed outcome labels. Cold warmup
uses one coalesced promise retained by the originating request with waitUntil;
module import starts no network work, and ready/backoff paths send no warm PING.
Admission still awaits the connection safety checks. Invalid quota configuration
emits one fixed diagnostic per process; endpoint details are never logged.

Corrupted counters deliberately fail closed for the affected subject: resetting
them automatically would erase spent allowances. Alert on `redis.command`
`counter_corrupt` outcomes; its bounded `window` index identifies the affected
window in the admission's bucket order. `reply_error` reports other command
refusals, while benign script-cache misses use `script_missing` and optional
cache warm-up/backoff events are sampled at 2% in both Redis and public-cache metrics.
`replica_or_down` reports `READONLY`/`MASTERDOWN`: the refused command is not
replayed, and the socket reconnects after the same bounded one-second backoff.
No subject identifiers or Redis
error messages enter these logs. `redis.command.latency` is a separate duration series.
An authorized operator should investigate unexpected writers, preserve the
counter and its remaining TTL for diagnosis, then repair only the damaged
counter using known usage or a conservative exhausted count for the same UTC
window and expiry. If usage cannot be established, let its existing TTL expire.
Never flush the store, rotate the namespace, or delete counters to recover an
individual partner. Other subjects continue using the same connection.

Render journals every second; a crash may lose up to a second of recent traffic
counts. These are abuse/commercial request budgets, not billing ledgers or
financial reservations. Sponsorship balances, write quotas, transactions,
authoritative key metadata, primary revocation checks and append-only policy
audits remain in PostgreSQL. Internal keys still require fresh authorization.

`BLAST_CACHE_REDIS_URL` selects a separate disposable `allkeys-lru` public-data
cache. Public presale listings and price histories expire after at most ten
seconds. Fresh presale lifecycle detail, private reads, credentials and errors
are never retained. Envelopes authenticate the key, payload and expiry with a
domain-separated HMAC key derived from the existing server-only subject pepper, rejecting
forged values, cross-key swaps and replay past the signed expiry. Authorization, commercial quotas and route abuse checks
run before cached data is returned; cache hits still count. Cache outages fall
back to the source with local request coalescing. Cold cache connections warm in
the background, so connection establishment never delays source reads. Short distributed locks reduce
simultaneous misses; ownership checks prevent an expired writer overwriting a
newer result. Waiters can acquire a released lease after an uncacheable null/error
without spending the entire one-second contention window. They cannot steal a
held lease or publish without ownership; a still-held lease retains bounded
source fallback. A miss poll adds one SET-NX attempt while within that window,
and starts no new lease attempt after the wait deadline. Responses remain
private/no-store for partners.

Each public-data cache scope also retains already authenticated Redis payloads
locally for at most 250 ms, bounded by their original signed expiry. Hits never
extend either deadline. Retention is limited to 128 entries and 4 MiB of
accounted UTF-16 payload/key storage per scope (up to three scopes per process,
plus object overhead). Serialized retention excludes earlier consumer mutations;
concurrent coalesced reads share a result and must treat it as read-only. Redis changes or
deletions may leave previously verified public data visible within that 250 ms
window; credentials, revocations and quotas never use this cache. Successful
cache-hit metrics sample 2% with `tier` and `sampleRate` fields; they are not
exact request counts. Cache failures remain unsampled.

`BLAST_REDIS_NAMESPACE` must identify the environment and selected deployment;
production and previews must never share it. Quota keys additionally bind the
Vercel target and preview branch, preventing counter sharing if a base namespace
is copied. Public cache keys additionally
bind backend deployment provenance, origin, database identity and environment.
Do not rotate the subject pepper or change namespaces as a policy update: that
would reset counters. Keep TLS URLs and passwords out of browser/public envs,
logs and repository examples. Render external access must admit the consuming
platform's egress; internal Render URLs cannot be reached from Vercel.

Run `npm run test:integration` from the repository root inside the workspace
heavy-job guard, or one file with `npm run test:integration -w @blast/core -- <file>`
(`@blast/server` for the partner-key usage and public-read runtime files). For each
file that needs them, `scripts/test-integration.mjs` provisions isolated loopback
Valkey 8 and PostgreSQL 18 with Docker, exercises
cross-connection quotas, failure/recovery under traffic, wrong eviction policy,
script reload and cache integrity/expiry, then removes both stores. Setup failures
are errors, never successful skips. The production partner path (recognition,
primary authorization and Redis quotas) is exercised by
`apps/backend-api/test/partner-runtime.integration.test.ts` in that workspace's
`test:integration`.
The ordinary PostgreSQL integration runner remains available independently.

## Admin usage visibility

Authenticated GET `/api/admin/partner-keys` includes an optional `usage` map by
key UUID. Active metered keys include `minute`, `day`, `observedAt`,
`minuteResetsAt`, and `dayResetsAt`. Reads use the same subject HMAC, policy
version and store as enforcement, in batches of at most 100 keys. Redis uses
its clock and existing namespace; PostgreSQL uses the primary and its clock.
Reads never increment counters, refresh TTLs or reset allowances. No schema
migration is needed. These are current fixed-window quota counts, including
cached reads and admitted requests that later fail; they are not historical
request analytics. Internal keys bypass commercial quotas and are not counted.

If telemetry cannot be read, `usage` is null while the key list and revocation
remain available. A configured Redis failure never falls back to PostgreSQL
counters. The admin proxy whitelists numeric counts and timestamps; secrets and
hashes remain excluded. The console handles older backend responses without
usage, polls every 30 seconds, and offers manual refresh and revoked-key history.
Deploy the backend response before the admin console to populate the counts.

### Public market read sharing

Successful public market GETs for holders, activity, pool summaries, candles and
trades share the existing signed public-data cache for five seconds. Each caller
still authenticates and consumes its own quotas before cache lookup. Status and
readiness are never retained by this inner cache. Non-200 responses and malformed
JSON are not cached; a fresh retry can recover. Bodies above 256 KiB bypass
retention, and upstream streams are cancelled at the 4 MiB response limit.
Keys include the canonical upstream URL and the deployment/environment/data
identity namespace. Only public payloads enter the cache; no cookies, keys or
private account responses do. Cache outages use the bounded source-read path;
quota outages refuse admission. This reduces repeated Rust reads and primary
counter writes, but local fixture measurements do not establish hosted capacity.

### Accepted security gap

The owner has retained the shared admin password temporarily. It provides no
individual attribution or operator MFA. Named sign-in with MFA remains a launch
security gap; the shared audit actor is not a substitute.

### Deleting revoked keys and inactive groups

The admin supports `POST {action:"delete-key",id:<key UUID>}` and
`POST {action:"delete-partner",id:<partner ID>}` on the authenticated management
route. A key must already be revoked. A group must have no active keys; deletion
also removes all its revoked keys and their configuration history. Empty groups
can be deleted, and their ID can be reused. Missing targets return 404; active
credentials return 409. The console requires a permanent-deletion confirmation.

Apply migration `0129_partner_admin_deletion` before deploying the API, then the
console. The runtime invokes narrowly granted database functions and retains no
general DELETE permission. The parent row lock serializes deletion with key
issuance, so a newly active key cannot be silently removed. Immutable deletion
receipts retain the server actor, target, timestamp and removed-key count in
`partner_api_deletion_events`, without credentials or hashes. These receipts are
separate from the admin list. CLI equivalents are `delete-key <UUID>` and
`delete-partner <partner ID>`, using the existing operator authentication.
