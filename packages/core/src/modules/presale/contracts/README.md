# Presale contracts

This folder is the published presale payload contract. It implements the presale interface contract, **revision 2 with section 7 clarifications** (CL-1 to CL-29). That file stays outside version control at:

`/home/ubuntu/blast-v2/web/docs/product/presale/interface-contract.md`

Both presale workflows build against this folder:

- the frontend's mock client;
- the web API routes;
- blast-infra's presale routes and topics, which vendor `schemas/` for their response tests.

**A payload change is a contract amendment, not an edit.** Propose it in one workflow's run record, have the other workflow accept it, then change the types, schemas, examples, and variants together. The contract test fails if a schema branch, including an enum value, has no typed value.

## Contents

| Path | Holds |
| --- | --- |
| `wire.ts` | Wire primitives and `Wire<T>`, which derives a field type from the SDK name it mirrors |
| `read-path.ts` | blast-infra `/v1` responses and `/v1/ws` presale messages (sections 2.1–2.4, CL-1–CL-4, CL-14, CL-20, CL-26, CL-28, CL-29) |
| `web-api.ts` | `/api/presale/*` and `/api/account/*` requests and responses (sections 3.1–3.8, CL-5–CL-9, CL-15) |
| `errors.ts` | Every error code, with its HTTP status, `Retry-After` flag (CL-23), and one body type |
| `routes.ts` | `PRESALE_ROUTES` and `PRESALE_TOPICS`: each route's query parameters, schemas, and error codes; `PresaleSchemaTypes`, which gives the one type of each schema |
| `examples.ts` | `PRESALE_EXAMPLES`: one typed example per schema, for tests, fixtures, and the mock client |
| `variants.ts` | `PRESALE_VARIANTS`: typed payloads for every branch the examples do not reach, such as a migrated or cancelled projection, a replayed `lifecycle` without its projection (CL-26), `fast: null`, a failed transfer, and every sponsor intent |
| `validate.ts` | `createPresaleValidator()`: Ajv 8 (draft 2020-12) over `schemas/`. It is Node only, and `ajv` is a dev dependency; import it in tests and tooling only |
| `schemas/` | One JSON Schema per payload, `schemas/errors/` one per error code, and `defs.schema.json` for shared definitions |
| `schema-branches.ts` | Test support: every branch in `schemas/`, and the ones a payload reaches. A branch is an `anyOf`/`oneOf` alternative or a member of a multi-value `enum`; the four enums tied to SDK lists are exempt |
| `contracts.test.ts` | Validates every example and variant, and requires them together to reach every schema branch. It also rejects each example once a required field is removed, and checks completeness, the SDK enumerations, `Retry-After`, the route error lists, and that the published files (`wire.ts`, `read-path.ts`, `web-api.ts`, `errors.ts`, `routes.ts`) stay browser-safe |

Each schema's `$id` is `https://blast-v2.invalid/presale/contracts/<path under schemas/>`. Its references are relative to that `$id`, so a vendored copy of `schemas/` resolves without this repository.

## Wire rules

- **u64 values (CL-11).** Every on-chain u64 is an unsigned decimal string. That covers atoms, bps, `participants`, `leaf_count`, `number`, `index`, `next_round`, and `max_participants`.
- **JSON integers.** Only these fields are JSON integers: `*_ms`, every checkpoint, `tick_spacing`, and off-chain counts (`entry_count`, `claimed_count`, `claimed_wallets`, `remaining_wallets`, `eta_seconds`, row numbers).
- **Fee rates.** `fee_bps` is Circle's rate, possibly fractional (`"1.3"`). `gas_used` is net MIST and may be negative.
- **Addresses** are `0x` plus 64 lowercase hex characters.
- **Hex values without `0x` (CL-15).** Allowlist and reward roots, the reward `manifest_digest`, and proof entries are 64 lowercase hex characters without `0x`. Sui transaction digests are base58.
- **Coin types** are canonical.
- **Cursors (CL-12).** A `cursor` is a blast-infra event cursor, `<checkpoint>:<tx_slot>:<event_slot>:<part>`. `next_cursor` is an opaque page token, except on the commitments log, where it is the next page's `before`.
- **Errors (CL-10).** The body is `{ "error": { "code", "message" } }`. Route-specific fields sit inside `error`: `move_abort`, `reason`, `digest`, and `rows`. `dry_run_failed` names a presale-package abort, or has `move_abort: null` with `reason` `gas_cap_exceeded` or `external_abort` (CL-19).
- **`Retry-After` (CL-23).** It is a response header only. Error bodies never carry `retryAfterSeconds`, and the error schemas are closed. Every 503 code, `rate_limited`, and `budget_exceeded` carry it. `budget_exceeded` names its budget in `error.reason` (CL-25): `daily_limit` until the next UTC day, or `open_reservations` until the earliest open reservation expires.
- **Parameters (CL-21).** A malformed path or query parameter on a web route is `invalid_parameter`. The kit's `invalid_request` is for request bodies.
- **WebSocket (CL-20).** Only `snapshot` carries `topic`. A log message has no `topic`, reaches a connection once however many subscribed topics match, and is routed by `presale_id` (or `presale.presale_id`). A client drops a repeated `cursor`.
- **Snapshot or its absence (CL-28).** On first subscribe and after `resume_complete`, each `presale:<id>` gets exactly one `snapshot` or one `snapshot_unavailable` (`ws-presale-snapshot-unavailable`, closed) with `topic` and `reason`: `not_found` (the server does not know the sale; HTTP answers 404) or `unavailable` (it cannot render it; retry HTTP with backoff). The topic stays subscribed and live messages flow once the sale exists. A client's stale indication clears only on a `snapshot` or a successful HTTP read.
- **Claim totals (CL-29).** `claimed` carries `totals`, the same object as `committed.totals`; clients replace their projection totals from either.
- **Resume (CL-26, CL-27).** A log message replayed on resume carries `replayed: true`, and every `ws-presale-*` log schema accepts it; a snapshot never carries it. A replayed `lifecycle` may omit `projection`, and a client never applies state from it. After `resume_complete`, which carries `cursor: null` when nothing was replayed, the client replaces its state from what follows for each resumed `presale:<id>` (CL-28, above). The presale and market streams each need their own resume cursor; a resume naming both kinds of topic gets `resync_required` (`too_old`).
- **SDK names (CL-13).** No wire type redefines a field the SDK names:
  - Field types come from the SDK through `Wire<…>`, `WirePick<…>`, and `EventFields<…>`. The sources are `PresaleProjection`, `PresaleCommitment`, `PresaleVaultProjection`, `PresaleFeePolicyState`, `PresaleCreationPolicyState`, `ProtocolFees`, `EligibilityPolicy`, `UncappedPhase`, `UncappedAccess`, `Allowlist`, `AllowlistProof`, `AllowlistEntry`, and `PresaleEventPayloads`.
  - `lifecycle` is `Lowercase<PresaleLifecycle>`, `move_abort` is `PresaleAbortName`, the venue is `PresaleVenue`, and the eligibility kind is `EligibilityPolicy["kind"]`. `PRESALE_VENUES` and `PRESALE_ELIGIBILITY_KINDS` list them exhaustively, and the test ties the schema enumerations to them.
  - The manifest route is `RewardManifest & { accounting }`. Reward proofs reuse `RewardProof["proof"]`.
  - `CommitPreview` and `PresaleState` remain the client-side runtime types; neither is a wire payload.

## Using it

`account-settings.ts` is the Zod source for `PUT /api/account/settings`; its
TypeScript type is inferred and re-exported by `web-api.ts`. Import the schema
directly for runtime validation; the general contract entry remains free of
runtime validator imports. Regenerate its committed draft 2020-12 artifact with
`npm run contracts:generate -w @blast/core`. `npm run contracts:check -w @blast/core`
(also run by core's test command) rejects stale output. Generation preserves the
published schema bytes, including its `$id` and enum layout. Ajv stays in dev
tooling to check the JSON contract independently; response schemas remain hand-authored published contracts. Runtime backend
response parsers use Zod without rewriting those independent artifacts.

`outcome-request.ts` owns the wire type and request validation for outcome
registration and commitments. Generation retains the existing `defs.schema.json`
references and generates its `address` and `digest` definitions from `primitives.ts`;
the remaining definitions are still hand-authored. `outcomeSubmissionSchema`
preserves the handlers' narrower 43–44 character digest rule and canonical address
check, while the published wire schema keeps its existing 32–44 character range.
The JSON artifacts remain byte-for-byte compatible. Ajv checks both contracts
independently in dev tooling.

`execute-request.ts` owns the sponsor execute wire type and request validation.
Generation retains the published `base64` reference and generates that shared
definition from `primitives.ts`. `executeSubmissionSchema` also checks canonical
padding and pad bits using the existing decode/re-encode rule; the published
wire schema keeps its broader base64 pattern. The route still verifies the
signature cryptographically and enforces its 16 KiB body limit separately.
Ajv remains in dev tooling, and the generated JSON artifacts retain their bytes.

`allowlist-request.ts`, `sponsor-request.ts`, and `bridge-transfer-request.ts`
complete the seven published request contracts. Types are inferred from Zod;
generation preserves the published references and the sponsor conditional layout.
Submission schemas retain stricter runtime checks, including canonical base64,
positive u64 bridge amounts, and source-specific transaction hashes. The shared
`address`, `digest`, `base64`, `coin_type`, and `uint` definitions are generated
from `primitives.ts`; the remaining definitions stay hand-authored. Independent
Ajv tests compare wire acceptance across valid examples and malformed payloads.

```ts
import type { PresaleListResponse } from "@blast/core/modules/presale/contracts/read-path.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts"; // tests and tooling only

const validator = createPresaleValidator();
validator.validate("presale-list", body); // { valid, errors }
const list: PresaleListResponse = validator.parse("presale-list", body); // throws on a violation
const { parse } = createPresaleValidator(); // destructuring works too
```

The schema names are the paths under `schemas/` without `.schema.json`. `PRESALE_SCHEMA_NAMES` lists them, and `PRESALE_ROUTES` maps each route to its query parameters, its request schema, its response schemas by status, and its error codes. A response schema of `null` marks a body that is not JSON: receipts return `image/png` (CL-9). The allowlist CSV upload is `multipart/form-data` with a `file` part (header `wallet,cap`) and a `quote` field (CL-6c). Control messages on `/v1/ws` reuse blast-infra's `ws_*` messages unchanged.
