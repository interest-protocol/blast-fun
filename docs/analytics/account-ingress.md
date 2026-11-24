# Account activity ingress — disabled source bundle

The private relay exposes an opt-in, body-free `POST /api/analytics/activity`.
The gateway authenticates transport and the module separately verifies the
user. Version 2 summaries keep account metrics null.

## Identity and privacy

The product database's `public.analytics_account_id(subject, token_hash)` resolves
an existing `social_accounts.account_id`. The subject comes only from local
Privy ES256 verification (`privy.io`, configured app audience, expiry). SQL does
not authenticate a DID. A supplied invalid Authorization header never falls back
to a wallet cookie. Cookie parsing rejects duplicate or malformed wallet tokens.
The resolver checks session revocation, absolute expiry and seven-day idle expiry
against database time. It never creates an account or touches session activity.

Privy member identities take precedence over a direct DID account. An unresolved
member returns no identity. Wallet ownership follows the existing direct,
linked, member and embedded evidence; embedded ownership prefers the direct DID
account over the member account. Repeated evidence for one account is allowed;
multiple distinct accounts or unresolved member profile claimants are refused.
Linking a wallet to the same account does not create another collected identity.
Unlinking, deleting an account or ending a session prevents new recording once
fresh resolution fails. Deleting and recreating an account with another UUID
produces a different collected identity.

Only an HMAC-SHA256 of `blast-account-v1:<account UUID>` reaches the separate
warehouse. Its collection scope pins the hash domain, a digest of the key and
the identity policy. A different scope fails closed and requires an explicit
reconciliation or rebuild. The warehouse has no product IDs, DIDs, emails,
wallet addresses, session tokens, page URLs or client-chosen timestamps.
Observation timestamps come from PostgreSQL; last-seen time cannot move back,
and an account has at most one row per UTC day. Collection start remains null
until the first accepted activity.

The identity login inherits only `blast_analytics_identity`, which can execute
one read-only function. Its separate NOLOGIN function owner can select only the
needed identity columns. The warehouse login inherits only
`blast_analytics_ingress`, which can execute `record_activity(hash, scope)`.
It cannot list hashes or read snapshots/access codes, redeem codes, write chain
facts or choose observation times. Both functions revoke PUBLIC execution and
use a fixed `pg_catalog, pg_temp` search path with qualified application tables.
The migration operator retains explicit SET permission on the function-owner role
without inheriting it. Runtime logins cannot SET that role. This supports the
non-superuser operator used by production migrations and later maintenance.

## Opt-in configuration

`ANALYTICS_ACCOUNT_ACTIVITY_ENABLED=true` is required. Any other value disables
the module before reading other configuration, constructing pools or verifying
credentials. Enabled invalid configuration or database failures return an empty
503 with `Retry-After: 30`; refusal and success responses contain no identifiers.
Logs use fixed categorical metrics without driver errors or request values.

| Variable                          | Purpose                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `ANALYTICS_ACCOUNT_SITE_ORIGIN`   | Exact HTTPS origin (HTTP only on loopback), without credentials, path, query or fragment. |
| `ANALYTICS_IDENTITY_DATABASE_URL` | Independent product identity LOGIN, direct endpoint.                                      |
| `ANALYTICS_INGRESS_DATABASE_URL`  | Independent warehouse ingress LOGIN, direct endpoint.                                     |
| `ANALYTICS_ACCOUNT_HASH_KEY`      | Private key of at least 32 characters; never reuse the wallet hash key.                   |
| `PRIVY_APP_ID`                    | Audience for locally verified access tokens.                                              |
| `PRIVY_JWT_VERIFICATION_KEY`      | P-256 public verification key; no Privy secret or provider call.                          |

Database URLs require explicit host/user/database. Remote effective hosts require
`sslmode=verify-full`; host overrides are checked, duplicate query parameters and
pooler endpoints are refused. Only `host` and `sslmode` query parameters are
accepted. Driver options and certificate-file paths are not passed through.
Each independent pool has one connection, a 1.5-second connect timeout,
2-second statement timeout, 3-second query timeout and 250-ms lock timeout.
Two requests may be in flight; additional arrivals fail retryably without an
admission queue. Product mutation pools and transactions are not used.

Requests require POST, the exact request and Origin origins, absent or
`same-origin` Sec-Fetch-Site, no query and zero body bytes. The relay/gateway
reject nonempty bodies under the zero-byte route cap and normalize an empty stream
to an absent body. The service itself also refuses an explicit body stream.
Successful writes are suppressed per hash for 15 minutes or until the next
warehouse UTC day, whichever comes first. The successful cache holds at most
10,000 hashes. Authentication and read-only identity resolution still run on
each request, so cache hits do not keep deleted or unlinked accounts recording.
The cache uses a monotonic clock and includes query latency conservatively;
failures are never cached. Independent devices still deduplicate in PostgreSQL.

## Forward migrations and local proof

Product migration `0159_analytics_identity` runs through the normal product
migrator. It adds no table or account/session write. Provisioning a dedicated
LOGIN and granting its capability is a separate authorized operator step;
credentials do not belong in source.

The applied warehouse bootstrap `warehouse.sql` is unchanged. An owner with an
existing v1 dedicated warehouse first checks whether
`blast_analytics.schema_migrations` exists. No ledger means the v1 bootstrap is
the expected starting point. On an explicitly authorized disposable loopback
warehouse only, the forward apply command is:

```sh
psql -X --no-password --set ON_ERROR_STOP=1 "$LOCAL_ANALYTICS_WAREHOUSE_URL" \
  --file apps/workers/src/modules/analytics/migrations/0001_account_activity.sql
```

The file owns its transaction. It rejects product/chain databases, missing
bootstrap objects and an existing ledger. On success the warehouse-local ledger
contains `(0, warehouse-v1)` and `(1, account-activity-v1)`. A rerun fails without
changing data; the owner checks those exact entries and skips an already applied
upgrade. Do not edit the bootstrap, remove the ledger or replay the migration to
change a collection scope. Existing facts, snapshots and access codes survive.
This is a manual source procedure, not authorization to apply it remotely.

Focused proof uses the existing disposable PostgreSQL integration runner:

```sh
npm run test:integration -w @blast/server -- src/modules/analytics/activity.integration.test.ts
```

It applies complete product migrations, checks repeat application, creates a
separate warehouse, bootstraps then upgrades it, uses real restricted LOGINs
and local signed fixture JWTs, and cleans up all task-owned stores. No account
provider, real account, production credential or network service is used.

## Activation gates

Keep collection disabled until the owner approves retention, erasure, account
deletion/merge semantics, keys/roles and a controlled product-latency canary.
Historical hash retention is unsettled: this bundle stops new writes when an
identity disappears and makes no historical erasure promise. Do not invent a
merge map or silently rewrite cohorts. Client emission and version 3 reporting
are Bundle B, after the current auth/session work and dashboard contract settle.
