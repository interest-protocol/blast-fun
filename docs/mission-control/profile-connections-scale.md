# Followers and Following query verification

`GET /api/social/profiles/{callsign}/connections` returns only the visible
`followers` and `following` counts. Adding `tab=followers` or `tab=following`
returns only `accounts` and `next_cursor`. Pages default to 20 people and are
limited to 50. Search and subsequent pages reuse the separate client counts
query; follow, unfollow, profile and privacy changes invalidate both queries.

Both reads use the primary and return `private, no-store`. A private profile is
owner-only. Private follower identities are never named or counted, including
for the recipient. Owners can see private accounts they follow; other viewers
see only public accounts. Every page checks privacy in its own statement. The
counts read resolves the callsign, then binds its account ID so PostgreSQL can
use statistics for a popular account. Its count statement rechecks profile
privacy, including if privacy changed after that lookup.

The client scopes both caches to the viewer and waits for signed-in identity
resolution. Visitors send `x-blast-public-view: 1`, requesting public visibility
even if the browser also sends a wallet session cookie for the API gate. This
header can only reduce access. Sign-out removes the viewer queries.

Migration `0114_social_connection_pages` adds two account-only B-tree indexes:

- Followers: `(target_id, created_at DESC, follower_account_id DESC)`.
- Following: `(follower_account_id, created_at DESC, (target_id::uuid) DESC)`.

The cursor retains the microsecond timestamp and account UUID. The query orders
and seeks on those same follow columns. Each page reads only its selected
direction, without materializing both lists or recalculating counts. The
callsign lookup is scalar, preserving primary-key account reads without
propagating inflated estimates from the callsign view's union branches.

## Reproduce

Run the following under the shared VPS memory guard, with at least 2 GiB of
expected command headroom above the required 4 GiB reserve:

```bash
bash scripts/with-disposable-postgres.sh node --no-warnings \
  --import ./scripts/test-tsx-hooks.mjs --test --test-concurrency=1 \
  --experimental-strip-types \
  apps/web/src/modules/social/profiles/connections-scale.integration.test.ts
```

The fixture contains 100,001 accounts, 200,000 account follow relationships and
one presale follow. Ten percent of the 100,000 connected accounts are private.
Reads and `EXPLAIN (ANALYZE, BUFFERS)` run as `blast_web`, with one connection and
five samples per scenario. Set `CONNECTION_SCALE_REPORT` to a JSON output path
to retain full plans and timings. The disposable database is removed on exit.

Assertions cover first pages, cursors after 90,000 relationships, timestamp
ties, terminal pages, search, owner/public visibility, privacy changes between
pages and during count lookup, and index rollback/reapplication. Page plans must
use the matching index, examine at most 100 relationships for these 50-person
unfiltered pages, and avoid scanning all accounts or sorting the follow list.

## Results

Verified on 2026-10-14 with disposable PostgreSQL 18, default planner settings,
the real `blast_web` role and the fixture described above. These are database
execution times from five samples; planning, HTTP, authentication and network
latency are excluded. Exact count timings exclude the preceding callsign lookup.

| Scenario | Median execution | Maximum execution |
| --- | ---: | ---: |
| Exact public counts | 240.96 ms | 265.52 ms |
| Followers, first 50 | 1.45 ms | 1.57 ms |
| Followers, after 90,000 relationships | 1.74 ms | 1.95 ms |
| Following, first 50 | 1.60 ms | 1.86 ms |
| Following, after 90,000 relationships | 1.65 ms | 1.79 ms |
| Owner search for a private account | 566.30 ms | 615.20 ms |
| Search with no match | 495.55 ms | 534.48 ms |
| Followers, first 50 without page indexes | 1102.25 ms | 1214.29 ms |

All four unfiltered page plans used the matching ordered index, read 57 follow
relationships for 51 candidate people, and avoided full-account scans and
sorting the follow list. Both the privacy regression suite and the large-list
test passed, including a privacy change between the count lookup and its final
statement. Migration rollback and reapplication preserved the results.

## Deployment limits

Before merging the query changes, run `npm run db:migrate` against the release
database, repeat it to confirm the database is already current, and verify that
both page indexes are valid and ready. Record the target and result in the PR.

Release migration verified on 2026-10-14 at 02:25 UTC against database `neondb`
on the direct primary `ep-aged-pond-awk6wpn9.c-12.us-east-1.aws.neon.tech`, using
the migration login and checking it against the `blast_app` runtime endpoint.
The first `npm run db:migrate` applied only `0114_social_connection_pages`; the
second reported `Mission Control database is already current.` Both
`social_follows_followers_page_idx` and `social_follows_following_page_idx` were
valid and ready. The recorded migration checksum is
`90981cea166b122b324627889b1316e5a5cb8a5b2bac02e1b52cc1f7f9454877`.

The migration runner uses transactions, so `CREATE INDEX` takes a SHARE lock and
blocks follow writes until the migration commits. Rehearse its duration on the
intended database size.

Exact counts remain proportional to the relevant relationships. Sparse search
can inspect the entire selected list. This fixture measures local PostgreSQL
execution, not concurrent production HTTP capacity or network latency. Redis is
deferred.
