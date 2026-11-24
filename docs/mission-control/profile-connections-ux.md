# Followers and Following continuity

The Followers and Following routes share a persistent layout. Selecting either tab immediately updates the selected segment and heading, keeps the search field mounted, clears that tab's search, and replaces only the list contents. Cold route loads use the same connections shell instead of the unrelated profile skeleton.

Rows reserve avatar, name, callsign, relationship and action space. Unknown counts display an em dash; the list uses three placeholders until counts arrive, then reserves at most one API page (20 rows). A known zero count reserves the empty-state typography without inventing a person row. Cached results return immediately while revalidating. A new search shows loading feedback instead of labeling the previous search's rows as new results. Initial errors, background errors with cached rows, and confirmed empty results have distinct states and retry controls.

Profile-count links prefetch their route and first unfiltered list page on hover or keyboard focus. Tab links prefetch the adjacent route and first page; repeated intents reuse TanStack Query's existing cache/in-flight request. Keys include the viewed profile, viewer scope, tab and search. Private-owner reads stay viewer scoped, sign-out changes scope, and a revalidation `not_found` hides cached rows and counts.

Every control for an account shares a pending write in the viewer store. Pending actions keep their width, retain keyboard focus, announce success, and prevent duplicate writes. A successful account write cancels old list requests and awaits exact count/list reconciliation before settling; counts use the server's privacy-filtered result rather than a guessed delta. Incoming “Follows you” uses its own relationship read.

Unfollowing from your own Following list retains that person at the same index with “No longer following” and Undo. Undo performs the real follow request; failures preserve the confirmed state and offer Retry. The retained-row state is scoped to profile, viewer and tab visit, and clears when leaving or refreshing the tab. The retained person does not contribute to the server count. Search filters retained rows too.

## Verification

Run `npm test --workspace @blast/web` for the
[loading](../../apps/web/src/components/social/profile/ConnectionsLoading.test.tsx),
[routing](../../apps/web/src/components/social/profile/ConnectionsRoute.test.tsx),
and [list and action](../../apps/web/src/components/social/profile/ConnectionsView.test.tsx)
regressions. The [connections integration test](../../packages/server/src/modules/social/profiles/connections-scale.integration.test.ts)
covers database behavior with synthetic records on disposable PostgreSQL.

For browser verification, visit both tabs with synthetic users on a local app.
Check keyboard focus, search and tab changes, loading and empty states, and
the unfollow and Undo flow. Repeat at a narrow and wide viewport in both themes.
