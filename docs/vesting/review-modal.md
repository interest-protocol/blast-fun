# Review vesting refinement — 17 October 2026

Implemented on `codex/vesting-review-modal`, rebased onto develop `fac5e34a` (continuous linear and checkpoint creation).
The approved visual direction is retained in workspace
`outputs/ui/2026-10-17-vesting-review/direction.png`.

## Presentation and interaction

`CreationReview` owns the presentation, extracted from `CreateVesting` without
changing preparation, intent validation, signing, sponsorship or reconciliation.
The action remains “Create vesting in wallet”: execution checks the reviewed
attempt before requesting wallet signing and submitting through the existing
sponsored or wallet-funded path. A synchronous guard also prevents repeated
confirmation calls before wallet state updates.

The review emphasizes the exact amount, then recipient, release schedule,
cancellation roles, gas payer and action. Whole-digit grouping operates on the
existing string-safe formatter; fractional digits and unknown-metadata atomic
amounts remain exact. Coin identity stays visible, with its technical type in a
compact disclosure that cannot grow unbounded when a struct name is long.

`ReviewIdentifier` uses the existing `CopyButton` for all three distinct wallet
roles and the coin type. Native disclosures expose selectable full values on
keyboard and touch. Each separate 44px copy control has a role-specific label
and hover/focus tooltip. Only an acknowledged clipboard write produces the
existing check and polite success announcement. Failure clears success and
provides an inline explanation and manual-copy recovery. Copying never submits
the form or invokes a transaction.

Continuous schedules reuse `linearReleaseSummary`, showing first claimable,
cliff and fully vested instants with exact atomic rounding. Historical stepped
schedule counts retain cliff catch-up and skipped zero-atom releases. Custom payouts remain differences between cumulative
amounts using bigint. All times are UTC, labelled once. Cancellation consequences remain visible, while a disclosure
explains the transferable CancelCap, its initial recipient, and the fixed
refund destination.

The scoped Sheet is 550px on desktop and uses the existing bottom sheet on
mobile. Header and footer sit outside one scrolling region, which has an
explicit remaining-content hint. Amounts and full identifiers wrap; details
stack below 370px. The footer keeps gas, errors and the 44px primary action
accessible in short windows. Existing dialog focus management, Escape,
scroll lock and motion remain in use. Copy press motion is disabled for
keyboard input and reduced-motion preferences.

## Verification

After integrating develop’s continuous-vesting change, all checks and desktop/mobile
component and form captures were refreshed. The new regression checks cover
continuous first-claimable/fully-vested instants and historical effective release
counts through cliff catch-up.

- 50 affected tests passed: new review/clipboard tests plus existing creation
  model, summary, transaction-construction and reviewed execution tests. Coverage includes exact precision through
  u64, atomic fallback, DST, cliff/single/custom releases, role separation,
  clipboard success/failure/recovery, wallet refusal, expiration and original
  digest reconciliation.
- Scoped ESLint and the full web TypeScript check passed. React Doctor reported
  100/100 for changed files. `git diff --check` passed.
- Actual components and Blast CSS passed Chromium fixture checks at 320, 407,
  768, 1054 and 1414px widths, plus 500px short windows. No page, modal or body
  horizontal overflow; footer and close stayed accessible. Custom schedules
  use the same body scroller. Long names/types, large amounts, unknown metadata,
  equal/different roles, cancellation off, cliffs, and wallet-paid gas passed.
- Browser checks covered all four full clipboard values and stable control
  width, denied clipboard recovery, keyboard/touch disclosures, focus tooltips,
  focus containment, Escape/focus restoration, reduced motion and duplicate
  confirmation prevention. The actual form retained its draft across fixture
  preparation failure/retry and wallet rejection on desktop and mobile.

The evidence directory includes comparable before/after desktop and mobile
screenshots, stress captures, replay harnesses and machine-readable results.
These render actual source components against unsigned fixture data, omit the
application shell, and use the system font fallback outside Next's font loader.
The live URL returned HTTP 403. Authenticated production integration, real
wallet dialogs, signing/submission, physical devices and Safari were not
verified. No transaction was signed or submitted, and these changes have not
been deployed.

## Required pre-PR migration rehearsal

`npm run db:migrate` ran twice against task-owned disposable PostgreSQL 18 at
`127.0.0.1:34888/vesting_review_pr`, initialized with the repository
`chain_read_v1` fixture. The first run applied all migrations through
`0120_vesting_sponsorship`; the second reported “Mission Control database is
already current.” Migration login `postgres` and separate runtime login
`vesting_review_runtime` were used. The runtime login, holding `blast_web`,
passed insert/read/update checks in a rolled-back transaction. The temporary
container and its memory-backed data were removed. No release database was
modified, and this PR adds no schema migration.

## Follow-up refinement — 18 October 2026

The Uniswap-inspired refinement on `codex/vesting-review-restraint`, based on
`0c441bac`, keeps the existing review flow and makes the asset the visual anchor:
44px shared coin mark, 40px desktop amount (34px on mobile, 30px at 320px), quieter
metadata, and plain rows with light dividers instead of filled containers.
The exact amount retains its accessible symbol. Shorter copy preserves funding,
immutability, cancellation roles and gas-payer information. Atomic rounding is
explained alongside the exact UTC timestamps.

`ReviewDisclosure` uses the installed Base UI Collapsible for full identifiers,
UTC timestamps and cancellation help. Its measured height, opacity and chevron
use the shared 200ms/ease tokens; reversals can interrupt the transition.
Keyboard interaction and reduced motion are immediate. Copy remains a separate
44px action and full values remain selectable.

Verification: all 50 affected tests, web TypeScript, scoped ESLint and React
Doctor (100/100) passed. Chromium source-component fixtures cover desktop and
mobile widths 320, 407, 768, 1054 and 1414px, short windows, expanded identifiers,
real clipboard writes, denied clipboard recovery, touch emulation, keyboard
focus/Enter/Space/Escape, reversal and reduced motion. Evidence and replay code
are in workspace `outputs/verification/2026-10-18-vesting-review-restraint/`.
This follow-up has not been deployed or checked with a real wallet or physical
mobile device; fixture data is unsigned and no transaction was submitted.
