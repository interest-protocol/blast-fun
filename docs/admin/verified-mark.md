# Known deployer badge

The pink helmet says Blast checked who is behind a coin. It is set only when
Jose says so, from the password-protected `admin-acl` console's **Known deployer**
page. The operator CLI keeps
`coin trust list|history` and `sale trust list|history`, and `sale trust` sets
only `--audited`.

The page lists every marked bonding-curve coin and presale with its name,
symbol, who set it, when and the reason. To mark or clear one, choose the kind
(curve coin type or presale ID), paste the full target and write a reason that
names who asked (for example "Jose: video call with the team"). Each row also has
**Clear** and **History**.

- A curve coin is keyed by its coin type (`social_coin_trust`; the row is the
  mark). Only a Blast bonding-curve coin can be marked; a presale's coin is
  marked through its presale.
- A presale sets `social_sale_trust.verified_team`; its `audited` flag is
  untouched.
- Every change, including a clear and a repeat, appends one
  `social_operator_log` row in the same transaction, with operator
  `admin-console` and the reason. That log is append-only for every role.

`GET/POST /api/admin/verified-mark` uses the same private `PRESALE_ADMIN_TOKEN`
bearer as [home feed pins](home-feed-pins.md), checked by the backend before any
database access. `GET` lists the marks (200 of each, newest first); `GET
?kind=coin|presale&target=…` returns that target's last 50 changes; `POST
{kind, target, verified, reason}` sets or clears. Responses are `no-store`. The
reason is 1 to 500 characters with no line breaks.

Migration `0165_admin_verified_mark` lets the web role append log rows, insert
and delete `social_coin_trust` rows, and insert or update only the verified
columns of `social_sale_trust` (never `audited`, never a delete). It changes no
row.

A change shows on coin pages and lists within about 10 seconds (the discovery
cache) plus public-cache and replica lag.
