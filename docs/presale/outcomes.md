# Presale outcome registration

The presale page records each commit as a verified outcome (contract section 3.6, T-017 of the presale backend workflow). The rules are the launchpad's, in [`docs/launchpad/telemetry.md`](../launchpad/telemetry.md), applied to the presale's `Committed` event. The code is in `apps/web/src/modules/presale/outcomes/`.

## Rules

- **Attribution.** The server reads the transaction from the presale identity's node. It records at most one outcome per `Committed` event: the first `Committed` of the configured presale package for `presale_id` in the transaction. The outcome belongs to the event's native `sender`, with the event's own checkpoint, time, and position. Who reports it never changes that.
- **Links.** An outcome is linked only where the server proved it:
  - the Privy account whose embedded wallet is the sender (`privy_did`), from that account's own session or from the sponsored execute route;
  - a visitor reporting with that session (`privy_session`);
  - the one visitor whose commitment of the digest was received before the checkpoint time (`signed_commitment`). Two or more visitors' commitments are contested and link nobody.

  Otherwise the outcome is wallet-only. A recorded visitor link is never replaced. A later proof can add a missing link.
- **No waiting.** Neither route waits for a transaction to be confirmed. A commitment reads no node. A report makes one node read, bounded by the launchpad's `OUTCOME_READ_TIMEOUT_MS` (2 s) with at most `OUTCOME_READ_CONCURRENCY` (8) reads in flight per process. A transaction the node has not checkpointed yet is `not_found` at once.

## Routes

| Route | Answers |
| --- | --- |
| `POST /api/presale/outcomes/visitor` (no body) | `204`, minting `__Host-blast_vid` when the request has no valid one; `origin_invalid`, `rate_limited`, `service_unavailable` |
| `POST /api/presale/outcomes/commitments` `{ presale_id, tx_digest }` | `201 recorded`, `200 duplicate`, `422 no_visitor`, and the kit codes |
| `POST /api/presale/outcomes` `{ presale_id, tx_digest }`, optional `Authorization: Bearer <Privy token>` | `201 recorded`, `200 duplicate`, `404 not_found`, and the kit codes |

All three are same-origin: a present `Origin` must be `SITE_ORIGIN`, and `Sec-Fetch-Site` must be absent or `same-origin` (the launchpad's `sameOrigin`). The outcome route treats a missing, invalid, or expired token as anonymous and never answers `unauthorized` (CL-22). Its answer never says whether, or to whom, an outcome is linked. A node that cannot answer now is `service_unavailable` with `Retry-After`.

**Visitor route.** The launchpad's telemetry route is the only other place that mints the visitor cookie, and the presale ships with the launchpad off. This route mints it with exactly that route's attributes (`visitorCookie` in `launchpad-telemetry/http.ts`). It keeps an existing valid cookie. It stores nothing. The page calls it once per tab per page load, before it registers a commitment.

## Rate limits

| Bucket | Subject | Limit | Counts |
| --- | --- | --- | --- |
| `presale_outcome_commit` | IP | 60 / min | each commitment, and each visitor-route call that mints a cookie |
| `presale_outcome` | IP | 30 / min | each outcome report |

A visitor-route call that already carries a valid cookie spends nothing. So a returning visitor's page loads, in any number of tabs, are never refused. Only a browser's first page load mints, and it spends one unit. A user who opens a few tabs at first visit spends one unit per tab until the first cookie lands, then nothing.

## Sponsored commits

The sponsored execute route records its commit without a browser call:

```ts
import { presaleOutcomeRecorder } from "@/modules/presale/outcomes/runtime";

after(() => presaleOutcomeRecorder().recordSponsoredCommit({ presaleId, txDigest: digest, privyDid }));
```

It records the outcome for the event's sender, and links `privyDid` only when that account's embedded wallet is the sender. While the node has not checkpointed the transaction, it tries again after 1, 2, and 4 seconds (`SPONSORED_COMMIT_RETRY_DELAYS_MS`). It never throws. It resolves to `recorded`, `duplicate`, `not_found` with a reason, or `unavailable`.

## Storage

Migration `0043` adds `presale_outcomes` (one row per `(tx_digest, event_seq)`) and `presale_outcome_commitments` (one row per `(tx_digest, visitor_id)`). Only `blast_web` has grants. It may update an outcome's link columns only (`visitor_id`, `visitor_link`, `privy_did`), and it may delete outcomes for retention. Commitments are inserted and deleted, never updated. A digest's commitments are deleted when its outcome is recorded.

**Retention** mirrors the launchpad's exactly (decision D-8; the owner can change it before launch). The hourly maintenance cleanup (`mission-control/maintenance/repository.ts`, run as `blast_web`) deletes in bounded batches:

- outcomes whose `completed_at` is older than the launchpad reporting policy's retention (`LAUNCHPAD_REPORTING_POLICY.retentionDays`, 90 days), which is also the visitor cookie's lifetime;
- commitments no report has decided, once their `committed_at` is older than the launchpad's commitment window (`LAUNCHPAD_OUTCOME_COMMITMENT_WINDOW_MINUTES`, default one hour, never past the retention). One setting governs both products.

Each transaction runs with `SET LOCAL` budgets (`PRESALE_OUTCOME_STORAGE_TIMEOUTS`: 1 s statements, 500 ms locks). A slow database answers `service_unavailable` instead of holding the page.

## Metrics

`presale.outcomes` records bounded labels only, never a digest, wallet, visitor, DID, or token:

- `outcome_report` `rejected` or `dropped` with the verifier's reason;
- `outcome_privy` `rejected` (`other-wallet`, `no-wallet`) or `dropped` (an error label or `timeout`);
- `outcome_commitment` `late` with a count;
- `sponsored_commit` `dropped`.

Outcomes are a lower bound, as on the launchpad. A report sent before the server's node has the transaction is `not_found` and records nothing; the page should report once its own node shows the commit.
