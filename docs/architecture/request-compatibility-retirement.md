# Prelaunch request compatibility retirement

Local follow-up to #59. The [Bun backend](../../apps/backend-api/README.md#source-organization)
owns public reads and admin controls. It uses Effect HTTP contracts and a Bun
transport. Existing hot chain reads remain in Rust memory. Private request
shapes and stored-data converters have separate retirement checks.

## Stateless request adapters

- [x] Commit builds accept only `pay_with: "QUOTE"`. The server derives the exact quote asset from the sale's on-chain type; USDC, SUI and other supported quote assets remain usable. The current browser submitter already sends `QUOTE`. The published request JSON Schema accepts the same canonical value. Retired `USDC`/`SUI` selector payloads now receive `400 invalid_request` before chain reads. Balance, allowlist, sealed swap, fee and sponsorship checks retain their owners.
- [x] Follow verification accepts only `{ "action": "verify-follow" }`. The unused member OAuth `accessToken` request field is rejected. The current client sends no such field; authenticated member identity, origin, CSRF, rate limits and worker dispatch remain unchanged.
- [x] Focused local acceptance: 76 tests pass with no skips, covering canonical/retired request boundaries, actual transaction-kind construction against offline chain doubles for USDC/SUI/TSUI, exact-quote balances, swap-output identity, fees, session refusal, CSRF and follow-worker dispatch. See the task verification artifacts for source hashes and measured memory.
- [x] The prior source-bound physical commit suite passed all 12 cases using canonical payloads while preserving asset/swap policy coverage. The current follow-up requires a fresh 71-case migration/Create/commit/X replay and applicable full checks; earlier passes do not certify changed source. A local pass is not hosted or production approval.

No signed transactions or hosted services are needed for these checks.

## Canonical stored drafts and explicit recovery

The application parser, request schema and normal PostgreSQL/browser read paths now accept canonical recipient fields only. Retired `cliff_months` and `months` keys are confined to the explicit offline normalization artifact, migration and synthetic tests. The canonical unit value `"months"` remains valid and means exactly 30 days.

Migration `0130_social_recipient_drafts` changes only saved draft bodies, retaining owners, IDs, revisions, timestamps and publication facts. Its bounded transaction refuses ambiguous/malformed recipient representations and leaves canonical bodies unchanged. An initial `ACCESS EXCLUSIVE` lock avoids a reader-to-writer lock-upgrade deadlock. Full-body retained-data validation remains a separate mandatory preflight, and hosted execution is outside this local task. See the [migration and rollback runbook](recipient-draft-migration.md).

The versioned guest format uses explicit export/import/adoption; it does not run an old-shape parser in the browser. Retained raw copies stay available until the matching adopted copy has an acknowledged account save. Recovery/storage failures offer a separate draft without overwriting backups; that choice explicitly pauses browser saving. Partial cleanup is recorded before removal so a saved backup cannot silently become another draft.

Focused tests and disposable PostgreSQL runs establish only their exact synthetic source-bound scope. Actual retained database inventory, old sleeping browser tabs, full preflight enforcement and verification of an exact rollback artifact remain release gates. No retained account or session is recreated to satisfy them.

## Preservation and release acceptance

Existing accounts, session cookie formats, wallet identity, API key identities, policy tiers, quota namespaces/counters and audit/revocation facts must remain intact. A request parser cleanup must not create a new account, sign out an existing session, reset a quota or relax sealed transaction validation.

Historical SQL migrations and the durable `card.shared.v1` reward receipt key are identity/history constraints, not obsolete runtime aliases; changing them would risk duplicate rewards or invalid migration history. Stored avatar rendering upgrades also remain a separate stored-data decision. Canonical `/@callsign` profile rewrites and thin Next private session/mutation transport adapters are current product routing, not public partner aliases.

Keep all verification local until hosted verification is explicitly authorized. Bind full release, database recovery, authenticated quota/load and reviewer evidence to the final source. Distinguish canonical-only runtime code from the separate retained-data cutover gate; the latter remains open until authorized inventory, preflight and postimage checks complete.
