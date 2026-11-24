# Audit closure fixture

Mounts production components with explicitly controlled read failures and signing
observers. No account authentication, signature, chain write or production API
call occurs. `wallet.ts` replaces only the vesting wallet boundary through the
fixture Vite alias. The production application does not import this fixture.

Run from the repository root with `node node_modules/vite/bin/vite.js --config
apps/web/test/fixtures/audit-fixes/vite.config.ts`. Port 42973 is task-owned only
while verification is running. Financial observer calls are exposed at
`window.auditWallet` so a pending status check can prove that execution did not
repeat. Query fixtures cover failed and cached reads without private user data.
