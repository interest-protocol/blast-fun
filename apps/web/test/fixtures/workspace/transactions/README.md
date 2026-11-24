# Submitted transaction fixture

`/transactions` mounts the production CoinPanel, PresalePanel, useTradeHost,
useCommitHost, kits, signing validation, transaction flows and shell notices.
Only the external API, wallet bridge module and execution provider are controlled.
The fixture webpack alias replaces the Privy modules; no production host has
a signer override. Mounted tests install the same module boundary fake.
The transaction bytes are built offline. No database, real account, wallet
signature, sponsor, settlement worker or chain is contacted.

From `apps/web/test/fixtures/workspace`, after the shared host memory check:

```sh
BLAST_ACCEPTANCE_FIXTURE=1 NODE_OPTIONS=--max-old-space-size=6144 NEXT_TELEMETRY_DISABLED=1 node ../../../../../node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 42940 --webpack
```

Use the assigned port and one task browser. The fixture config transpiles the
same TypeScript SDK packages as the owning web app. Readiness is HTTP 200 at
`http://127.0.0.1:42940/transactions`, the styled heading, and an actionable
production panel. Initial compilation loads the real wallet/dialog graph.

Choose Buy, Sell or Presale/Commit, then submit once. The provider pauses the
existing flow at execution until Complete provider. Change Presentation to
unmount or hide its originating display while the shell owner stays mounted.
The controls model the visibility/disposal boundary; they do not exercise the
workspace layout engine or account-sync transport. Change current account UI
changes the panel's authority key. Mounted tests additionally change the real
SocialViewerProvider principal and token source while execution is pending.

Provider outcome supports confirmed, unknown and cancelled signature. Counters
record actual production-flow boundary calls. Trades and intents outputs are
in-memory provider records, not database or genuine chain effects. Unknown
trades use the existing five settle reads and remain built/pending. Unknown
commits retain the registered digest. A cancelled signature never executes.
Reload creates a fresh controlled provider and must never submit automatically.
The encoded setup probe uses the production serializer and excludes financial
runtime state. This fixture intentionally runs one controlled execution at a
time; it adds no transaction scheduler or new recovery policy.

The assignment handoff contains exact source/config/dependency pins, commands,
failures, mounted tests, browser state and captures. Keep a compatible server
only when the coordinator accepts cleanup ownership; close the task browser.

The `/transactions/pending` route was removed with the old Blast mode composer
(blast-v2#598). `src/components/social/commit/CommitPending.test.tsx` keeps the
normal dialog's and inline form's pending recovery under unknown execution.
