# Portfolio private-read and Sell fixture

This test-only Next entry mounts the production AppShell, lazy default BlastModeHost,
PortfolioData, model/journal, CoinPanel and final-action guard. Summary/coin/position,
account, workspace and Settings reads use the real production private route factories,
real ES256 token verification, blast_web primary role and the assigned PostgreSQL DB.
The test-only issuer and wallet/quote/send observer are controlled; no real signer,
provider transaction, live ingestion or chain effect exists here. A `traded` observer
answer proves renderer completion/invalidation interaction, never a sandbox sale.

Coordinator allocation: app127.0.0.1:42980; PostgreSQL127.0.0.1:35320;
database mission_control_test; container/volume blast-desktop-run18-t020.
Use only the coordinator's private mode600 t020-fixture.env and T020_CONFIG_DIR.
Preparation is one-time and rejects a second run; reuse prepared DB/keys after retries.

From source root, with the private environment exported:

```bash
node --no-warnings --import ./scripts/test-tsx-hooks.mjs --experimental-strip-types apps/web/test/fixtures/workspace/portfolio/prepare.ts
```

The prepared tier contains3 accounts,3 linked wallets,28 holdings,1 position and3 sales;
all counts stay below32 accounts/100 rows per type. A's verified wallets aggregate
123.45USDC and600000.000000001KSTL. B holds73USDC and no KSTL. Account3 has no
wallets. LUMN has stale USD valuation but resolved trade metadata; ODD keeps null
decimals and stale valuation. Core preferred zero holdings remain supplied by the
existing coin-page model. Enough extra tiny holdings exercise20-row paging. Route
reads use the preparation's fixed clock to keep fixture valuation reproducible.
The two migrated KSTL/LUMN references make the actual production coin-list boundary
resolve Sell support even when LUMN has no fresh USD valuation. The already-prepared
desktop DB receives only those two references via coordinator-owned one-time
`add-supported-assets.ts`; that script checks exact original counts/identities, adds
no holdings and refuses a repeated repair. Fresh preparation already includes them.

From apps/web/test/fixtures/workspace, after native memory/headroom checks:

```bash
NODE_OPTIONS=--max-old-space-size=2048 NEXT_TELEMETRY_DISABLED=1 node ../../../../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 42980 --webpack
```

Readiness: HTTP200 at http://127.0.0.1:42980/portfolio-proof and heading
“Portfolio private-read and Sell fixture”. Builder starts none; reviewer owns app
and browser. Use the prepared existing DB, never reset/reseed it. First open the
seeded guest Portfolio, then chooseAccount A inside Blast Mode to prove live-account
private data while the layout owner remains guest. Choose absent/visible/retained
before seeding. Seeding signs the fixture out and reloads the test page before opening
the workspace, so the intentional per-tab guest journal cache cannot retain a previous
arrangement. “Resume workspace” preserves the journal.

Observe final-state requests, private/no-store responses, actor changes, stored setup
bytes, exact inspect overlays, global amount hiding, search/paging, delayed/error/retry
and hidden-document/Data cancellation. Delay the real A read with browser request
interception before changing toB; no fixture fake holdings endpoint is involved.
Expected shortcut observer count0; an explicit valid Sell increments1. Final-facts
modes exercise expired quote, insufficient balance, unresolved route and wallet refusal.
The controlled completion calls the existing shell invalidation boundary; watch the
Portfolio read refresh when Data is shown again. Selected signer is explicitly the
controlled Privy wallet and last actor/side/amount is published without credentials.

Required reviewer widths320/407/768/1099/1100/1054/1414 (1023/1024 before the Blast mode audit, pass C), keyboard/touch/focus and
reduced motion. Report browser/DB comparison separately from financial observer
proof and real sandbox execution (not supplied). Coordinator retains DB/private keys
for review/train and owns terminal cleanup; reviewer stops its own app/browser.
