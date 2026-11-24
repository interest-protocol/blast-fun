# Social worker

One long-running process runs the social feed's server-side steps: the milestone posts (social-feed T-027 and T-029), the notification generator (canonical UI §13, UI-13) and the daily portfolio-value snapshot behind the gold card's trend (OA-25 Q16, `packages/core/src/modules/social/portfolio/snapshots.ts`); the intent resolution step (T-026) plugs into the same runtime. It comes from social-feed T-025. The code is in `apps/workers/src/modules/social/worker/` (runtime), `packages/core/src/modules/social/milestones/generate.ts` and `packages/core/src/modules/social/notifications/generate.ts` (steps).

It signs nothing and copies no chain activity: it reads blast-infra's `chain_read_v1` views (never past the indexer watermark) and writes social rows as the watcher login (`blast_watcher`), through module `social`'s table ownership. The one other read is the portfolio snapshot's USDC and SUI balances, from the mainnet fullnode exactly as `/me/portfolio` reads them (about two calls per wallet per day), because `chain_read_v1` publishes sale-coin balances only; the owner approved it as built (2026-10-06).

## Running it

```bash
npm run worker -w @blast/workers -- social
```

`apps/workers/start.sh social` runs `runSocialWorker` (`main.ts`) on the worker host, off Vercel, next to the presale workers.

- With `BLAST_SOCIAL_ENABLED` not exactly `true` or `team` it prints `social.worker.disabled` and exits 0 without connecting.
- SIGTERM or SIGINT finishes the current pass, releases the lease and the pool, and exits 0.
- A configuration error exits 1 with one `social.worker.config_error` line that names the variable, never its value.
- Every line is JSON (`{ metric, at, ... }`), redacted against the database URLs, their passwords and the webhook URLs. No line carries a bearer token, a why's text or a report reason.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BLAST_SOCIAL_ENABLED` | off | `true` or `team` runs the worker (`team` is the web's team-only mode; the worker serves no pages, so it runs as at launch). |
| `WATCHER_DATABASE_URL` | required | The Neon primary's pooled endpoint as the watcher login (its own login, not the web runtime's). |
| `WATCHER_DATABASE_POOL_MAX` | 2 | Pool size (1 to 2). |
| `SOCIAL_WORKER_INTERVAL_MS` | 5000 | One pass every interval (1 s to 60 s). Failed passes back off, doubling up to 60 s. |
| `SOCIAL_WORKER_LEASE_TTL_MS` | 30000 | Lease time to live (5 s to 50 s); a standby takes over within TTL + interval. |
| `SOCIAL_NOTIFICATION_BATCH` | 500 | Rows read per pass by each row-bounded step: commits for milestones and notifications, holder-history rows for `milestone-holders` (10 to 5,000). |
| `SOCIAL_NOTIFICATION_RETENTION_DAYS` | 90 | Notifications whose event is older are deleted (7 to 730). |
| `SOCIAL_NOTIFICATION_UNLOCK_LEAD_DAYS` | 7 | How long before a team unlock backers hear of it (1 to 120). |
| `SOCIAL_PORTFOLIO_SNAPSHOT_BATCH` | 100 | Accounts the daily portfolio snapshot values per pass (10 to 1,000); each costs two fullnode reads per wallet. |
| `SOCIAL_PORTFOLIO_SNAPSHOT_RETENTION_DAYS` | 400 | An account's daily snapshots older than this are deleted as it gets a new one (31 to 3,650). |
| `SOCIAL_ALERT_WEBHOOK_URL` | `PRESALE_ALERT_WEBHOOK_URL`, else none | The alert webhook (https; loopback http outside production). Without one, alerts are `social.alert` log lines only. |

`participant_milestones` (the backer counts that become milestone posts and notify) and `holder_milestones` (the holder counts that become milestone posts) are `social_config` keys the feed already uses, read through the 30 s cached reader, so a change applies within a minute.

## One active instance

The lease is the operational worker's `mission_control_worker_leases` row `social-worker` / `main`. Every pass renews it (or tries to acquire it); a process without it logs `social.worker.standby` and does nothing else. A standby takes over within about 35 s of the holder stopping. Every step's transaction first locks the holder's own live lease row (`FOR SHARE`), so a holder that lost its lease (paused past the TTL) cannot commit (`social.worker.step_error` with `error: "LeaseLost"`), and a taker's acquire waits for a step in flight.

## Steps, cursors and the watermark

Each step runs in its own transaction: it reads its cursor from `social_worker_state`, reads chain data no further than its pipeline's watermark (`chain_read_v1.watermark`), writes, and stores its cursor, all committed together. A failed step leaves its cursor; the next pass repeats it, and every write is idempotent.

| Step | Pipeline | Cursor | Writes |
| --- | --- | --- | --- |
| `milestone-commits` | presale | last commit `(checkpoint, tx_slot, event_slot, part)` and its time | `social_milestones`: `m:<presale>:participants:<v>` for each `participant_milestones` value a commit takes the backer count to or past for the first time, and `m:<presale>:raise:<raise_target>` when a commit takes the total to the target; with that commit's time, digest and activity id |
| `milestone-holders` | market (and capped at the presale checkpoint) | last holder-history checkpoint read | `social_milestones`: `m:<presale>:holders:<v>` for each `holder_milestones` value a `chain_read_v1.coin_holder_history` row takes the sale coin's holder count to or past for the first time; with that row's time and coin type |
| `notify-activity` | presale | last commit `(checkpoint, tx_slot, event_slot, part)` read | `follow` to the actor's followers when the naming rule names the actor; `fill` to a sale's followers and backers when a commit takes the backer count exactly to a milestone, or the raised total across 80% of the target |
| `notify-lifecycle` | presale | last checkpoint read | `funded` to backers; `claim` (tokens on `migrated`, refunds on `cancelled`) to backers who have not claimed |
| `notify-clock` | presale | last chain time read | `soon` an hour before a followed pending sale opens and an hour before a backed open sale closes; `unlock` the lead time before a backed sale's team vesting starts |
| `notify-retention` | none | none (every 10 minutes) | deletes notifications older than the retention, 10,000 per run |
| `claim-settle` (R3-63) | presale | none (the open claims are the queue) | `social_transactions`: an open claim (`submitted`, with a digest) whose transaction the activity shows as a `presale_claim` becomes `confirmed` when one of its rows paid a wallet of the row's account from the row's sale, else `failed` / `mismatch`, at the chain's time; `SOCIAL_NOTIFICATION_BATCH` per pass |
| `claim-expiry` (R3-63) | presale (its time is the clock) | last sweep's chain time (every 10 minutes) | `social_transactions`: an open claim with no digest after an hour, and a sent claim after 24 hours, becomes `failed` / `expired`; a sent vesting claim only while `chain_read_v1.transaction_evidence` has no row for its digest (one with evidence is left to the vesting step) |
| `portfolio-snapshot` (OA-25 Q16) | market and presale (the slower one's time is the clock) | the UTC day, the sweep's last account, when the sweep finished, the retry round's last account and when the next round may start | `social_portfolio_snapshots` (0097): once per UTC day each account with a wallet, `SOCIAL_PORTFOLIO_SNAPSHOT_BATCH` accounts a pass in primary-key order: its Committed, Claimable and Tokens (`chain_read_v1`) and its USDC and SUI (the fullnode, as `/me/portfolio` reads them) at that moment's `chain_read_v1.prices` (USDC at face value), exact, rounded to cents; or a skipped row (`price_missing`, `balances_unavailable`), retried every 15 minutes until the day ends. Deletes the account's rows older than the retention. Waits while either watermark is more than 5 minutes behind |

A first pass starts every notification cursor at the watermark: history before the worker first ran is not notified. Both milestone steps start at the origin instead and write history's milestones in batches (oldest first, each dated at its own row): measured at launch scale, a whole 1M-row activity history takes about 1,400 passes (two hours at the 5 s interval) and writes the same rows as a live run.

"Before" a commit (or a holder-history row) is the same sale's (or the same coin's) previous one (none: 0), so a milestone is only ever written where it was crossed: a value added to `participant_milestones` or `holder_milestones` later is written at the next row that crosses it (or at its historical crossing if the cursor is replayed from the origin by deleting the step's row of `social_worker_state`), and a replay with the same values writes nothing new. Milestone entries are keyed by sale, kind and threshold, inserted with `ON CONFLICT DO NOTHING`, so a holder count that drops and rises past a value again adds nothing.

`milestone-holders` reads the market pipeline's rows but joins the presale pipeline's sales, so its batch stops at the lower of the two checkpoints: a holder-history row in a checkpoint the presale pipeline has not reached may belong to a sale coin whose `PresaleCreated` is not indexed yet. Its cursor is one checkpoint, and it reads each sale coin on blast-infra's `(coin_type, checkpoint)` index, so a pass costs two index probes per shown sale plus the rows it reads.

To replay a notification range (for example after an outage longer than you want to skip), move the step's cursor back with the CLI login; the unique `(account_id, source_key)` key makes the replay insert only what is missing:

```sql
UPDATE social_worker_state
SET value = jsonb_build_object('c', <checkpoint>, 't', 0, 'e', 0, 'p', 0, 'ts', <timestamp_ms of that checkpoint>)
WHERE name = 'notify-activity';
```

Each switch of `social_notification_preferences` (Settings → Notifications) is applied when a notification is generated; a switched-off kind is not written for that account.

`portfolio-snapshot` is the gold card's 30-day trend (OA-25 Q16, R3-08): the card's slot stays empty until an account's newest valued day is today or yesterday and the day 30 days before it is valued too (`portfolio/trend.ts`). An opted-in public portfolio shows only the days since it last became public (`social_accounts.portfolio_public_since`, 0097), so it needs a month of public history; the owner's own view shows all of it. A valued day is final (0097's trigger refuses a change); a day the worker never reached has no row and is never backfilled, because holdings are read as they are now. To snapshot a day again after an outage on the same UTC day, delete the step's row of `social_worker_state`: the sweep restarts and values only the accounts without a row.

## Metrics

| Line | Fields |
| --- | --- |
| `social.worker.pass` | `outcome` (`ok`, `error`, `standby`), `durationMs`, `lagMs` (the slowest pipeline's watermark behind the database clock), `intents_resolved`, `intents_rejected`, `intents_late`, `claims_confirmed`, `claims_failed`, `claims_expired`, `milestones_written`, `notifications_written`, `notifications_deleted`, `snapshots_written`, `snapshots_skipped` |
| `social.worker.step_error` | `step`, `error` (a SQLSTATE or error class) |
| `social.worker.standby`, `social.worker.lease_lost` | `holder` |
| `db.transaction` | `label` `social.worker.<step>`, duration and outcome |
| `social.alert` | `key`, `outcome` (`sent`, `logged`, `failed`, `cleared`) |

## Alerts

| Key | Raised when | Repeats | What to do |
| --- | --- | --- | --- |
| `social_worker_stalled` | No successful pass for 5 minutes (database unreachable, a step or health check failing) | hourly while it holds | Check `social.worker.step_error` lines and the watcher login; the worker retries with backoff by itself. |
| `indexer_lagging` | The slowest pipeline's watermark more than 60 s behind for 5 minutes | hourly | blast-infra's indexer is behind; notifications wait for it (nothing is lost). |
| `wallet_conflict:<address>` | An address two accounts' wallet sources both claim, newly seen (checked once a minute) | once per address | The address is named by neither account (`social_wallet_owners` drops it); resolve the duplicate link. |
| `defaults_incomplete` | Fewer than 5 rows in `social_default_accounts` (`SOCIAL_DEFAULT_ACCOUNT_COUNT`) | hourly | `npm run social:operator -- defaults set <five callsigns>`. |
| `step_late:portfolio-snapshot` | Today's portfolio snapshot sweep (UTC) not finished 3 hours after midnight (checked once a minute) | hourly | The sweep waits for the indexer (`indexer_lagging`) and the worker; `snapshots_skipped` and `social_portfolio_snapshots.skipped` say whether prices or the fullnode are missing. Accounts it does not reach today have no point for today (never backfilled). |

Alert state is kept in the process (so `social_worker_stalled` still goes out when the database is the problem); a standby taking over may send a held alert once more.

Successful health checks run once a minute. A failed check marks the pass as `error` and retries on the next pass with the worker's backoff.

## Scale

Fan-out is on write: one row per recipient, written in one set-based statement per step. The largest fan-out measured (one commit by an account with 9,999 followers) writes 9,999 rows in one statement; a 500-commit batch of ordinary accounts reads its recipients in about 120 ms. Read-side numbers (page, unread count, mark read) are in the social-feed COORDINATION.md "UI-13 Notifications record".
