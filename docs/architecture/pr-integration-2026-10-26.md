# Architecture PR integration, October 26, 2026

This integrates the reviewed Web16 architecture and continuous market updates with `develop` at `9ddeff3c1fcd37d944f2961fe0ab881b7fbc24e0`. The original Web16 and Rust17 source freezes, test evidence and raw snapshots remain retained in their original checkouts. The integrated source has its own freeze and verification evidence; older results are not relabelled as results for this merge.

Server implementation stays in `packages/server`; pure browser contracts stay in `packages/core`. New health, competition, activity-stream and workspace routes use the existing authenticated backend boundary. Updated trading and workspace features from develop remain present. Activity hints retain hidden-tab cleanup, bounded streams and the deployed hints-service option. Committed chart prices and forming candles retain one shared chart connection, checkpoint fences, HTTP history recovery and paused-state feedback.

Integration fixes reconcile moved imports, compound account readers and deterministic withdrawal fixtures. Create draft persistence and uploads have focused owners, storage/session ownership is preserved, and recovery uses the shared controls. Existing test assertions and raw snapshot expectations were not weakened to accommodate these integration fixes. The obsolete workspace tab assertion already fails on develop: it expects five tabs while the current UI uses two tabs plus More; it remains unchanged and is recorded as a baseline failure.

## Verification evidence

Local evidence lives in the workspace artifact directory `outputs/verification/2026-10-26-architecture-merge-18/`:

- Web, core, workers and server typechecks passed. Web uses a fresh non-incremental check.
- Full backend API checkpoint: 180 passed. Shared server checkpoint: 474 passed.
- Chart, header and onboarding focused checks: 61 passed. Create/recovery focused checks: 61 passed.
- Disposable PostgreSQL migration rehearsal applied the complete Web schema; its repeat was a no-op. This does not validate a hosted database or migration credentials.
- Merged chart browser observations use actual components and relays with simulated chain data at 320, 407, 768, 1054 and 1414 px. A pushed committed trade updates the header without a history request; simulated hidden visibility closes the transports, and visibility/outage recovery restores the single shared connection.

Additional final-check outcomes and exact source hashes are in the artifact README and freeze manifests. Historical raw verification logs retain their original whitespace.

## Merge and release boundaries

PR #444 targets develop; PR #53 targets blast-infra main. Live Render inspection on October 26 confirms the Rust indexer has auto-deploy off. The existing `live-hints` service follows develop with auto-deploy on; Vercel source configuration also enables develop/main deployments. The merge request authorizes the requested merges and their normal checks; it is not evidence that the new standalone backend or independent Rust reader has been deployed successfully.

The Rust GitHub workflow is currently manually disabled. A previous Web workflow could not start because of account billing/spending limits. Local check results must be reported separately from hosted CI results.

**Ingestion and combined ingestion/read acceptance remain BLOCKED pending the coordinator decision.** This acceptance hold does not mean live production ingestion has been paused. Hosted capacity for 10,000 simultaneous users and uninterrupted production release behavior remain unestablished.
