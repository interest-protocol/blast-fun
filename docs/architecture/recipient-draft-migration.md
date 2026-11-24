# Recipient draft representation migration

This implementation is for local verification; any retained-data cutover is a separate authorized operation. Local fixtures do not establish the contents or migration status of any retained database or browser draft. Do not infer an empty production table from synthetic fixtures.

The intended migration is `0130_social_recipient_drafts`. It retires the saved recipient aliases `cliff_months` and `months` in both `token_recipients` and `raise_recipients`. An exact old recipient contains only `label`, `address`, `bps`, `vest`, `cliff_months`, and `months`. Its replacement retains the first four values, renames the last two to `cliff` and `duration`, and adds `cliff_unit: "months"` and `duration_unit: "months"`. One month remains exactly 30 days. Disabled vesting and unfinished form values retain their original meaning.

Canonical rows, including omitted optional units and explicit non-month units, remain JSONB-equal. Separate old and canonical rows may coexist in an array. A single row mixing their keys is ambiguous and must be refused. No unknown fields, malformed arrays, unsafe or negative integers, invalid units or oversized transformed bodies may be silently repaired.

## Before a retained-data cutover

1. Obtain authorization for the exact database. This local implementation is not authorization to access or migrate hosted data. Identify the migration connection and runtime writer deployment without publishing credentials.
2. Run a read-only inventory of all drafts, including published drafts. Validate each complete body through the offline `scripts/migrations/recipient-draft-v1/normalize.ts` helper. That helper validates the normalized body with the current canonical parser but returns patched raw data, so unrelated defaults and link normalization are not serialized. Collect aggregate row/recipient counts and protected fingerprints. An invalid body stops the cutover; it must not be replaced with a blank draft.
3. Keep exact preimages privately, keyed by draft ID and version, along with every non-body column and the expected postimage. These contain user content and must not be included in public logs or review artifacts. The migration ledger proves schema application, not the absence of unresolved browser drafts.
4. Rehearse on an owned disposable PostgreSQL instance using the full migration chain, synthetic malformed rows, a concurrent writer and the actual authenticated Create routes. Complete the source-bound no-skip checks before retained-data execution. Use one bounded runner and the shared host memory guard.
5. Briefly stop Create mutations for cutover and verify old server writers cannot resume afterward. Apply the reviewed new migration through the normal checksum-protected migration runner. Never edit historical migrations or bypass their checksums. The migration must recheck recipient grammar under an initial `ACCESS EXCLUSIVE` table lock; this briefly blocks reads as well as writes and avoids upgrading a weaker lock while a reader becomes a writer. Advisory migration locking alone does not exclude ordinary draft saves.
6. Re-inventory the exact database scope after commit. Compare the ID set, all non-body values and canonical-only bodies with preflight. Verify zero old recipient keys remain and record the migration checksum. A timeout or unknown result requires checking the ledger and postimages before retrying; never assume that a disconnected client means rollback.
7. Deploy the matching canonical-only parser/schema and explicit guest recovery behavior, then resume mutations. Keep the prior release artifact in deployment history for rollback; do not retain an old runtime path in this codebase. Before identifying any retained artifact as rollback-compatible, test that exact artifact against canonical recipient fields and the post-migration constraint. This prerequisite has not been proved for a hosted prior release; otherwise roll forward with a reviewed compatible artifact. The normal GET/PUT/publish paths must not perform conversion or invoke the offline helper.

The current migration runner does not enforce a full-body preflight receipt. Completing and recording steps 2–3 is an explicit operator release gate; a migration-ledger entry alone cannot close it. No retained-data cutover is approved by the local tests.

The SQL migration validates the recipient portion under the lock. Full non-recipient draft validation belongs to the mandatory offline preflight and canonical runtime parser; duplicating the entire form parser in SQL would create another contract to maintain. If real data cannot fit the bounded transaction, stop and design a separately reviewed migration strategy. Do not remove timeouts or assume the table is small.

## Preservation and rollback

Only `body` may change. Preserve `draft_id`, `account_id`, optimistic `version`, `created_at`, `updated_at`, logo, allowlist, quote/detail columns, cover fields, `published_presale_id`, and `published_at`. Timestamps retain database precision. Advancing `updated_at` would change draft-list cursors and whether an older draft resumes after a publication. Advancing `version` would consume a user save revision for a representation-only change.

The durable constraint rejects the old key names; it never converts requests and is not a replacement full draft validator. A stale writer must fail rather than recreate old data. No permanent SQL conversion function or trigger is introduced.

The down migration removes only that constraint. It deliberately retains semantically equivalent canonical bodies. Blindly reversing field names would corrupt rows that were already canonical or subsequently edited. If exact data restoration is explicitly required, compare the current body, version and all relevant metadata to the protected recorded postimage before restoring its particular preimage in a guarded transaction. Any mismatch stops restoration for review. Never overwrite a later user edit.

## Browser scope

The affected Social Create guest data is the unversioned `sessionStorage` key `blast:create:guest-draft`. Server migration cannot discover it. Guest recovery is a separate explicit export/import flow which preserves unresolved raw data and accepts only canonical input into normal runtime state. Unknown sleeping tabs remain possible after rollout. The recovery screen offers export, explicit canonical import and a separate draft without overwriting either backup. A separate draft pauses browser persistence until the retained copies are resolved or account saving is available. Adoption is blocked during publishing/uploads. Account-save acknowledgement is tied to the exact adopted copies; a durable digest receipt prevents a partially removed backup from being offered as another draft. If browser writes are entirely unavailable, keep the backups and report the failure rather than claim durable cleanup.

Do not touch the unrelated launchpad `localStorage` keys `blast:launchpad:launch-draft:v2` or its archive. Their transaction/approval history is outside this migration. Account/session records and quota identities/policies are likewise unchanged.

## Required local evidence

- Full migration chain, published/unpublished/mixed/canonical rows, both recipient arrays, all units and unfinished schedules.
- Exact metadata/timestamp preservation, canonical body identity, once-only ledger behavior and refusal of stale old-format inserts/updates.
- Atomic refusal for ambiguous/malformed rows and transformed-size overflow, with no body, ledger or constraint partial commit.
- A blocked migration times out without damage; a writer blocked by the migration resumes against the new constraint, preventing a lost update or old-format reintroduction.
- Repeated authenticated GET does not write. A migrated version 7 remains 7, one true save becomes 8, its retry stays 8, a stale different save conflicts, and unauthorized/other-owner access remains denied.
- Down removes only the constraint; it preserves canonical data. Reapplying up does not rewrite canonical bodies.

Record actual results and exact source hashes separately. Until those runs finish, this document describes required behavior, not runtime proof or deployment approval.
