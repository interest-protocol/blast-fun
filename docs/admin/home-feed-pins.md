# Shared featured presale pins

The password-protected `admin-acl` console has a **Home feed pins** section.
Browse eligible presales (100 per page), or look up a full presale object ID,
then choose **Pin to top** or **Unpin**. Only pending sales and open sales whose
end time has not passed are available to pin. Ended, funded, migrated and
cancelled sales are omitted, including exact-ID lookups. The same eligibility
check runs when saving a pin, so a sale that ends after the list loads cannot
be newly pinned. Home and the Presales **Featured** carousel
share this single selection; there is no separate list to maintain. The complete
presales list and its sort choices keep their existing order.

The homepage **Presales** table lists eligible saved pins first, marked **Featured
by Blast**, then other eligible fastest-filling and upcoming sales. Already-open
tables remove expired rows on the next one-second clock tick, even when the
cached pin and fastest-filling lists still contain them. The server filters the
same lists before reading the first page's coin rows.

The **Today on Blast** carousel also uses these saved pins, newest pin first
(up to eight eligible sales). It disappears when no eligible pin remains. Its **Pin**
button only keeps that carousel visible while scrolling on the current device;
it never selects or removes a presale. The carousel polls while visible, so
changes may take about 30 seconds plus replica lag to reach an open page.

The Presales **Featured** carousel resolves the same pins through the ordinary
public presale summaries, newest pin first. Live and Upcoming show up to five
eligible pins for the selected tab; expired or ended sales are omitted. Calendar,
Ended, Watchlist and following views hide it. With no eligible pins it disappears
without an automatic replacement. While the carousel is enabled, it refreshes
every 30 seconds, plus public-cache and replica lag.

Each pinned sale contributes its latest public feed post. Pins appear first,
newest pin first; ordinary posts keep recency plus the configured active-why and
big-commit/trade boosts (each 30 minutes by default). A pinned post carries
`pinned: true` and displays **Pinned by Blast**. The selected post is excluded
from ordinary pagination so it appears once. Older posts of the same sale keep
their normal rank. Pinning an already pinned sale does not change its position.

Pins persist in `social_presale_pins` until removed. Eligible pins override the ordinary
post-age window, but never sale eligibility, the naming/privacy rule, hidden-trading
flag, or excluded/incomplete sale filter. A sale with no public feed post waits
until one exists. If the latest post stops being public, the next visible post
is used. Public feed caches can take about 30 seconds plus replica lag to update;
expired pins on already open feeds disappear on the next 30-second clock tick.

## Configuration and rollout

1. Apply migration `0111_social_presale_pins` with the migration-owner login.
   The web role can read/insert/delete pins; the replica can only read them.
2. Set a random, server-only `PRESALE_ADMIN_TOKEN` of at least 32 characters on
   both web and admin deployments. Store it as a sensitive variable. Never
   prefix it with `NEXT_PUBLIC_` or `VITE_`.
3. Set `BLAST_WEB_ORIGIN` to the web app's HTTPS origin on the admin deployment.
   Keep the existing sensitive `ADMIN_PASSWORD` there. Rotating that password
   invalidates existing console sessions.
4. Deploy the web API/feed changes, then the admin console.

`GET/POST /api/admin/presales` accepts only the exact private bearer, checked
by the backend transport before admission and any database access. Responses are `no-store`; no CORS access is
provided. Unknown or ineligible sales cannot be pinned and request fields are
validated. Unpinning remains allowed after a sale ends or stops being visible.

The console's `/api/presales` verifies its HttpOnly session cookie independently
of routing middleware and accepts writes only from its own origin. It forwards
the bearer on the server, refuses upstream redirects and returns no upstream
headers or credentials. No browser-held API token, wallet signature or on-chain
administration capability is needed. The password gate runs on Vercel; Vite
local development does not run it.

Saved pins automatically stop appearing in Home’s featured gallery and lose their pinned feed placement when the sale ends or becomes funded, migrated, or cancelled. Pins stay stored for audit/unpin operations. An open gallery removes expired cards on its next one-second clock tick; cached feed pins disappear on the feed’s next 30-second clock tick. Ordinary activity posts remain eligible for normal feed ranking.

## Reward blacklist administration

The [per-coin reward blacklist API](../../packages/server/src/modules/social/rewards/blacklist-route.ts)
uses the same private `PRESALE_ADMIN_TOKEN` bearer as pinning. Only operators
holding that key can list or replace the manual exclusions. Coin-owner and user
sessions do not grant access. Keep the key on the console's server or another
trusted operator client; it must never reach the browser. The console's
**Reward blacklist** page searches coins (including migrated presales), adds and
removes manual wallets, and shows automatic team recipients as read-only.
Its own API checks the password session and write origin before attaching the
bearer on the server. Failed saves require a refresh; concurrent edits cannot
silently replace each other. Apply migration `0121_reward_blacklists` and deploy
the web APIs before using [the companion console change](https://github.com/interest-protocol/admin-acl/pull/10).
