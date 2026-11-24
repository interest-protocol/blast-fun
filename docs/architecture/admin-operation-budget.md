# Partner administration operation budget

The complete partner-key write has one eight-second budget. It starts at HTTP admission (before body/auth work), or at `PartnerRecognition.write` for a CLI caller. An optional coalesced recognition handshake, primary checkout, the five-second advisory-lock wait, snapshots, mutation, Redis publication and SQL completion all consume that same budget. The lock wait is inside the eight seconds; it is never added to them.

| Boundary | Budget | Owner |
| --- | --- | --- |
| Admin body | 4 seconds maximum | Existing bounded transport body reader |
| Complete recognition operation | 8 seconds, including any body time | `PARTNER_ADMIN_OPERATION_MS`, request-work signal and transaction cancellation |
| Backend response | 9 seconds from admission | `PARTNER_ADMIN_HTTP_MS`, one second for the result |
| Authenticated native socket | 19 seconds idle | Existing authenticated-work callback, HTTP budget plus ten seconds |
| Independent admin-console relay | 10 seconds | Existing relay in `admin-acl/api/admin/partner-keys.ts`; matches `PARTNER_ADMIN_RELAY_MS` |

The backend constants live in `packages/core/src/modules/backend-api/admin-budget.ts`; the `partner-keys` row of `OPERATOR_ROUTES` applies them. The separately deployed admin relay already allows ten seconds and needs no source change. Short, malformed or unauthenticated bodies receive no longer body/socket allowance.

Transaction cancellation destroys a checked-out PostgreSQL connection; a checkout that finishes after cancellation is returned without running a statement. Each transaction operation checks cancellation before issuing another statement and before COMMIT. A shared recognition handshake may also be owned by the independent recovery loop: a timed-out issuer stops awaiting it and cannot proceed to mutation. Request slots remain occupied until actual handler/tracked work settles. Readiness and the Redis epoch are rechecked immediately before mutation.

A connection loss during COMMIT can still have an ambiguous result. The operator must refresh, revoke a key whose secret was not displayed, and issue another. No raw secret is cached or replayed to hide this ambiguity.

# Withdrawal settlement

A missing burn lookup, even after local signing freshness expires, retains the built/submitted state. Only a proven executed result can fail or confirm the burn, with the existing exact event matching. Existing terminal expiry rows are unchanged: repairing them requires authoritative evidence, both ledger guards, retained history and a separately reviewed repair procedure. No live repair or migration is part of this change.
