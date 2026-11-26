# Bot protection for the web API (WP3)

Owner decision (2026-10-07): "even reads need to be protected; assume bots
will be scanning our frontend and backend." Writes keep their own auth and
policies (Privy tokens, wallet sessions, CSRF, mutation guards). This
document covers what sits in front of all of them:

1. the **Vercel Firewall** at the edge (configured at deploy, rules below);
2. a **first-party API gate** in the proxy (`apps/web/src/proxy.ts`);
3. **rate limits** on every route, reads included.

Approved partners can also use the [partner read API](partner-read-api.md).
Exact v1 GET/HEAD/OPTIONS reads bypass the cookie gate into a regional,
force-dynamic handler with CDN caching disabled. That handler authenticates
`X-Blast-Partner-Key` and consumes shared quotas before any product read or data
cache. Partner requests outside the v1 allowlist are refused at the Proxy boundary;
unversioned routes remain first-party only.
Registered browser origins can preflight the explicit read allowlist. Partner
keys grant those public reads independently of UI visibility flags; they do not
grant account access or writes. No forwarded header asserts authorization.

## Threat model

| Threat | What stops it |
| --- | --- |
| Floods (L3/L4/L7), cheap volumetric scans | Vercel's automatic DDoS mitigation; Firewall rate rules per path family (below). Blocked traffic is not billed. |
| Scripts calling `/api/*` directly (scrapers, scanners, quote/price farming) without ever loading a page | The API gate: no gate cookie, 401 before any route, database write or cache. |
| Scripts that load a page first, then call the API | Per-family rate limits (per IP, IPv6 per /64; per account where signed in); Firewall rate rules; Bot Protection managed ruleset. |
| Cache-busting public reads (`?cursor=`, `?limit=`, random query) | The gate runs before Vercel's cache, plus per-IP buckets on the expensive families (search, discovery, quote, portfolio). |
| Many free Privy accounts multiplying per-account budgets (sponsored gas) | Per-IP layers, a per-account daily share and a platform-wide per-UTC-day cap on every sponsorship (the HTTP routes and the in-process trade and withdrawal paths alike), counted only for requests that passed validation and the dry run (reservations) or the signature check (executions); Firewall challenge on `/api/presale/sponsor*`. |
| Spoofed client IPs | The app trusts only Vercel's `x-forwarded-for` (see "Client IP"). |

The gate is not authentication and not a CAPTCHA: a headless browser passes
it. It removes the cheapest attacks (blind API calls) and makes every other
one go through a page load, which the Firewall can see, count and challenge.

## The API gate

### Cookie

- Name `__Host-blast_gate` over HTTPS (`Secure`, `Path=/`, no `Domain`);
  `blast_gate` without `Secure` over plain HTTP (local `next dev` only).
- `HttpOnly; SameSite=Lax; Path=/; Max-Age=7200`.
- Value `v1.<issued-at epoch seconds>.<16 random bytes, base64url>.<HMAC-SHA256>`,
  the HMAC over `blast-gate:v1:<issued-at>.<id>` with `BLAST_GATE_SECRET`.
  It names nobody and authorizes nothing; it only proves a page of this site
  was loaded within the last two hours.
- Lifetime **2 hours**; a page load re-issues it once it is older than
  **30 minutes**, so an active tab never lets it lapse.
- Verification (`apps/web/src/lib/web-security/api-gate.ts`) is one HMAC per
  configured secret and `timingSafeEqual`: no database, no network. A clock
  skew of 60 s is tolerated for tokens that look slightly in the future.

### Where it is issued

The proxy adds `Set-Cookie` to **every page GET/HEAD** it answers (any path
outside `/api`) when the request has no valid gate cookie or one older than
30 minutes. That covers:

- the first document navigation: the cookie arrives on the HTML response
  itself, so every same-origin fetch made after hydration already carries it
  (no race: no script runs before that response);
- the App Router's RSC navigations and prefetches: they are page requests to
  the proxy too (Next strips the RSC headers, so the proxy cannot and need not
  tell them apart), so client-side navigation keeps the cookie fresh and is
  never blocked (pages are not gated);
- `GET /api/gate` (below) for a tab whose cookie has expired.

API responses never carry a gate cookie, so a CDN-cached API answer never
holds one.

### Where it is checked

`apps/web/src/proxy.ts` runs the gate **first**, for every `/api` and `/api/*` path
(the matcher covers `/api/:path*`), every method. A request without a valid
cookie that is not on the allowlist gets:

```
HTTP/1.1 401
Cache-Control: no-store
X-Blast-Gate: required
Content-Type: application/json

{"error":"gate_required"}
```

with the site's usual security headers. Nothing behind the proxy runs: no
route, no rate-limit write, no CDN cache entry. The gate is default-on, so a
new `/api/*` route is gated automatically; exempting one means adding it to
the allowlist and its test.

A production build fails without `BLAST_GATE_SECRET` (the build gate
parses `apps/web/src/lib/web-config.ts`), and a production server missing
it fails every request. A hosted preview without it answers
every gated request `503 {"error":"gate_unavailable"}` (fail closed).
Local runs (`next dev`, tests) use a random per-process secret. A set but
short `BLAST_GATE_SECRET` or `BLAST_GATE_SECRET_PREVIOUS` fails the parse
everywhere.

### Path spellings

The gate decides "API or page" from the path the proxy receives. Checked on
a production build (`next start`, `curl --path-as-is`, no cookie; review M4):
dot segments, `%2e` segments and backslashes are resolved by the URL parser
before the proxy (`/./api/...`, `/x/../api/...`, `/api\social\feed` are
refused with 401); Next answers `//api/...` and a trailing slash with a 308
to the canonical path; every other spelling (`/%61pi/...`, `/API/...`,
`/api%2Fsocial/feed`, `/%2Fapi/...`) reaches the proxy as a page path, which
the route policy rewrites to a fixed page or refuses. None reached an API
handler. `api-gate.test.ts` pins both halves.

### Allowlist (`API_GATE_EXEMPTIONS`)

Matched on method and exact path, plus a header check where stated. ID segments
use `[A-Za-z0-9_-]`. Each route retains its own authorization and applicable
rate limits. The web app serves no `/api/admin/*` route; operator requests go to
the backend, which checks the operator bearer.

| Name | Requests | Why |
| --- | --- | --- |
| `vercel-cron` | `GET /api/mission-control/maintenance/cleanup` with `Authorization: Bearer $CRON_SECRET` (checked constant-time in the proxy) | Vercel Cron sends no cookie. |
| `reward-manifest` | `GET/HEAD /api/presale/rewards/rounds/{round_id}/manifest` | Public by contract (docs/presale/rewards.md). |
| `receipt-image` | `GET/HEAD /api/presale/receipts/{presale_id}/{wallet}/image` | Share image fetched by X, Telegram and other unfurlers. |
| `presale-agent-key` | `POST /api/presale/allowlists`, `GET/HEAD /api/presale/allowlists/{id}`, `POST /api/presale/allowlists/{id}/bind`, each with an `X-Blast-Api-Key` of the key's shape (`blast_ak_` + 43 base64url) | AI agents; the route kit verifies the key (one indexed hash lookup). A forged key of the right shape passes the gate, so the kit counts every lookup per client IP first (`presale_api_key_ip`, in memory) and remembers an unknown key for a minute; the Firewall's agent-key rule (below) bounds it at the edge. |
| `wallet-metadata` | `GET/HEAD /api/social/sign-in/slush-metadata` | Fetched by the Slush wallet (dApp Kit), not by our pages. |
| `og-image` | `GET/HEAD /api/og` | The social card (an `apps/web/vercel.json` rewrite). |
| `gate-refresh` | `GET /api/gate` with `Sec-Fetch-Site: same-origin` | Re-issues the cookie (below). |

### `GET /api/gate` and the client retry

`apps/web/src/app/api/gate/route.ts` (`apps/web/src/lib/web-security/gate-refresh.ts`):
requires `Sec-Fetch-Site: same-origin` and, when sent, the site's `Origin`
(else 403 `gate_forbidden`); counts `web_gate` (30 per 10 minutes per IP;
429 `rate_limited` with `Retry-After`); answers `204` with a fresh
`Set-Cookie`, `no-store`. A script can forge the fetch-metadata headers; the
endpoint gives out nothing a page load does not, at a bounded rate.

In the browser (`apps/web/src/lib/api-gate-client.ts`):

- `GateAwareFetch` (rendered first in the root layout) wraps
  `globalThis.fetch` once, when its module loads, before any component's
  effect can fetch. Every caller gets the rule, including helpers that take
  `fetch` as a default parameter.
- The shared helpers default to `gatedFetch` explicitly as well:
  `callSocialApi` and the other social clients, the launchpad discovery,
  search, theses and asset-upload clients, and the
  wallet sign-in client. Presale calls go through `callSocialApi`.
- For a same-origin `/api/*` call: `credentials: "omit"` becomes
  `"same-origin"` (an HttpOnly cookie can only ride with credentials; the
  public reads that used to omit them now send `same-origin`, which changes
  nothing for the routes: `auth: "none"` routes never read a cookie). On a
  `401` with `X-Blast-Gate: required` it calls `GET /api/gate` once (shared
  by all calls refused at the same moment) and retries the call once. A
  streamed body or an aborted call is not retried. Other origins and paths
  pass through untouched.

### CDN caching

The gate runs in the proxy, before Vercel's cache, so a cached public answer
is still only served to gated requests. `withCachePolicy`
(`apps/web/src/modules/read-routing/cache-policy.ts`) ignores the gate cookie (exact
names `__Host-blast_gate`, `blast_gate`): a request whose only cookie is the
gate's is still publicly cacheable (discovery), while any other cookie keeps
it `private, no-store` as before. The social and presale kits' public caching
never looked at cookies and is unchanged, except in team mode (below), when
nothing is shared through the CDN.

## Launch flags

The server reads the launch flags for social, presale, trading, and the
launchpad. Both `true` and the legacy value `team` enable a surface publicly.
Unset or disabled surfaces follow the route policy. The API gate, session checks,
and rate limits still apply. Private release verification uses a protected preview.

## Rate limits

All buckets live in `packages/core/src/lib/web-security/rate-limits.ts` (registry version
**29**). Windows are fixed and start on multiples of their length from the
Unix epoch, so an 86,400 s window is one UTC day. Subjects are HMAC'd with
`RATE_LIMIT_SUBJECT_PEPPER` before storage.

When `BLAST_QUOTA_REDIS_URL` is configured, public social read, search,
discovery, theses and market traffic budgets use the dedicated quota Redis.
They retain the same limits and charge requests before the data handler,
including cache hits. Namespaces are isolated by deployment environment and
preview branch. First-party endpoint subjects remain client IPs. Partner v1
endpoint subjects are verified key UUIDs, so partners sharing NAT egress do not
spend each other's endpoint budgets. The commercial key/global budgets run first;
partner keys are refused on unversioned frontend paths.
Without Redis configured these budgets retain PostgreSQL admission. A
configured Redis failure answers 503; it never switches to fresh PostgreSQL
allowances. The initial move of a first-party traffic bucket from PostgreSQL
to Redis starts that bucket's windows once.

Account-private `me`, sign-in, mutation and sponsorship budgets remain in
PostgreSQL. This moves traffic counters only: private responses, accounts and
wallet sessions are not cached in Redis. Financial execution and daily gas
budgets retain their durable enforcement.

### Client IP

The backend creates a `ClientAddress` at its trust boundary from a verified private
proof, gateway proof, or transport peer. Handlers receive it explicitly; they do
not read forwarded headers. Both transport adapters strip caller IP headers.

`canonicalAddress` validates one IP literal for signing, recognition, and login
admission. `ClientAddress.address` carries that value. Its `rateKey` counts IPv4
and IPv4-mapped IPv6 per address, and IPv6 per /64 (`2001:db8:1:2::/64`). Missing
or malformed client identity is refused at ingress rather than sharing an
`"unavailable"` rate subject.

### Buckets added or changed (WP3)

| Bucket | Subject | Limit | Routes |
| --- | --- | --- | --- |
| `web_gate` | IP | 30 / 10 min | `GET /api/gate` |
| `social_pnl_card_publish` | Account | 30 / hour | `POST /api/social/me/pnl/card` |
| `launchpad_search` | IP | 60 / min | `GET /api/launchpad/search` |
| `launchpad_discovery` | IP | 120 / min | `GET /api/launchpad/discovery` |
| `defillama_read` | IP | 120 / min | Public `/api/v1/defillama/{metadata,metrics,contracts}` reads |
| `defillama_public_global` | Global | 300 / min | Combined public DeFiLlama reads, also subject to `partner_read_global` |
| `launchpad_wallet_launches` | IP | 120 / min | `GET /api/launchpad/wallets/{address}/launches` |
| `launchpad_theses_read` | IP | 240 / min | `GET /api/launchpad/theses` |
| `mission_control_read` | IP, **per instance** | 240 / min | `GET /api/mission-control/season-zero` |
| `wallet_ip` | IP | 30 / 10 min | Every wallet challenge issue and verify (`walletChallengeRateLimiter`: social wallet sign-in and links), before `wallet` (IP + address + operation), so rotating the address cannot multiply it |
| `mission_control_card_image` | IP | 300 / min | `GET /card/{id}/image`, outside `/api` (no gate): a URL that is not exactly the one the app emits (lowercase id, `format=card` or a share image's `recruits`, the current `v`) is first redirected (307, `no-store`) to it, so a random query cannot miss the CDN; only canonical requests count and read the card |
| `presale_api_key_ip` | IP, **per instance** | 300 / min | Every `X-Blast-Api-Key` lookup on the agent routes, before the key is read; an unknown key is then remembered for 60 s |
| `presale_bridge_status` | IP | 120 / min | `GET /api/presale/bridge/transfers/{id}` |
| `presale_allowlist_read` | account or API key | 120 / min | `GET /api/presale/allowlists/{id}` |
| `presale_sponsor_ip` | IP | 120 / 10 min | Every sponsorship: `POST /api/presale/sponsor` counts it before the body (then `presale_sponsor`, 30 / 10 min per account); the in-process trade (`POST /api/social/trades`) and cross-chain withdrawal (`POST /api/social/bridge-withdraw`) paths count it inside the sponsor service, after the dry run |
| `presale_sponsor_account_daily` | account | 100 / UTC day | Every sponsorship, inside the sponsor service after the policy and the dry run, before the platform cap: one account's share of it |
| `presale_sponsor_global` | platform | `PRESALE_SPONSOR_DAILY_CAP` / UTC day (default 20,000) | Every sponsorship, inside the sponsor service after the policy and the dry run, just before the slot is claimed and the pool reserves coins: a body, target or simulation the sponsor refuses never spends it |
| `presale_sponsor_exec_ip` | IP | 60 / hour | `POST /api/presale/sponsor/{id}/execute` |
| `presale_sponsor_bad_signature` | reservation | 2 / hour | `POST /api/presale/sponsor/{id}/execute`: each wrong signature on a reservation counts; the third expires the reservation (`reservation_expired` from then on) |
| `presale_sponsor_exec_global` | platform | `PRESALE_SPONSOR_EXEC_DAILY_CAP` / UTC day (default 5,000) | `POST /api/presale/sponsor/{id}/execute`, counted only for an unexpired reservation whose signature verified, just before it is submitted and gas is spent (the per-account `presale_sponsor_exec`, 10 / day, is unchanged) |
| `social_read` | IP | 600 / min (unchanged) | now only the feed, items, profiles, Happening, activity, callsigns and the signed-in private reads |
| `social_read_search` | IP | 60 / min | `GET /api/social/search` |
| `social_read_presales` | IP | 300 / min | `GET /api/social/presales`, `/presales/{id}` |
| `social_read_prices` | IP | 300 / min | `GET /api/social/prices` |
| `social_read_trade_coins` | IP | 120 / min | `GET /api/social/trades/coins` |
| `social_read_portfolio` | IP | 60 / min | `GET /api/social/profiles/{callsign}/portfolio` (fullnode) |
| `social_read_quote` | IP | 240 / min | `POST /api/social/trades/quote`, every caller |
| `social_trade_quote_anon` | IP | 20 / min | `POST /api/social/trades/quote`, signed out (signed in: `social_trade_quote`, 120 / min per account, unchanged) |
| `social_me_read` | account | 300 / min | `GET /api/social/me`, `/me/settings`, `/me/profile`, `/me/notifications/unread` |
| `social_auth_failure` | IP, **per instance** | 60 / 10 min | The social kit: a wallet session cookie that names no live session counts; once full, no cookie from that IP is looked up until the window ends (`rate_limited`, or anonymous on an optional route). Privy tokens verify locally and cost no lookup |
| `social_deposit_register` | IP | 20 / 10 min | `PUT /api/social/me/deposits/{id}` with a burn hash not registered yet (the presale register route already counts `presale_bridge_register` per IP). Besides, a Privy account may hold at most 5 registrations Circle has not attested (`BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT`, both register paths; `rate_limited`, Retry-After 300 s) |

429 bodies keep each namespace's shape: `{"error":{"code":"rate_limited"}}`
(social, presale), `LAUNCHPAD_RATE_LIMITED` (launchpad), `RATE_LIMITED`
(Mission Control), always with `Retry-After` and `no-store`. A limiter that
cannot answer fails closed (503), like the kits.

Expensive anonymous routes that already had a bucket keep it:
`presale_receipt` (60 / min, receipt image), `presale_proof` (120 / min),
`presale_bridge_quote` (60 / min, Circle), `presale_reward_proof`
(manifest, 120 / min).

### Storage amplification

PostgreSQL-backed checks write one `INSERT … ON CONFLICT` per bucket on the
primary. Eligible public traffic checks use Redis instead, so cache hits no
longer require a PostgreSQL counter transaction when Redis is configured.
Other protections reduce storage amplification:

- the gate refuses unknown clients in the proxy, so they never reach a
  limiter (no write for a blind scan);
- The season summary, agent API key checks, and failed wallet-session
  lookups use bounded per-instance counters where configured. The limiter drops
  expired windows, then the oldest, when it reaches 50,000 windows.
- the Vercel Firewall's rate rules (below) should absorb floods before the
  app: they are evaluated at the edge and denied traffic is not billed.

A request that passes the gate and counts in two buckets (an anonymous quote:
`social_read_quote` then `social_trade_quote_anon`; a sponsor: IP, account,
then, after the dry run, the account's daily share and the platform) costs
one counter update per bucket in its selected store, stopping at the first full one.

## Environment

| Variable | Scope | Notes |
| --- | --- | --- |
| `BLAST_GATE_SECRET` | server only (never `NEXT_PUBLIC_`), Production and Preview | At least 32 characters (e.g. `openssl rand -base64 48`). Required in production: without it the build fails. |
| `BLAST_GATE_SECRET_PREVIOUS` | server only, optional | Accepted for verification, never used to sign. |
| `PRESALE_SPONSOR_DAILY_CAP` | server, optional | Whole number 1 to 10,000,000; default 20,000. A malformed value makes the sponsor route 503 rather than run uncapped. |
| `PRESALE_SPONSOR_EXEC_DAILY_CAP` | server, optional | Same bounds; default 5,000. |
| `RATE_LIMIT_SUBJECT_PEPPER`, `CRON_SECRET` | unchanged | `/api/gate` and the new buckets need the pepper. |

**Rotating `BLAST_GATE_SECRET`:** set `BLAST_GATE_SECRET_PREVIOUS` to the
current value and `BLAST_GATE_SECRET` to a new one, redeploy, and remove
`BLAST_GATE_SECRET_PREVIOUS` after two hours (the cookie lifetime). Without
the previous value a rotation is still safe: open tabs get one 401, refresh
through `/api/gate` and retry. To revoke every cookie at once (a leaked
secret), rotate without `BLAST_GATE_SECRET_PREVIOUS`.

The standalone k6 scenarios load `/privacy` once to obtain the gate cookie.
Run them against a local app backed by disposable test data.

## Recommended Vercel Firewall rules (configure at deploy)

The project runs in one region (`iad1`), so Firewall rate counters are not
multiplied across regions. Roll every rule out as the Firewall guide
recommends: add it with action `log` and a generous limit, review the
dashboard's traffic for the rule, then switch to `rate_limit` / `challenge` /
`deny`. Rules are evaluated top to bottom.

1. **Bypass Vercel Cron** (first): path equals
   `/api/mission-control/maintenance/cleanup` AND header `user-agent` contains
   `vercel-cron` AND header `authorization` exists. Action `bypass`. (The app
   still checks the bearer.)
2. **Managed rulesets:** enable **Bot Protection** (challenge non-browser
   automation; verified bots and unfurlers stay allowed) and **AI Bots**
   (deny or log, owner's choice). Keep `/api/presale/receipts/`, `/card/`
   and `/api/og` reachable for unfurlers: if Bot Protection challenges them, add a
   `bypass` rule for `GET` on those paths above it.
3. **Block exploit probes:** path in `/wp-admin`, `/wp-login.php`, `/.env`,
   `/.git/config`, `/phpmyadmin`, `/xmlrpc.php`, `/server-status` (or regex
   `\.(php|asp|aspx|jsp|cgi)$`). Action `deny`, duration 1h.
4. **Challenge sponsorship requests:** method `POST` and path starts with
   `/api/presale/sponsor`. Use the `challenge` action. The app's buckets still apply.
5. **Rate limits per path family** (per IP, fixed 60 s window unless noted;
   start in `log`, then `rate_limit` 429):

   | Rule | Condition | Limit |
   | --- | --- | --- |
   | API global ceiling | path starts with `/api/` | 1,200 / 60 s |
   | Quote | path `/api/social/trades/quote` | 60 / 60 s |
   | Search | path `/api/social/search` or `/api/launchpad/search` | 120 / 60 s |
   | Discovery | path `/api/launchpad/discovery` | 240 / 60 s |
   | Gate refresh | path `/api/gate` | 30 / 600 s |
   | Sponsor | path starts with `/api/presale/sponsor` | 60 / 600 s |
   | Coin pages (SSR) | path starts with `/coin/` | 300 / 60 s |
   | Profiles (SSR) | path starts with `/@` or `/crew/` | 300 / 60 s |
   | Posts (SSR) | path starts with `/p/` | 300 / 60 s |
   | Presale pages (SSR) | path starts with `/presale` | 300 / 60 s |
   | All pages | path does not start with `/api/` or `/_next/` | 1,200 / 60 s |
   | Receipt images | path starts with `/api/presale/receipts/` | 120 / 60 s (unfurlers share IPs; keep generous) |
   | Card images | path starts with `/card/` | 600 / 60 s (the page and its image; unfurlers share IPs; keep generous, action `rate_limit`, never `challenge`, which an unfurler cannot pass) |
   | Agent API keys | path starts with `/api/presale/allowlists` AND header `x-blast-api-key` exists | 300 / 60 s |

   The app's own buckets are the precise limits; the Firewall rules are
   ceilings that stop floods at the edge for free. For a mobile carrier or
   office NAT behind one IP, prefer `challenge` over `deny` as the exceeded
   action on page rules.
6. **Attack Mode** is the emergency switch for an active attack (the owner
   enables it from the dashboard or `vercel firewall attack-mode enable`).

## Tests

- `apps/web/src/lib/web-security/api-gate.test.ts`: token issue, verify, expiry,
  skew, tamper, rotation; cookie attributes; every allowlist entry (and its
  negatives); the 401 shape; page issuance and the 30-minute refresh; the
  proxy end to end (refusal before routing, cookie on document and RSC
  requests, the page's cookie opening the API); `/api/gate`; the memory
  limiter and route-limit refusals.
- `apps/web/src/lib/api-gate-client.test.ts`: the retry path (one shared refresh, one
  retry, no loops), `omit` upgrades, pass-through, install idempotence,
  `callSocialApi`.
- `packages/server/src/modules/read-routing/cache-policy.test.ts`: the gate cookie keeps
  discovery public; any other cookie keeps it private.
- `apps/web/src/modules/presale/sponsor/sponsor-route.test.ts`,
  `execute-route.test.ts`, `trade.test.ts`, `bridge-withdraw.test.ts`: the
  sponsor's budgets count only after the dry run (or the signature check),
  for the HTTP route and the in-process callers alike; the third wrong
  signature expires a reservation.
- `packages/core/src/modules/presale/route-kit/route-kit.test.ts`,
  `apps/web/src/modules/presale/api-keys/api-keys.test.ts`: API key lookups count
  per IP before the read; misses are remembered, hits and revocations never.
- `apps/web/src/modules/mission-control/card-images/card-images.test.ts`: only the
  canonical card image URL is served, everything else is redirected to it.
- `apps/web/src/lib/web-security/web-security.test.ts`,
  `social/route-kit/route-kit.test.ts`, `presale/bridge/bridge.test.ts`:
  the per-IP wallet budget, failed sessions, the open
  registration cap, bounded bodies, the limiter's eviction.
- `apps/web/src/lib/web-security/web-security.test.ts`: the registry (version 29),
  the platform-wide subject, configurable caps, IPv6 /64 grouping.
- `packages/core/src/lib/launch-flags.test.ts`: environment parsing, the legacy
  `team` value, worker enablement, and shared response cache policy.
- `apps/web/src/app/sign-in/page.test.tsx`, `apps/web/src/app/launchpad-links.test.tsx`:
  product sign-in and launchpad visibility.
- `apps/web/src/proxy.test.ts`, `apps/web/src/proxy-social.test.ts`: API calls carry a cookie
  minted by `gateCookieHeader` (`apps/web/src/lib/web-security/api-gate-fixtures.ts`,
  the harness helper; `withGateCookie` adds one to any `Request`).
