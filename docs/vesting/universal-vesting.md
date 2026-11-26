# Universal vesting

Blast can create a fully funded vesting for any Sui coin without a presale,
listing, or price feed. It supports continuous Linear vesting and 1–256 dated Checkpoint releases,
irrevocable or cancelable. There is one fixed
beneficiary. A transferable CancelCap, rather than creation attribution,
authorizes cancellation; the refund recipient is fixed at creation.

Every schedule is addressed publicly at `/vesting/<full Sui object ID>`.
The detail page and API require no Blast account or wallet. The existing
release flag and site-wide API bot gate still apply. Existing shell, cards,
CoinMark, CopyButton, menus, sheets, wallet bridges, and feedback are reused.
Portfolio’s Vestings tab contains View all vestings and Create vesting actions,
including while signed out or while holdings load. Presale vesting rows point to
their public schedules and have Copy link controls. Main navigation and the global
Create menu remain unchanged.

## Contract and data

The original/current mainnet package is
`0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c`,
published at checkpoint **326313160**. Both `blast_fun_linear_vesting` and
`blast_fun_checkpoint_vesting` are indexed independently of presales by the
new blast-infra `vesting` consumer. The existing presale projection remains
compatible. No contract migration is required.

Infra owns `utility_vesting_schedules` and `utility_vesting_events` and exposes
read-only `chain_read_v1` views. Lifecycle rows and the consumer watermark
commit atomically. Cancellation and close retain the schedule and history
after deletion of the Move object. Exact amounts and timing terms use u64
storage or decimal strings, with bigint arithmetic in the UI. Terminal custom
schedules created and removed within one transaction can lack an observable
object: the history records that dates are unavailable, rather than inventing
terms. Active custom schedules without a canonical object halt indexing.
Utility coin types also enter the existing metadata hydration queue.

Public reads can use a live object before its indexed creation arrives.
Unknown metadata displays explicit atomic units. A missing deleted object
without indexed history is temporarily unavailable, not a fabricated 404.
Activity shows up to 100 recent events, bounded to the schedule projection’s
applied checkpoint. The complete ledger remains in the indexer database.

## Transactions

Privy embedded wallets use Blast-sponsored gas for creation, claim, cancellation
and closure. External wallet sessions pay their own SUI gas. The authenticated
server builds and authorizes each utility action before requesting the internal
`vesting` sponsor intent; the public sponsor endpoint does not accept that intent.
The existing service verifies the embedded wallet, deployment, simulation, gas
cap and shared budgets. There is no automatic fallback to wallet-paid gas.
Preparation durably binds full bytes, digest, sender, intent, gas budget, expiry
and the optional sponsor reservation to the authenticated account before signing.
SUI principal comes from the sender using the SDK's composable calls with
`useGasCoin: false` for sponsorship; sponsor funds pay gas only.
The review shows recipients, terms, coin type, gas budget and who pays. Privy and
outside-wallet (Slush and the others, since 2026-11-20) approvals are submitted
through the existing sponsor execute endpoint for co-signing; a wallet submits
directly only when the review says it pays. Migration `0120_vesting_sponsorship` is required
before deploying this flow. Expired reviews and changed gas payers require a fresh
review; a sponsor outage preserves the draft and never asks to add wallet gas.
The server verifies
actual chain execution against that exact digest and expected vesting event.
Retries check the original digest before asking to sign again. The overview
also reconciles pending attempts after a lost client response. A review can
expire without the user signing; a submitted log entry alone is not chain
execution evidence.

Claim actions in Blast are offered to the fixed beneficiary only. The
contract itself allows permissionless claims paid to that same beneficiary.
Cancellation checks the live capability's owner, type and linked schedule.
Amounts can advance at a release boundary before execution; the contract
computes both cancellation payouts at execution time.

## Release order

The current private rollout defers historical backfill until the production
database rebuild. For this stage, apply the infra schema, keep
`BLAST_VESTING_ENABLED` disabled, apply web migration `0118_utility_vesting`,
then deploy the app with existing team access settings. Active schedule links
can resolve live objects; historical wallet discovery and deleted-object history
require the later indexer replay. No database reset is part of this stage.

For the production rebuild and complete historical coverage, follow this sequence:

1. Apply blast-infra migration `2026-11-08-000000_universal_vesting` through the
   normal migration login. It adds tables, views and reader grants.
2. Ensure the native journal contains every checkpoint from **326313160**
   through the current intake watermark. Enable `BLAST_VESTING_ENABLED=true`
   on mainnet. Startup refuses missing native coverage. An old journal that
   starts later needs the infra runbook's maintenance-window full replay in
   the canonical shared database. It resets all chain projections and native
   history while retaining web tables; chain reads are stale/unavailable during
   recovery. Keep the web app on its current release until replay completes.
   Do not replace the shared database or reset only consumer watermarks to
   disguise missing history. See blast-infra's `docs/utility-vesting.md` for
   preflight SQL, replay conditions and completion checks.
3. Wait for `chain_read_v1.projection_coverage` for `vesting` to catch up,
   with no projection fault. Monitor `blast_pipeline_lag_seconds` and
   `blast_pipeline_lag_checkpoints` for `pipeline="vesting"`.
4. Apply web migration `0118_utility_vesting` using the migration login.
   It adds immutable transaction attempts and four social transaction kinds.
5. Deploy the web code. Public schedule links open for signed-out visitors.
   Social availability and configured wallet authentication enable actions.
6. Verify a non-presale coin, both schedule kinds, capability transfer,
   cancellation/close history, and a signed-out shared link on the deployed
   environment before announcing availability.

Implementation and rehearsal did not modify a production database, indexer
flag, wallet funds, or deployment.

### Web migration command and rollback

After the infra schema exists, run from this app checkout using the release
database's primary endpoints and distinct migration/runtime logins. A rollout
requiring complete history also waits for infra coverage as described above:

```sh
DATABASE_MIGRATION_URL='<direct migration endpoint>' \
DATABASE_URL='<pooled runtime endpoint>' npm run db:migrate
```

Run the same command twice: the first applies pending migrations including
`0118_utility_vesting`; the second must report that the database is already
current. Confirm the migration ledger:

```sql
SELECT name FROM public.mission_control_schema_migrations
WHERE name = '0118_utility_vesting';
```

Vercel builds do not apply database migrations. Retain both migrations and the
attempt/history ledgers if reverting application code; do not drop public
history or reviewed transaction attempts during an application rollback. The
infra runbook describes the larger chain-replay maintenance and rollback scope.

## Verification

The migration rehearsal uses a task-owned disposable PostgreSQL database,
with all framework/infra migrations followed by all web migrations. Repeating
web migration applies zero changes. The database integration test protects
immutable review facts and one-time attachment of the public schedule ID.
Focused model tests cover step/cliff boundaries, cumulative checkpoints,
terminal payouts, u64 precision, amount parsing and canonical public paths.
Infra tests cover canonical custom terms, malformed/unknown events,
terminal history, replay/restart and rollback of an invalid lifecycle.

Browser fixtures are explicitly synthetic and are not bundled or reachable
through a production demo route. Screenshots live in the workspace's
`outputs/ui/2026-10-17-universal-vesting/implemented/` artifact folder. See its
README for the final check results and any limits. Funded mainnet signing
requires a wallet and was not performed by the agent.

PR preparation repeated the rehearsal on the disposable local PostgreSQL target
`127.0.0.1:5433/codex_universal_vesting_20261017`: framework/infra SQL followed
by all 97 web migrations applied successfully, with zero changes on rerun.
`npm run db:migrate` was then run twice against that target; both reported
`Mission Control database is already current.` Migration `0118_utility_vesting`
was present in the public migration ledger. React Doctor passed at 100/100
with no findings before publication. The disposable database was dropped.

## Creation interface

Creation uses the shared Swap `TokenPicker`, responsive `Sheet`, Settings
`Switch`, coin identity, neutral segmented controls and Blast button variants.
Vesting selection bypasses swap eligibility: metadata absence uses explicit
atomic units, while RPC failures remain retryable errors. Full Move types retain
case during resolution. Wallet balances are paginated and resolved with bounded
RPC concurrency.

Amount shortcuts (25%, 50%, 75%, Max) use integer atoms and the existing native
SUI fee reserve. “Use my wallet” fills the authenticated Blast wallet. Linear
and Checkpoint drafts survive mode changes. Preview and preparation use the same
SDK-validated schedule builder; review freezes the intent, coin metadata
and prepared gas budget before signing.

If the vesting projection is not ready, the wallet-list route returns HTTP 503
with `vesting_index_unavailable`. The overview explains that indexed history
is unavailable and keeps public-link access; it does not render an empty wallet.
This distinction requires no migration, index flag change or historical replay.
Creation refinement screenshots and verification details are recorded in the
workspace artifact folder `outputs/ui/2026-10-17-vesting-creation-refinements/`.

### Continuous Linear and Checkpoint schedules

Linear creation takes a start and end date. The existing published linear
contract is configured with `period_ms = 1` and `periods = end_ms - start_ms`.
At Sui Clock's millisecond precision this computes exactly
`floor(total_atoms * elapsed_ms / duration_ms)`, with all atoms vested at the
end. Claims and cancellation use the same SDK projection and contract formula.
An optional cliff gates claims until its end, then releases the amount accrued
since the original start; it does not restart or extend the schedule.
The graph is a straight slope, with a jump at an optional cliff. Token atomic
precision still applies, including small allocations whose first atom vests
later than the first millisecond.

Checkpoint creation retains dated, editable release amounts and can generate
regular daily, weekly or 30-day tranches. These use the checkpoint contract,
with horizontal plateaus and vertical jumps on the graph. Integer remainders
are allocated exactly and no tokens vest between checkpoints. Generated
intervals represent elapsed 24-hour days; stored zoned dates retain the exact
instant through daylight-saving changes.

Historical linear-module schedules with periods longer than 1 ms remain
unchanged and display as **Stepped vesting**, using their original SDK payout
formula and stepped graph. This UI change requires no package deployment,
SDK upgrade, indexer change or additional database migration. Existing Privy
gas sponsorship continues to apply to both creation modes and lifecycle actions.
