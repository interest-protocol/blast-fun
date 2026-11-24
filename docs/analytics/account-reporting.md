# Private account reporting source — disabled

The account reporting code adds a version 3 snapshot and an authenticated
`GET /v3/summary`. Collection, reporting and the consumer choice are off by default.

Version 2 remains strict: its account values are null. The existing singleton
`snapshots`, publisher, `/v1/summary` and selected dashboard reader/rendering
continue to use version 2. The sole authored `contract.ts` adds explicit v3
exports. Dashboard preparation copies that same pure file into its server-only
generated directory; no second authored schema or public contract asset exists.

## Meaning and clocks

`accountActivity` is null before `account_collection.started_at` is set. An
existing empty singleton alone does not establish collection. Once collection
has started, zero means measured zero within that collected interval. The
report refuses a different private collection scope and a future collection
start. It exposes no hashes, key digests, wallet/account IDs or scope digest.

The unit is distinct **collected, authenticated existing accounts**, not humans,
registrations or all product accounts. A new account UUID after recreation is a
new collected identity; historical deletion/merge treatment remains an activation
decision. Successful collection may be suppressed for up to 15 minutes, so
activity close to a window boundary may be undercounted. The field
`samplingIntervalMs` records that limit; it promises no heartbeat.

Each publication gets one millisecond observation timestamp `T` from the
warehouse, independently of chain checkpoint time. Rolling counts use
`last_seen > T - 24 hours` or `last_seen > T - 720 hours`, and `last_seen <= T`.
The fixed 720 hours avoids session-timezone DST changes. Future first-seen rows
do not enter the collected total. Rows preceding collection start are excluded.
All counts and millisecond timestamps remain exact decimal integer strings.

Daily counts deduplicate the existing `(account_hash, day)` rows. They zero-fill
only collected UTC dates, up to the latest 30 dates including the current
incomplete date. Dates before collection or after `T` are omitted. A row whose
account has a future `last_seen` is conservatively omitted from daily counts,
even for a prior date. This prevents future data from inflating the report; daily
rows cannot recover within-day observation order. `partial30d` stays true until
collection covers 720 hours. The first collection date and the current date can
still be partial UTC days.

`accountObservationTimestampMs` is separate from chain `asOfTimestampMs` and
`chainPublicationTimestampMs`, the latter preserving the original v2 publication
clock. The v3 API and opt-in consumer label `chainStale` and `accountStale`
independently. A source/publication clock in the future or more than one hour
old is stale. A fresh account publication cannot refresh the chain's clock.

## Forward upgrade and role scope

The applied bootstrap and migration 0001 are unchanged. On an authorized,
disposable loopback warehouse only, migration
`0002_account_reporting.sql` requires the exact ledger `(0, warehouse-v1)` and
`(1, account-activity-v1)`. It preserves old rows, creates `snapshots_v3` and
records version 2 of the warehouse migration ledger. It rejects a rerun or
another ledger; check the ledger instead of replaying it.

The existing publication capability gets SELECT on account collection/accounts/
days and SELECT/INSERT/UPDATE on the new snapshot. Queries return aggregates
only, never individual hashes. The API reader gets SELECT on the aggregate
snapshot only. Ingress keeps its existing function-only write capability; it
gets no reporting/table read. No PUBLIC access, SECURITY DEFINER or new runtime
role is introduced by 0002. A restricted non-superuser operator can apply it.

The publication owns a repeatable-read transaction with a 2-second statement
timeout and 250-ms lock timeout, using the existing single-connection warehouse
pool. The query emits at most 30 daily rows plus aggregate counts. A failed
publication rolls back and preserves the last good v3 and v2 rows. The reader
retains the existing bounded pool/ten-waiter limit.

## Explicit opt-in, still disabled

`ANALYTICS_ACCOUNT_REPORTING_ENABLED=true` is needed independently on the manual
refresh and private API processes. The publisher also requires
`ANALYTICS_ACCOUNT_REPORTING_SCOPE`, the pinned 64-character lowercase hexadecimal
collection scope. This is private operator configuration; the publisher does
not need the account HMAC key. Existing analytics source/warehouse configuration
is unchanged. Reporting runs after the existing collector pass even when no
new chain head is published. No new scheduler is added.

With the flag absent/false, refresh does not query the new tables and the API
does not install a v3 loader. An unupgraded warehouse still serves v2. Enabling
v3 against missing/revoked v3 storage yields a v3 failure; v2 storage and reads
remain independent. Logs and responses do not expose database errors or URLs.

The standalone server keeps `createSummaryReader` and the v2 UI. The isolated
`createAccountSummaryReader` returns null unless passed `{ enabled: true }`.
It then uses only the fixed `/v3/summary` endpoint, server-side bearer token,
strict generated schema, one concurrent request, one-million-byte streamed
limit and a whole-request deadline of at most three seconds. A last good report
can be returned with explicit delivery degradation for less than 24 hours; then
delivery failure is unavailable. This helper is not wired to a browser route.

Before real collection or reporting is enabled, the owner must settle retention,
erasure and merge treatment, keys/roles, controlled collection and the latency
canary. Keep every flag disabled until that separate approval.
