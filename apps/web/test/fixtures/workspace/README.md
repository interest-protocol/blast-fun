# Mounted workspace fixture

## Loaded shell typography (#799)

`/typography-proof` compiles the production `fonts.ts` through Next and mounts
`BlastUiRoot`, `AppShell`, `PageHeader` and `SheetHeading`.
It has no wallet or transaction provider. Only the shell's health response is
controlled by the runner; font CSS and files use the actual Next loader.

After disk and memory preflights, start the Next server from this fixture
directory, using the existing task-local public-assets symlink:

```bash
NODE_OPTIONS=--max-old-space-size=2048 NEXT_TELEMETRY_DISABLED=1 \
../../../../../node_modules/.bin/next dev --hostname 127.0.0.1 --port 42863 --webpack
```

Open one task-owned browser on `about:blank`, then run from the repo root:

```bash
agent-browser --session shell-typography open about:blank
TYPOGRAPHY_CDP_URL="$(agent-browser --session shell-typography get cdp-url | sed -n '/^[[:space:]]*ws:\/\//p')" \
TYPOGRAPHY_EVIDENCE_DIR=/absolute/task-owned/evidence \
npm run test:shell-typography -w @blast/web
agent-browser --session shell-typography close
```

Stop the owned Next server afterward. Missing environment fails the command;
these checks are explicit browser tests, never silently skipped in Node's unit
suite. The runner blocks external requests and unrelated Next Link prefetches.
It waits for `document.fonts.ready`, checks successful local font responses and
loaded variable ranges, then asks Chromium which custom faces drew the glyphs.
It records computed roles and text metrics at five widths in both themes,
including the approved bounded phone text scale. KA-5 checks the real collapse
action and readable names below icons.

OA-31/OA-32 and the OA-24/Mobile-board references stay with their replacements.
The asset/axis/root wiring and display-selector inventory remain source guards.
Numeric-figure and font-feature source contracts remain outside this check.

## Repeatable workspace layout check (#799)

The bounded `layout/` fixture mounts the real `WorkspaceHost`, header, discovery
controls, `CoinWorkspaceLayout` and shared `Pager`. Only account, asset contents
and page data are controlled slots. There is no API, wallet or send adapter.
It uses the installed Vite and browser tools; it adds no production route.

After the workspace disk and memory preflights, start its task-owned server:

```bash
node node_modules/vite/bin/vite.js --config apps/web/test/fixtures/workspace/layout/vite.config.ts
```

Use one task-owned browser and run the explicit check (missing environment is
an error, never a skipped test):

```bash
agent-browser --session workspace-layout open http://127.0.0.1:42979
agent-browser --session workspace-layout snapshot -i
LAYOUT_CDP_URL="$(agent-browser --session workspace-layout get cdp-url | sed -n '/^[[:space:]]*ws:\/\//p')" \
LAYOUT_EVIDENCE_DIR=/absolute/task-owned/evidence \
npm run test:workspace-layout -w @blast/web
agent-browser --session workspace-layout close
```

Stop the task-owned Vite process afterward. The check reuses the browser's page
at the fixture origin and blocks requests outside that origin. It checks header
overlap and hit targets at five widths in both themes, fine/coarse More controls,
pagination through the first and last page, and viewport chart expansion with
Escape restoration and retained input. JSON geometry and screenshots go into
the evidence directory. This fixture uses the system font fallback; font asset,
font loading and typography contracts remain in their own tests.

## Mobile stats and empty discovery

Run `verify-mobile-stats-discovery.mjs` with `TRADING_FIXTURE_URL` pointing to
this fixture's loopback `/trading-proof`, `TRADING_CDP_URL` pointing to the
task's existing browser, and `TRADING_EVIDENCE_DIR` pointing to task outputs.
It uses a fresh browser context and the production components with controlled
data. It checks empty discovery selection and scrolling at short desktop heights,
balanced market stats at five widths in both themes, missing/loading/private
states, and retained trade input. It never sends a transaction.

## Trading workspace proof

`/trading-proof` mounts the production shell, workspace, CoinPanel and CoinsData
with controlled wallet, quote and market adapters. Sending throws immediately;
there is no signer or live trade. Use **Seed four assets**, then **Open Blast
mode**. `window.tradingFixture.state(panelId, scenario)` controls ready, loading,
empty, unavailable, error, stale, zero, wallet-error, quote-loading, quote-error,
native-ready, native-empty, native-unavailable and native-stale states. The native
candles come from a recorded protocol fixture, not inferred observations.

The fixture needs the owning web app's public assets. Before starting it, create
a task-local symlink with `ln -s ../../../public public` from this directory;
remove only that symlink after verification. Follow the shared memory guard and
reuse one browser session. Run from the repository root:

```bash
TRADING_FIXTURE_URL=http://127.0.0.1:42874/trading-proof \
TRADING_CDP_URL=http://127.0.0.1:YOUR_BROWSER_CDP_PORT \
TRADING_EVIDENCE_DIR=/absolute/task-owned/evidence \
node apps/web/test/fixtures/workspace/verify-trading.mjs
```

The runner seeds this fixture's guest workspace, measures state geometry,
checks interactions and saves seven-width, two-theme captures. It requires a
running loopback fixture and an existing CDP browser. The
[fixture runner](verify-trading.mjs) defines the checks and capture matrix.

With the same environment and browser, run `verify-trading-focus.mjs` next to
measure Focus states, compare zero/unknown position balances, and verify complete
mobile trade actions and material-impact warnings above the bottom navigation.

This separate Next application mounts the production `AppShell`, `BlastModeHost`,
and lazy `WorkspaceHost`. It is test-only and adds no production route. Asset and
Data adapters and identity outcomes are explicitly simulated. It mounts no
transaction provider or send path and requests no market API. It does not prove
provider effects, backend authentication, account synchronization, or live data.

The root fixture's Confirmed guest identity passes the real signed-out account
state to `BlastModeHost`, exercising its production session-to-owner selection.
Pending, failed, and account identities still use controlled owner resolvers.
Guest entry, exit/re-entry, and refresh exercise the real browser journal without
calling the private account-workspace API.

From this directory, with the assigned checkout's dependencies available:

```bash
NODE_OPTIONS=--max-old-space-size=2048 ../../../../../node_modules/.bin/next dev --hostname 127.0.0.1 --port 42863 --webpack
```

`GET http://127.0.0.1:42863/` must return 200 and the browser must display the
"Test fixture" notice. The local run's exact process, cache, readiness and browser
evidence are recorded in the assigned T-002 implementation report. Follow shared
VPS memory rules before starting this server and stop owned processes afterward.

The page has Home, Presales, and Portfolio links with query/fragment examples,
visible entry, identity simulation, and a mixed-setup seed. Seeded panels A and B
use the accepted T-001 model; typing in a panel calls its real journal dispatch.
The explicit mixed-setup seed reloads this test tab after opening the session, so
it starts a new guest owner lifetime rather than replacing an in-memory draft.
Ordinary exit and re-entry retain the current tab's guest journal, including any
unsaved changes and their Retry warning; adapters still unmount on exit.
The fixture can hide every Data view, select a mobile panel, remove assets, and
display the host's effective presentation facts. Refresh tests use real browser
localStorage/sessionStorage. Adapters load lazily from `adapters.tsx`.

For read/write recovery cases, preserve the original journal bytes and inject
only task-owned browser storage. The production journal key is exported by the
accepted model; do not guess or change it. Inspect captured requests alongside
screenshots. No adapter content is a claim about production market outcomes.

## Coin renderer fixture (T-003)

`/coin` mounts the executable production `CoinPanel` through the default lazy
`BlastModeHost` panel slot. It uses the real workspace model/journal, shell,
query client, wallet/quote hooks and `TradeKit.send` boundary. Its explicitly
controlled provider returns a pending observer result; it never submits a
transaction. The separate root fixture above still has no send path.

Run this same test application on its allocated port (T-003 used 42864) and open
`http://127.0.0.1:42864/coin`. API routes under this fixture application return
real-data-shaped, canonical coin/price/holder/activity rows. They are not
production endpoints. The default Production read mode exercises existing
production read clients. The other modes inject pending/error, quote-only,
one/no observation, metadata-unavailable and recorded native-candle responses
through the published `CoinReads` contract. Native mode uses the existing
chart client with recorded localnet curve/Cetus pages and real pool provenance;
its trading kit is intentionally unsupported on localnet.

Panel A is a standalone coin; B has a presale binding. The fixture controls can
choose the mobile panel, hide Data, and change a tab's visibility. Account mode
uses a controlled account-owned store. “Use confirmed guest journal” switches
the accepted owner resolver to a confirmed signed-out result and seeds the real
guest localStorage journal; exit/re-entry and refresh then exercise that journal.
Observer send and sign-in counters are visible. This proves renderer/client
interaction and persistence, not network execution, backend auth, account sync,
live market freshness or production read availability for every standalone coin.

CoinPanel's typed contract and production readers are exported from
`src/components/social/blast-mode/workspace/panels/CoinPanel.tsx` and
`src/components/social/blast-mode/workspace/panels/coin-reads.ts`.
The exact T-003 source, commands, current browser captures, bounded temporary
cache setup and cleanup are indexed by its assigned implementation handoff.

The entry control “Resume confirmed guest journal” changes only the controlled auth result; unlike “Use confirmed guest journal”, it does not seed or overwrite saved guest bytes. Use it after a full fixture reload to verify the real guest journal restores edits.

## Presale renderer fixture (T-004)

`/presale` mounts the production default lazy Presale renderer in Production
mode. Its existing public detail and signed-in position clients read shaped
responses from this separate test application. Other modes inject controlled
pending, unavailable, delayed, lifecycle, wallet, payment route, fee payer,
refusal and send-error responses through the exported adapter contracts. The
shell owns the CommitKit and ClaimPath boundaries. All final actions count
observer calls and refuse; they do not sign, submit or reach a chain.

Use the allocated port 42864 and the same bounded runtime command above.
“Presale fixture” is inside the controlled-observer details. “Send pending”
keeps the action busy until “Resolve observer refusal” is pressed. Select SUI
and enter an amount such as `25.000000001` to inspect the existing conversion
path; route-wallet-fee makes the active offer charge SUI. Gas-change requires
review of the refreshed payer before another explicit press. Production mode
exercises default registration and existing readers; controlled modes prove
renderer behavior, not live availability or financial execution.

Guest controls use the same real journal seed/resume pattern as the Coin
fixture. Amount strings, selected payment type, tab and scroll navigation live
in the accepted Presale namespace. The fixture does not add product routes or
new lifecycle, pricing, entitlement or conversion rules.

## Mixed layout fixture (T-005)

`/layout-proof` seeds four mixed Coin/Presale panels and two retained assets,
then mounts the real typed `CoinPanel` and `PresalePanel` contracts with controlled
readers. It uses the production shell, host, model and guest journal. This layout
fixture has no transaction provider or send path. It proves geometry, presented
IDs, capacity restoration, draft/control/navigation persistence and keyboard/touch
behavior; it does not prove market freshness, financial execution or backend auth.

Run the application on the allocated port (T-005 uses 42866) and select “Seed mixed
layout”. “Resume layout” opens the existing journal without replacing it. The
collapsed evidence details expose saved setup and presentation facts. Data has
enough controlled rows to verify internal scrolling. The production toolbar
selects desktop capacity, the selected mobile asset, and Data coverage. Resize
across 1099/1100 px (the Discover sheet/column breakpoint since the Blast mode audit, pass C) without reseeding to verify desktop setup preservation.


## Tracked-panel management fixture (T-006)

`/management` reuses the mixed layout fixture with 35 complete records (four
visible and 31 retained). It mounts real Coin/Presale renderers with controlled
readers and has zero financial send paths. Add E/B/D uses the real Host dispatch;
More panels pages every retained record in groups of eight. Two retained assets
share the symbol SAME but have different canonical coin types. Exact identity
uses the shared inspection overlay. The production journal and setup probes
expose saved order, focus, drafts and Data controls. Storage-failure tests inject
only the journal storage boundary and keep the original saved bytes.

## Account synchronization fixture (T-013)

`/sync` mounts the production workspace source selection, outbox, status, shell
and viewer scope. Unlike the root renderer fixture, its `/api/social/me` and
`/api/social/me/blast-workspace` routes use the production route kit, ES256 token
verification, account repository, rate limiter, runtime database role and real
PostgreSQL workspace operations. The test-only token issuer, market adapters and
explicit financial action observer are simulated. No transaction provider is
mounted. A financial observer click proves interaction only.

The coordinator must allocate the isolated lane before use. This fixture guards
against connecting anywhere except loopback port 35275. Use PostgreSQL18.6 image
`postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873`,
a task-owned `bmw-t013` container/volume, database `mission_control_test`, max40
connections, and private mode600 environment/key files outside the repository.
The setup uses the repository's chain fixture and migrations through0122, then
creates12 accounts with no saved workspaces. It refuses an already prepared DB;
reuse a compatible fixture rather than reseeding after an orchestration failure.
No migration was added by this ticket.

From repository root, after exporting `MISSION_CONTROL_TEST_DATABASE_URL` and
`T013_CONFIG_DIR` from that private environment file:

```bash
node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types apps/web/test/fixtures/workspace/sync/prepare.ts
```

Then from `apps/web/test/fixtures/workspace`, with the same environment exported:

```bash
NODE_OPTIONS=--max-old-space-size=2048 NEXT_TELEMETRY_DISABLED=1 node ../../../../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 42928 --webpack
```

Readiness is `GET http://127.0.0.1:42928/sync` returning200 and the “Workspace sync
test fixture” heading. Follow the shared foreground heavy-job guard for setup and checks; check
expected compilation/runtime headroom before the long-lived server/browser launch. Use
one browser session with two isolated contexts. Account buttons obtain signed
fixture tokens; identity still resolves through the real private `/me` route.
The fixture publishes a changed token principal as pending before that read
settles, matching the production Privy boundary. Same-principal credential
renewal and wallet hints retain the current account. Stale me replies are ignored.
Correction runs may add only the recorded minimal synthetic accounts13–15 for
new absence/import/race cases in the retained DB; never run preparation again.
“Seed guest mixed setup” writes the exported guest journal and reloads. Controls
commit35 panels, hide all Data views, vary Portfolio controls and fill separate
Coin/Presale side drafts and commitment strings. The collapsed evidence output
contains the full setup; the financial observer count must remain0 through
restore and retries.

The assigned implementation handoff publishes the exact browser CDP scripts,
logs, state assertions and captures outside the product tree. The scripts cover
initialization races, distinct saved-empty/absence/error, auth/owner changes,
network/HTTP/storage/validation faults, accepted-response loss, delayed fallback,
clock skew, app restart/cache clearing, and required widths. They require a fresh
prepared fixture for initial-absence/race scenarios; completed scenarios must not
be reclassified as new initialization on a retained DB. Fault injection points
and simulated effects are recorded in each result JSON.

Before cleanup verify every owned PID using `/proc/<pid>/stat` starttime parsed
after the final `)` (post-comm field19), plus its command; check Docker ID,
volume and loopback port. Close the owned browser session and stop owned writers.
Retain the exact compatible app/DB only for an explicit reviewer transfer with
those identities and private configuration pointers. The coordinator owns final
container/volume and private-file cleanup. Leave other chats' services untouched.

### Capacity evidence lane (T-018)

The same `/sync` fixture also exposes `window.t018Capacity`, a test-only browser
bridge for bounded synthetic capacity measurements. It calls the real model,
browser localStorage journal and private workspace HTTP routes. It adds no
production instrumentation or UI. `capacity/workload.ts` defines 8/35/100 mixed
panels, four visible slots, six configured Data views and separate namespace
drafts. These are illustrative complete setups, not a measured traffic mix.
Five sequential primary samples follow a separately labelled warmup sample.

Allocate app42970, loopback PostgreSQL35307, container/volume `bmw-t018`, the pinned
PostgreSQL18 image above and max40 connections. Use a new private mode600 environment
file exporting `MISSION_CONTROL_TEST_DATABASE_URL` and `T018_CONFIG_DIR`; the latter
must name this task's new private issuer-key directory. Do not copy another task's
keys. `sync/configuration.ts` strictly validates the assigned database host, port
and name. Prepare once with the existing `sync/prepare.ts` command above, then run
the same Next fixture command on port42970. Reuse a valid prepared DB on retries.
The lane creates12 accounts; the bounded harness writes accounts1–4, at most19
accepted writes on its first complete warmup/primary run. Ceilings remain32
accounts/workspaces,512 replay rows,128 accepted writes and zero added market rows.

After readiness, invoke `t018Capacity.guest(count, "warmup" | "primary")` and
`t018Capacity.account(count, accountNumber, phase)` for counts8/35/100 and account
numbers1/2/3 respectively. `guestRestore()` verifies saved setup after an actual
browser reload. `guestBoundary()` separately checks the raw local snapshot limit.
`boundaryNear()` writes an exactly1048576-byte complete HTTP envelope to account4;
`boundaryOver()` attempts1048577 bytes and verifies unchanged private readback.
The latter uses a deliberately artificial long typed amount to isolate the byte
boundary. It is not part of the realistic workload. `capacity/inspect.ts` reads
database counts, storage sizes and SHA256 digests without emitting setup contents:

```bash
node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types apps/web/test/fixtures/workspace/capacity/inspect.ts
```

Pin harness/source/configuration/dependencies/fixture identities before primary
measurement. Keep before/after inspection around the rejected write. The bridge
returns metadata only; never print tokens, raw setups or browser storage. Existing
`db.transaction` metrics with label `social.workspace_save` measure the transaction
wrapper (including pool/begin/commit/retry), not isolated SQL execution time.
Browser HTTP duration separately includes authentication, throttling, validation,
network/server overhead and response consumption. Follow the host memory guard
and assignment cleanup/ownership transfer contract. T-018's implementation report
owns exact commands, pins, bounded samples, failed attempts and limitations.

## Action confirmation fixture (T-014)

`/confirmation` mounts the actual Settings screen, default lazy Coin/Presale
panels, current authentication bridge and final-action guards. Its Settings,
account and workspace endpoints use the production route kits with real isolated
PostgreSQL, runtime role, rate limiter and ES256 token verification. The local
issuer, market facts and wallet send observer are controlled test boundaries.
A send counter records kit invocation and returns a wallet refusal; it never
signs or submits a chain transaction.

Allocate the T-014 lane first: app42930 and loopback PostgreSQL35276. Use the
same pinned PostgreSQL18 image above, max40 connections and a private mode600
environment file exporting `MISSION_CONTROL_TEST_DATABASE_URL` and
`T014_CONFIG_DIR`. The latter points to a private directory for generated issuer
keys. Preparation applies the real migrations, including0124, and creates only
two synthetic accounts. Reuse the recorded compatible database rather than
resetting it or regenerating its keys during review.

From repository root, with the private environment exported, prepare once:

```bash
node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types apps/web/test/fixtures/workspace/confirmation/prepare.ts
```

Then from this fixture directory, with at least12GiB available and the shared
memory rules satisfied:

```bash
NODE_OPTIONS=--max-old-space-size=6144 NEXT_TELEMETRY_DISABLED=1 node ../../../../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 42930 --webpack
```

Readiness is HTTP200 at `http://127.0.0.1:42930/confirmation`, a styled fixture
heading and a working Account A control. Initial compilation can exceed50s.
Open the seeded guest workspace before signing into Account A to verify that
current action authority changes immediately while guest layout reentry waits.
Choose USDC for Commit. Account Settings exposes the real durable toggle; the
Final facts selector changes only controlled market/wallet responses. The
assigned implementation handoff records browser scripts, exact input pins,
account persistence checks and retained process/container ownership. Parent
review owns terminal app/database cleanup; close the task browser after proof.

## Presale graduation fixture (T-016)

`/graduation` mounts the production default lazy host, presale/coin adapters,
renderers and financial kits through controlled HTTP/kit boundaries. No database,
signer or chain transaction is involved. “Authoritative read” changes the next
explicit refresh or next presentation read; it does not run a scheduler. The
observer counts kit sends, detail reads and quotes. Route modes require a fresh
fixture load to isolate the production quote cache. The setup is retained in
this fixture tab's `sessionStorage` for reload proof; clearing that tab's session
storage resets the fixture. Use the assigned port42950 and the same Next command
above. The T-016 implementation handoff records exact runtime/process pins,
seven-width captures, lifecycle/identity/setup/route assertions and cleanup.


## Data tab customization producer (T-021)

The root `/` / catch-all `WorkspaceFixture` composes the production query provider,
AppShell, BlastModeHost, model and guest journal with six controlled Data adapters.
No DB, private configuration, transaction kit, signer or chain access is required.
The query provider repairs the previously missing root fixture composition; the
separate `/sync` page already has its own provider and is unchanged.

The reviewer/coordinator allocates an unused loopback port in `T021_APP_PORT`.
From this fixture directory, after the native resource/headroom check, run:

```bash
NODE_OPTIONS=--max-old-space-size=2048 NEXT_TELEMETRY_DISABLED=1 node ../../../../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port "$T021_APP_PORT" --webpack
```

This is a published startup recipe, not an implementer app run. Readiness requires
HTTP200 at `/`, the visible "Test fixture" notice, then successful visible
"Blast mode" entry with all six tabs and the "Simulated Coins Data adapter".
“Seed mixed setup and enter” seeds selected Presales, distinct navigation controls
for every view, watch/ended/card Presales controls and separate Coin buy/sell and
Presale commitment drafts in two main panels. It reloads this tab intentionally.
Each adapter's labelled "Saved VIEW position" control edits its actual model
navigation value. Use the product Customize tabs sheet to hide/re-enable views;
the toolbar entry stays reachable while Data is collapsed and on mobile. An
all-hidden Data body also exposes Customize tabs. The shared sheet supplies
keyboard/touch targets, focus trapping/return and reduced-motion behavior.

The documented test-only public API `window.workspaceTabsProbe` appears after
workspace entry. `snapshot()` returns only this fixture's immutable saved setup
and observable counters: `starts`, `stops`, `reads`, `accepted`, `active`, `pending`
(with view and abort state), `shellTicks` and `financialSends`. Data reads are
controlled promise responses recurring every1000ms. The independent shell tick
continues while all Data views are hidden; no market HTTP requests are involved.
`financialSends` is0 because this root fixture mounts no financial send path; it
is not evidence of signing/submission or a live transaction test.

Use `holdNext("Presales")` to hold that view's next controlled read. Wait for its
pending entry, hide it through the real UI, record `aborted: true`, then call
`release("Presales")`. `accepted` must not grow for that hidden late reply, and
neither selected/enabled views nor saved panels/controls/drafts may change. Hide
all six, wait for at least two further `shellTicks`, and verify no Data `reads`
growth and `active: []`. Re-enable through shown/all-hidden/collapsed/mobile
controls. Compare `snapshot().setup` and browser journal bytes across refresh
and exit/re-entry; no API for private framework state is needed.

Independent real-browser review still owns captures at320/407/768/1054/1414 and
1099/1100px (1023/1024px before the Blast mode audit, pass C), no overflow/clipping, touch targets, keyboard focus and reduced motion.
The implementation stage ran mounted tests only and started no app/browser/DB.

The minimalism follow-up additionally runs `verify-minimalism.mjs` with the same
`TRADING_CDP_URL` and `TRADING_EVIDENCE_DIR` variables. It seeds the local fixture
and checks exact contract/price inspection, touch targets, Escape focus return,
secondary discovery lists and discovery header widths.

## Single-coin workspace verification

`verify-single-coin.mjs` is the current trading workspace browser check. Run it
against the existing task-owned browser with `TRADING_CDP_URL` and
`TRADING_EVIDENCE_DIR`. It seeds four tracked coins, displays one at a time,
checks movable sections and saved layouts, exercises keyboard trading and its
input/dialog guards, and captures light/dark themes. Transactions are disabled.
The earlier trading/minimalism scripts document superseded Compare behavior.

The board no longer rearranges (owner, 2026-10-27): there is no Edit layout,
and two splitters resize the ticket column and the holders card within 15% of
the board. `WorkspaceHost.test.tsx` pins it; the Edit layout steps in
`verify-hierarchy.mjs`, `verify-layout-recovery.mjs` and
`verify-terminal-presale.mjs` are superseded historical evidence.


## Market terminal verification

The current terminal is checked by `verify-terminal.mjs` and
`verify-terminal-presale.mjs`. Set `TRADING_CDP_URL` to the single task-owned
browser and `TRADING_EVIDENCE_DIR` to its output directory. Run sequentially.
The coin runner seeds the guest journal, then checks direct resize, retained
amounts, discovery, keyboard controls, independent mobile order/height and both
themes at five widths. The presale runner uses controlled lifecycle modes and
asserts zero observer sends/claims. Older resize scripts describe superseded
masonry layouts; they are retained historical evidence.

Inline terminal discovery verification:

```sh
TRADING_CDP_URL=http://127.0.0.1:<task-browser-cdp-port> \
TRADING_EVIDENCE_DIR=<absolute-evidence-directory> \
node verify-discovery.mjs
```

Uses `/trading-proof` and the public discovery contract fixture in
`discovery-fixtures.ts`. Covers query states, manual refresh, duplicate contract
inspection, coin/presale selection, saved drafts, holdings/allocation, search
from another or disabled browser view, focus return, five widths, and light/dark.
The fixture does not authorize or execute any transaction.

Header follow-up: `verify-header.mjs` uses the existing trading fixture and
`TRADING_CDP_URL` / `TRADING_EVIDENCE_DIR`. It verifies full contract copying and
failure feedback, project destinations, personal holdings read states and
privacy, five widths in both themes, chart endpoint inspection and resizing,
and presale identity. The added `guest` and `wallet-loading` scenarios are
explicit simulations. Project destinations use example.com / example handles;
they do not claim affiliation with the invented fixture coins.

Full-width follow-up: run `verify-fullwidth.mjs` and then
`verify-fullwidth-final.mjs` with the same evidence/CDP variables. They cover
all-width discovery, actual-height resizing, current PnL and presale commitment,
price/funding chart sizing, retained draft DOM during movement, cancellation and
reload persistence. Final previews use ready quotes and simulated holdings;
no sends are invoked. PnL loss/unknown/error/loading scenarios are explicit
fixtures. Presale funding history starts at its actual fixture opening time.

`verify-compact-terminal.mjs` measures the shorter default top row, five complete
visible desktop discovery rows at1414×1000, lack of an internal desktop list
scroll, five widths/two themes, touch-safe card bounds, chart clearance, direct
resizing, draft retention and quote/presale states. Use the same CDP/evidence
variables and the single task-owned browser. Captures use simulated data.

## Component audit

`verify-component-audit.mjs` extends the compact terminal checks with long coin
and presale identities, exact huge/tiny amounts, holder and post read states,
post pagination and retained open details, search and shortcut focus guards,
readable discovery inspectors, closed presales, configured vesting and 200% zoom.
It checks visible toolbar controls for overlap and center-point hit testing;
retained inert popover content is excluded. Funding captures wait for a rendered
curve. Run with the same CDP/evidence variables, after the compact runner.

`audit-fixtures.ts` supplies explicit simulated actors, holders and posts.
`long-content` includes a 365-day buyer cliff and 1095-day duration. Missing
vesting remains a separate unavailable state. `presale-funded` and
`presale-cancelled` verify participation language and hide prospective allocation.
`AUDIT_SKIP_MATRIX=1` reuses a completed adverse matrix;
`AUDIT_FINAL_ONLY=1` resumes final checks from `component-progress.json`.
Use either only after the full preceding checks have run in this task.

`verify-audit-contrast.mjs` measures normal-size text against its composited
background in both themes after transitions settle. It writes `contrast.json`.
These fixture checks do not exercise real wallets, live orders or production
services; transaction sending remains disabled.

`verify-community-discovery.mjs` checks the Holders and Posts / theses columns,
known-zero versus unavailable counts, one-click section navigation, mobile
scroll/focus, preserved drafts, and five widths in each theme. The fixture
includes a linked KSTL coin with seven authored posts, a linked MOCHI coin with
zero, and a standalone LUMN coin without discussion coverage. Holder count time
is inspectable in the destination section.

## Keyboard and editable presets

`verify-shortcuts.mjs` uses the same CDP/evidence variables and /trading-proof.
It checks F entry, B exit and re-entry, Esc layering, Q/E and 1–4, literal input digits, Shift+Space
review (including held-key repeats), editable presets, validation, cancellation,
reload persistence, simulated storage failure and restoring defaults. It captures
the editor and ticket at five widths in both themes with coarse-pointer bounds
and focus return. Presets save only within the fixture browser; no transaction
is confirmed or sent.

## Layout report recovery

After seeding four assets, run `verify-layout-recovery.mjs` with the same
`TRADING_CDP_URL` and `TRADING_EVIDENCE_DIR`. It checks scroll recovery, stable
Buy/Sell geometry, inline search, duplicate identities/copy, saved-panel bounds
and keyboard focus, layout/draft preservation, and five widths in both themes.
The `sparse`, `unpriced`, and `coin-error` scenarios exercise observation age,
missing USD prices, and failed metadata reads. Sending remains disabled.
