# Presale gas sponsorship

`POST /api/presale/sponsor` gives a signed-in user's page full transaction bytes for its own wallet: a Privy account's embedded wallet, or the address of an outside wallet's sign-in session (Slush, Nightly and the others; owner ruling 2026-11-20, which reverses OA-17). Blast's sponsor is the gas owner, and the sponsor's **address balance** pays: the bytes list no gas coins (an empty payment) and carry a `ValidDuring` expiration, as Sui requires for address-balance gas. There is no coin pool, no Redis and no reservation outside this table. The page has the user sign the bytes. The web app signs nothing: the sponsor service ([blast-gas-pool](https://github.com/interest-protocol/blast-gas-pool) `server.ts`, Render service `gas-pool`) re-checks the bytes and co-signs inside execute ([Execute](#execute), T-018). The design follows [Onara](https://github.com/unconfirmedlabs/onara). This comes from T-016 of the presale backend workflow. It builds on the foundation in [`foundation.md`](foundation.md).

Code: `packages/server/src/modules/sponsor/` (`service.ts`, `chain.ts`, `reservations.ts`, `runtime.ts`; execute: `execute.ts`, `executions.ts`, `pool-execute.ts`) and `apps/web/src/app/api/presale/sponsor/route.ts`, `apps/web/src/app/api/presale/sponsor/[reservation_id]/execute/route.ts`.

## Contract

```
POST /api/presale/sponsor
→ { presale_id, sender, transaction_kind_bytes (base64), intent: "commit"|"claim"|"settle"|"cancel"|"reward_claim" }
← 200 { reservation_id, transaction_bytes (base64), sponsor_signature: "", expires_at_ms, gas_budget }
```

- `reservation_id` is the row's `id` in `presale_sponsor_reservations`, not the pool's.
- `gas_budget` is MIST as a decimal string.
- `expires_at_ms` is the claim time + 120 s − 10 s. The bytes themselves stay valid on chain until the end of the next epoch; the route's own expiry is what execute enforces.

## Ordered checks

The first failure answers. Nothing is stored before step 10.

1. **Auth.** The Privy token; without one, a live outside-wallet session cookie (`__Host-blast_wallet`) on a same-origin request (`Origin` is the site, `Sec-Fetch-Site`, when sent, `same-origin`; else `origin_invalid`). Otherwise `401 unauthorized`. A dead or unknown cookie counts against the per-IP `social_auth_failure` limit, and past it the route answers `429 rate_limited` before any session lookup. A wallet session counts as the account `sui:<address>` in every per-account bucket, reservation and daily limit below. Then bucket `presale_sponsor`.

   Budgets are per credential: a Privy account and each wallet session address has its own per-account budgets here. Only the social trade cap (`trade_sponsor_daily_cap`) adds a social account's Privy and wallet credentials together. A new wallet address costs nothing to make, so for wallet sessions the per-IP and platform-wide budgets are the real bound on total spend.
2. **Body.** Exact keys, canonical addresses, a known intent, and canonical base64. Otherwise `invalid_request`. A kind over 16 KiB after decoding is `413 body_too_large`.
3. **Wallet.** `sender` must be the caller's own wallet, else `403 not_embedded_wallet`: a Privy account's embedded Sui wallet (`resolveEmbeddedSuiWallet`), or a wallet session's address. This refuses other users' wallets. No code path sponsors any other sender. A Privy outage on a cache miss is `503 identity_unavailable`.
4. **Deployment.** The identity is checked against the node: `deployment_unavailable` or `deployment_mismatch`. The gate runs inside the handler, after the wallet check, so the route declares `deployment: "none"` to the kit.
5. **Target policy.** The kind is decoded; non-canonical BCS is `invalid_request`. The chain facts are read: the sale's types from the presale object and, for `reward_claim`, each round's vault and that vault's presale. Then `evaluateSponsorPolicy` (T-015) runs. A refusal, or a `presale_id` that is not a presale of the deployment, is `403 target_not_allowed`. It is counted per UTC hour and reason.
6. **Open reservations.** At most 2 `reserving`, `reserved` or `submitted` rows that have not expired, per DID. Otherwise `429 budget_exceeded` with `error.reason: "open_reservations"` and `Retry-After` until the earliest time a slot may free (CL-25). That time is the earliest open `expires_at`. For a `reserving` claim that may still complete, it is the claim's deadline instead (column `pool_deadline`): claim time + 5 s (Q-017). This early check spares the simulation; the claim (step 10) rechecks it under a lock.
7. **Daily budget.** Fewer than 100 executions today. The check reads bucket `presale_sponsor_exec` with `PostgresRateLimitEnforcer.peek`, which consumes nothing; execute consumes the bucket. Otherwise `429 budget_exceeded` with `error.reason: "daily_limit"` and `Retry-After` until the next UTC midnight (CL-25). Clients choose their copy from `reason`, not from the size of `Retry-After`. Social draft publishing translates this refusal to `429 rate_limited`, preserving the reason and retry header.
8. **Simulation.** The fullnode simulates the exact final shape: `PRESALE_SPONSOR_ADDRESS` as gas owner, an empty payment (the sponsor's address balance), the reference gas price, budget = cap, and the `ValidDuring` expiration of step 11. One `getCurrentSystemState` gives the price and the epoch. An abort is `400 dry_run_failed`:
   - an abort in the presale package (`packageId` or `originalPackageId`) that the SDK's `presaleAbortName` maps: `move_abort: <name>`;
   - anything else: `move_abort: null, reason: "external_abort"` (CL-19, CL-24). That covers an abort in another package, an unmapped presale-package abort code, and a failure that is not an abort.
9. **Budget.** budget = ceil((computation + storage) × 1.2), clamped to [2,000,000, cap]. A cost above the cap, or an insufficient-gas failure, is `dry_run_failed` with `move_abort: null, reason: "gas_cap_exceeded"`.
10. **Claim.** One short transaction takes a per-DID advisory lock and rechecks the open cap, counting `reserving` rows as open. With a free slot it inserts a `reserving` row and commits. The row's `expires_at` is the claim time + 5 s + 120 s. A full account answers `429 budget_exceeded` (`open_reservations`, with `Retry-After` as in step 6). A claim that cannot take the lock within the lock timeout answers the same code with `Retry-After: 1`, not a 503 (B-005). No gas pool is called: nothing outside this table is reserved.
11. **Build.** `TransactionData` V1 holds the caller's kind byte for byte, the sender, the gas owner (`PRESALE_SPONSOR_ADDRESS`), an empty payment, the reference gas price, the budget, and `ValidDuring { min_epoch: current, max_epoch: current + 1, chain: the identity's chain identifier, nonce: random u32 }`. The nonce keeps two otherwise identical transactions distinct.
12. **Complete.** One short write turns the `reserving` row into `reserved`, with `tx_bytes`, `digest`, and the real `expires_at`; `pool_reservation_id` stays null (migration 0103). It matches only a `reserving` row whose claim has not expired by the route's clock. A completion after a stall past the claim expiry changes nothing and answers `503 service_unavailable`, so it never revives a slot the cap has stopped counting (Q-016). If the write fails, the row stays `reserving` until its claim expiry; the bytes were never handed out.

## Execute

```
POST /api/presale/sponsor/{reservation_id}/execute
→ { user_signature }
← 200 { digest, effects: { status: "success"|"failure", gas_used } }
errors: unauthorized 401, invalid_parameter 400, invalid_request 400, invalid_signature 400, not_found 404,
        reservation_expired 410, execution_unconfirmed 504 { error.digest }, and the kit's codes
```

`gas_used` is net MIST as a decimal string: computation + storage − rebate (CL-5). It may be negative.

**Steps.** The first answer wins.

1. **Auth and row.** The Privy token or a wallet session cookie, as for the sponsor route, else `401 unauthorized`. The path id must be a lowercase uuid, else `invalid_parameter` (CL-21). The body is exactly `{ user_signature }` in canonical base64, else `invalid_request`. The row must be the caller's and past the claim. Another account's row, an unknown id, and a `reserving` or `reservation_failed` row are all `404 not_found`. The route has no rate-limit bucket of its own.
2. **Stored outcome.** A repeat checks no signature and never submits.
   - `executed` and `failed_execution` are settled: 200 with the stored effects. `expired` answers 410.
   - `submitted` goes to step 6 without a new submission.
   - `unconfirmed` is not settled (coordinator clarification of ticket step 2, R-001 B-001). The repeat makes one digest lookup, bounded by the 2 s lookup budget. Effects found settle the row exactly as step 6 does: the conditional settle, then one unit and the commit link for the request whose settle matched. Otherwise the answer is the stored 504 with the digest. This is how a transaction that landed after the window, or while the node was down, gets its outcome, unit and link. A row nobody repeats stays `unconfirmed`; a background reconciler is a recorded follow-up.
3. **Expiry.** When the route's clock is at or past `expires_at`, a conditional update moves `reserved` → `expired` and the answer is `410 reservation_expired`. If that update matched nothing, another request changed the row first, for example by submitting it with a slightly earlier clock. The route then reads the row again and answers from its state: it waits on a `submitted` row, or answers a settled one. It never answers 410 for a reservation that is executing (R-001 Q-001).
4. **Signature.** `isValidTransactionSignature(tx_bytes, user_signature, { address: sender })` from `@mysten/sui/verify`. A failure, including a signature that cannot be checked without a node (zkLogin), is `400 invalid_signature`. Nothing is submitted, and the row stays `reserved`.
5. **Submit once.** The pool settings are read first; missing ones are `503 service_unavailable` before anything changes. Then the conditional update from [For execute](#reservation-table-presale_sponsor_reservations-migration-0042) moves `reserved` → `submitted`, with `submitted_at` set from the route's clock. A caller whose update matched no row reads the row again and answers from its state. Only the winner calls `POST <PRESALE_GAS_POOL_URL>/v1/execute { tx_bytes, user_sig }` with the bearer token and a 20 s timeout. The sponsor service refuses (400) unless the gas owner is the sponsor, the payment is empty, the sender is not the sponsor, the budget is within its cap, the expiration is `ValidDuring` on its chain and ends by the next epoch, the kind is programmable, no command touches the gas coin or publishes, and every withdrawal is the sender's. Then it co-signs and executes over gRPC. The request's own abort signal is not passed on, so a client that leaves does not cut off an execution.
6. **Settle.**
   - A 2xx answer with effects for the stored digest and no `error` settles the row.
   - Anything else leads to a digest lookup on the presale node: a timeout, a transport error, a gateway page, the service's error answer, or effects for another digest. The lookup runs about once a second for 15 s, at most 2 s per call. The row is read again on each round, so an outcome another request stored is answered as is.
   - A request that found the row `submitted` waits until the later of now + 15 s and `submitted_at` + 20 s + 15 s + 5 s. The last 5 s cover the submitter's own time: signature check, settings and the submit round trip before its service call, and its last 2 s lookup after its window (R-001 Q-004). So a waiter does not write `unconfirmed` while the submitter can still settle.
   - On every round, a row another request moved off `submitted` is answered by step 2. An `unconfirmed` row there still gets its one lookup.
   - With no effects by then, the row becomes `unconfirmed` and the answer is `504 execution_unconfirmed` with `error.digest`.
   - Settling is one conditional update: `submitted` or `unconfirmed` → `executed` (success) or `failed_execution` (failure), with `effects_status`, `gas_used` and `completed_at`. Effects are facts, so they also settle a row that an earlier call left `unconfirmed` (step 2).
   - Only the request whose update matched consumes one unit of `presale_sponsor_exec` for the account, through the kit's limiter. That is the bucket the sponsor route peeks at. Both statuses count (AC-034). A unit counted past the limit does not change the answer. The transaction has already executed, and execute publishes no `budget_exceeded`.
   - For an executed `commit`, that request also calls `presaleOutcomeRecorder().recordSponsoredCommit({ presaleId, txDigest: digest, privyDid })` in `after()`. This links the account through the reservation digest with no browser call (AC-134). A wallet session's commit is recorded unlinked (`privyDid: null`): it has no Privy account. Failures and other intents are not linked.
   - If the settling write fails, the route still answers the effects, which are the chain's, but counts nothing and links nothing (R-001 Q-003). The row stays `submitted`. The request that later settles it, a repeat for example, counts and links exactly once.

After step 5 the route answers only 200 or `execution_unconfirmed`. A submission whose fate is open is never reported as a refusal.

**Execute client.** `createSuiGasPoolExecutor` (`pool-execute.ts`) reads at most 1 MiB of the answer. It never throws. It returns `executed` with `{ digest, status, gasUsed }` parsed from the service's effects JSON (`status.status`, `transactionDigest`, `gasUsed`, the shape sui-gas-pool used). Every other outcome is `unknown`, with a `transport`, `pool_error` or `malformed` label and the HTTP status for metrics; the route then looks the digest up.

**Digest lookup.** `createSponsorTransactionLookup` (`chain.ts`) calls `core.getTransaction` with effects on the presale identity's node (`PRESALE_SUI_GRPC_URL`, else mainnet). The transaction does not need to be in a checkpoint. A `notFound` is null. Other failures count as not found for that round.

**Duration.** The route's `maxDuration` is 90 s. A request may take the sponsor service's 20 s, the 15 s window and its lookups, about 42 s for a waiter. `after()` runs within the same limit, and the sponsored-commit recorder may take about 15 s more.

**Metrics.** `presale.sponsor_execute` records `executed`, `failed_execution`, `unconfirmed`, `invalid_signature`, `pool_unsettled` (with a reason and HTTP status), `over_daily_budget`, `budget_count_failed`, `settle_failed`, and `unconfirm_failed`. It never records a digest, DID, wallet, or signature.

**Not run.** The tests use a fake sponsor service over the real client, a fixture node lookup, and a disposable Postgres; blast-gas-pool's own tests cover the service's checks. The route treats every answer without effects as unknown, and lets the chain decide.

## Settings

| Variable | Meaning |
| --- | --- |
| `PRESALE_SPONSOR_ADDRESS` | The sponsor's address (its address balance pays the gas). Required. |
| `PRESALE_SPONSOR_MAX_GAS_MIST` | The per-transaction cap. Default 50,000,000; at least 2,000,000. Must not exceed the service's `GAS_POOL_MAX_SUI_PER_REQUEST_MIST`. |
| `PRESALE_SPONSOR_SWAP_TARGETS` | The Cetus swap targets the commit intent sponsors (T-015). |
| `PRESALE_GAS_POOL_URL`, `PRESALE_GAS_POOL_TOKEN` | The sponsor service's base URL (http or https) and bearer token (its `GAS_STATION_AUTH`). |

A missing or invalid sponsor setting is `503 service_unavailable` for the requests that reach it, including missing service settings at execute.

## Server-built trades

Home Trade calls the sponsor in-process with a transaction kind built by the
server from an account-bound, sealed quote. This path accepts calls to any
contract and does not consult `PRESALE_SPONSOR_SWAP_TARGETS`. The server router
owns fee construction; the sponsor still verifies the caller's wallet,
deployment identity, simulation, gas cap, reservations and shared budgets.
The social trade cap still controls whether Blast pays.

`POST /api/presale/sponsor` does not accept the `trade` intent or a caller's
claim that a transaction was built by the server. The frontend authenticates
to the web server, whose route kit checks browser origin. Only the server
calls the gas pool, using `PRESALE_GAS_POOL_TOKEN`; the pool verifies it against
`GAS_STATION_AUTH` before reading the body. An `Origin` header does not grant
pool access. The pool applies its transaction protections without a contract
allowlist. Client-supplied presale swap-and-commit kinds retain their existing
policy checks.

## Server-built swap-and-commits

Paying for a sale in another coin (SUI into a USDC sale) is one transaction:
the aggregator's swap, then the commit. The aggregator picks its own legs
(Cetus, Bluefin, …), so no fixed `PRESALE_SPONSOR_SWAP_TARGETS` list admits
every route. `POST /api/social/me/commits` builds that kind from the account's
sealed quote and reserves its gas in-process (`sponsorServerCommit`, intent
`commit`), for a Privy account and a wallet session alike. It answers the reservation as
`sponsored`; the browser checks the bytes carry exactly the built kind, signs,
and executes through `POST /api/presale/sponsor/{id}/execute` as usual. This
skips only the contract policy, as for trades: the wallet, deployment,
pause bit, simulation, gas cap, reservations, daily limit and shared budgets
still apply, and the executed commit is recorded as any other (a wallet
session's unlinked).

## Reservation table: `presale_sponsor_reservations` (migration 0042)

The execute route reads and updates this table. Keep its shape stable.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` PK | The `reservation_id` the page holds. |
| `privy_did` | `text` | The caller: `did:privy:…`, or `sui:<sender>` for a wallet session (migration 0162). |
| `sender` | `text` | The caller's wallet, `0x` + 64 lowercase hex. |
| `presale_id` | `text` | As requested. |
| `intent` | `text` | `commit`, `claim`, `settle`, `cancel`, or `reward_claim`. |
| `pool_reservation_id` | `text` unique, null | The retired sui-gas-pool's u64 reservation id. Null in every row since migration 0103; kept for old rows. |
| `tx_bytes` | `bytea`, null while `reserving` | The `TransactionData` the user signs. |
| `digest` | `text`, null while `reserving` | Base58 digest of `tx_bytes`, computed at completion: the sponsored path's pre-submit registration with the account. Indexed. |
| `gas_budget` | `bigint` | MIST. |
| `expires_at` | `timestamptz` | While `reserving`: the claim expiry. From `reserved` on: the same instant as `expires_at_ms`. |
| `pool_deadline` | `timestamptz` | The claim's deadline (claim time + 5 s): until then a `reserving` row may still complete. Set at claim; `sponsorClaimWindow` is its one source, together with the claim expiry. |
| `state` | `text` | `reserving` (claimed), then `reserved` (completed; `reservation_failed` only in rows from the retired pool), then `submitted`, `executed`, `failed_execution`, `unconfirmed`, or `expired`. |
| `effects_status` | `text` null | `success` or `failure`, set together with `gas_used`. |
| `gas_used` | `bigint` null | Net MIST (computation + storage − rebate); may be negative. |
| `created_at`, `updated_at` | `timestamptz` | Default `now()`. |
| `submitted_at`, `completed_at` | `timestamptz` null | For execute. |

- **Open.** `reserving`, `reserved` and `submitted` rows count as open until `expires_at` (`OPEN_SPONSOR_RESERVATION_STATES`).
- **Clock (Q-022).** Every `expires_at` and `pool_deadline` is written and compared with the web route's clock (`clock()` in the route, the `now` argument in the store), never the database's `now()`. Execute must use the same source. Correctness across instances assumes clock skew far below the 110 to 125 s windows; hosting clocks are NTP-synchronized.
- **Bytes.** The CHECKs (migration 0103) make them two-way: `tx_bytes` and `digest` are both null exactly when the state is `reserving` or `reservation_failed`, and both present in every other state. A `pool_reservation_id`, when an old row has one, comes with bytes.
- **`expired`.** Execute writes `expired` when it refuses a `reserved` row at or past `expires_at` (T-018); nothing else does. It is bookkeeping only (the migration comment predates execute). Every reader, including the cap and execute, must compare `expires_at` itself and never rely on the state alone.
- **For execute (T-018/T-019):**
  - Every reader other than the cap must ignore `reserving` and `reservation_failed` rows: they have no bytes. Execute must refuse such a row, for example as `not_found`.
  - Execute acts only on a `reserved` row whose `expires_at` has not passed. It moves it with one conditional update and checks `rowCount`: `UPDATE presale_sponsor_reservations SET state = 'submitted', submitted_at = $3, updated_at = now() WHERE id = $1 AND privy_did = $2 AND state = 'reserved' AND expires_at > $3` (`$3` is the route's clock, as everywhere in this table; waiters on other instances read `submitted_at`).
  - With a `rowCount` of 0, nothing is submitted. Answer from the row's current state (`reservation_expired`, `not_found`, or an already-submitted request). This keeps one winner, so two concurrent execute calls cannot both submit the same reservation.
- **Grants.** `blast_web` has `SELECT, INSERT, UPDATE`. No role deletes a row.

## Refusal counts: `presale_sponsor_refusal_counts` (migration 0042)

The table is `(hour, reason, count)`, with primary key `(hour, reason)`.

- `hour` is the UTC hour. The route sends it as UTC ISO text, and the check is `date_trunc('hour', hour, 'UTC')`, so the session `TimeZone` does not matter.
- `reason` is the policy's reason with object IDs and addresses replaced by `0x…` and numbers by `N`, truncated to 160 characters (`refusalReasonKey`).
- `blast_web` upserts the counts.
- `blast_watcher` has `SELECT`, so the worker host can turn a spike into the `sponsor_target_refusals` alert, for example after a Cetus aggregator upgrade.

## Exports for later tickets

From the modules in `packages/server/src/modules/sponsor/`:

- **Execute (T-018).** `createPresaleSponsorExecuteRoute`, `PostgresSponsorExecutions`, `SponsorExecutionStore`, `createSuiGasPoolExecutor`, `gasPoolExecutorFromEnvironment`, `parsePoolEffects`, `createSponsorTransactionLookup`, `GAS_POOL_EXECUTE_TIMEOUT_MS`, `EXECUTE_CONFIRM_WINDOW_MS`, and `EXECUTE_POLL_INTERVAL_MS`.
- **Store.** `PostgresSponsorReservations`, `SponsorReservationStore` (`open`, `claim`, `complete`, `countRefusal`), `SponsorClaimResult`, `SponsorReservationClaim`, `SponsorReservationCompletion`, `sponsorClaimWindow`, `SPONSOR_CLAIM_WINDOW_MS`, `SPONSOR_RESERVATION_SECONDS`, `SPONSOR_RESERVATION_STATES`, `OPEN_SPONSOR_RESERVATION_STATES`, `MAX_OPEN_SPONSOR_RESERVATIONS`, and `refusalReasonKey`.
- **Chain.** `SponsorChain`, `createSponsorChain`, `simulationOutcome`, and `SponsorSimulation`.
- **Route.** `createPresaleSponsorRoute`, `sponsorConfigFromEnvironment`, `SponsorConfig`, and the `SPONSOR_*` constants.
- **Policy.** The T-015 policy, in `packages/core/src/modules/sponsor/policy.ts`.
- **Intents.** `SPONSOR_INTENTS`, in `packages/core/src/modules/sponsor/intents.ts`: every sponsored intent and its rules. The request schema, service, execute and reservation store derive from it; the reservation table's CHECK constraints are the only other copy, and the sponsor integration test compares them.

The daily budget's non-consuming read is `PostgresRateLimitEnforcer.peek(bucket, subject)` in `packages/core/src/lib/web-security/rate-limits.ts`.

## Utility vesting

Authenticated vesting preparation calls `sponsorService().sponsor` with the
`vesting` intent and an SDK-built and server-authorized kind. This internal `vesting` intent has
no presale ID and is refused by the public sponsor request parser. All existing
caller-wallet, deployment, simulation, gas-cap, open-reservation and shared
budget checks apply, including the daily execution budget. The attempt stores
the reservation ID immutably with the reviewed digest, bytes and expiry. The
Privy wallet signs; the existing reservation execute endpoint co-signs and
submits once. An outside wallet's sign-in session is sponsored the same way and signs the same bytes in the wallet.
