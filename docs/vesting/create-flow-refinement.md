# Create vesting refinement — 17 October 2026

Implementation: `codex/vesting-flow-polish`, based on `7ed5b5e3`.
The changes are local and have not been deployed. Home, the carousel, shell,
shared navigation, contract arguments and sponsorship policy are unchanged.

## Preparation diagnosis

A read-only reproduction of the generic preparation failure exposed an SDK
gas-selection failure.
A read-only mainnet reproduction used AFTEST (9 decimals), exactly
`124968397.112711982` tokens (`124968397112711982` atoms), one daily release,
zero cliff, a start one hour after the chain clock, and the same address for
recipient, refund and cancellation authority.

The tested AFTEST holder had no usable SUI. Building the unsigned transaction
failed before simulation with the SDK's insufficient-SUI gas-selection error;
the estimated budget was `3551871` MIST (`0.003551871` SUI). The same unsigned
construction simulated successfully when a separate funded gas owner was set
for diagnosis. There was no signature, transaction execution, transfer or gas
payment. Diagnostic gas ownership is not application sponsorship.

This isolates gas funding as the cause of the reproduced failure. The selected
holder's indexed AFTEST balance was exactly four times the reported amount,
consistent with a 25% selection and strongly linking the reproduction to the
reported amount. The
original authenticated request and historical failure log were unavailable,
so the historical incident cannot be conclusively attributed to that wallet.
The deployed team gate prevented an authenticated browser reproduction.

The app now returns a recognized `insufficient_sui_gas` reason from the actual
build boundary, shows available SUI, and explains that the sender must add SUI
before retrying. It retains the draft. Unknown failures retain a generic retry
message with a request reference. Server diagnostics include stage, network,
action, reason, error type and structured execution kind/command when present;
they omit raw RPC messages, credentials, wallet addresses and transaction bytes.
Funding a wallet remains an external prerequisite; no funds were added.

## Interaction decisions

- One wallet-address pattern provides an icon button per role and an explicit
  own-wallet status. The combined cancellation shortcut is an editing action.
  Account changes clear review and preserve every entered address.
- Cancellation is explained by its payouts. The contract pays
  `vested_total - released` to the recipient and the remaining balance to the
  fixed refund recipient. Prior claims are not paid twice. Transferable
  capability terminology lives in secondary help. Disabled roles are omitted
  from the intent while their draft values remain available when toggled on.
- All schedule times are UTC. The date is a react-day-picker calendar in the
  shared popover, with arrow-key navigation, Escape and focus return. The time
  is a native time input. Both schedule modes use the same control. Invalid
  calendar times such as 30 February are refused, never rolled over. Review
  shows UTC dates. Dates are never advanced automatically.
- Spacing groups the editable form; a single raised summary anchors review.
  Existing Blast typography, pink, buttons, switch and segmented controls stay
  consistent with Home. The summary stops sticking in short viewports and
  follows the form on narrow screens with bottom clearance.
- Compact amounts are display-only bigint formatting. Exact strings and atomic
  totals remain unchanged, and review shows the exact locked amount. A single
  payout has one release-date row and singular grammar. The contract's first
  nonzero release occurs after an interval, or at a later cliff; zero-atom
  early steps and cliff catch-up use the existing SDK-derived projection.
- Preparation, review, status checking, wallet approval, submission and
  confirmation have distinct feedback. Input errors appear once at their field
  and receive focus. Edits, account changes and expired reviews invalidate
  prepared data. Review alone never calls signing or execution.

## Verification

Scoped ESLint and web TypeScript checks passed. The four focused test files
passed **21 tests**, covering exact amounts, SUI reserves, custom allocation,
contract release boundaries, cliffs, address policy, DST, compact displays and
sanitized preparation reasons. React Doctor reported **100/100** for changed
files.

Browser verification rendered the actual before/after components and Blast
styles with mock balances and an unsigned preparation fixture. The fixture has
no real signer or executor. It covered each wallet shortcut, combined filling,
manual addresses, account switching, disconnection, cancellation preservation,
inactive intent roles, distinct roles, regular/custom dates, single/multiple
releases, large amounts, Max, precision errors, past/expired dates, expired
review, failure/retry, draft restoration and fresh intent after edits.

Keyboard calendar navigation, date/time typing, Escape/focus return, Lisbon
DST gap/overlap selection and layouts at 1440, 1024, 768 and 407 pixels passed.
The calendar stayed inside the viewport; pages had no horizontal overflow.
The harness required a standards-mode doctype for correct overlay positioning.
This was a harness defect, not a product positioning change.

Screenshots and replay fixtures are under workspace
`outputs/ui/2026-10-17-vesting-flow/`. These isolated captures omit global
navigation and use fallback system fonts where Next's font loader is absent.
The live authenticated page, final wallet approval, submission and deployment
were not tested. No real vesting was created.
