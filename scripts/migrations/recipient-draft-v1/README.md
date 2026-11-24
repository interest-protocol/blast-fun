# Recipient draft v1 offline normalization

This pure helper prepares the saved-recipient retirement. It is an offline
migration artifact, outside production request and browser dependency graphs.
The application parser and published schema accept canonical recipients only.
This directory does not migrate a database or inspect any retained browser data.

Pass only the decoded JSON **draft body**, never a database record or guest
storage envelope:

```ts
import { normalizeRecipientDraftV1 } from "./normalize.ts";

const { body, changedRecipients } = normalizeRecipientDraftV1(decodedBody);
```

The normalizer has no I/O. The separate explicit `recover.ts` CLI reads one
operator-selected export and exclusively creates a private recovery file. There
is no database connection, environment loading or application apply action.
The caller retains responsibility for raw input,
authorized scope, size bounds, serialization and protected output handling.
Inputs are ordinary decoded JSON objects, not executable objects or proxies.

The helper converts only exact six-key recipient rows in `token_recipients` and
`raise_recipients`: `cliff_months` becomes `cliff`, `months` becomes `duration`,
and both units become explicitly `"months"`. One month remains exactly 30 days.
Canonical recipients, explicit units and omitted canonical units remain raw and
unchanged. The helper retains order, counts, allocations, zero/disabled schedules,
unfinished drafts and safe integers. Mixed old and canonical rows are supported;
mixed grammars within one row are refused.

Validation uses the existing canonical contract semantics after conversion,
without serializing the parser's result. No unrelated default is inserted and
no amount, address, fee, quote, link or text is normalized. Canonical-only bodies
return the original object. Changed bodies share unchanged values by reference;
the helper never mutates its input. Callers must not mutate shared values while
using either body. JSON whitespace, key formatting and an original raw string
are outside this decoded-body API; retain those separately when needed.

To prepare a retained guest export for canonical import, run from the repository
root with a **new** output path:

```sh
node --no-warnings --import ./scripts/test-tsx-hooks.mjs \
  --experimental-strip-types scripts/migrations/recipient-draft-v1/recover.ts \
  /private/blast-retained-draft.json /private/blast-recovered-draft.json
```

The CLI accepts at most 1 MiB of strict UTF-8 JSON, retains the input, refuses
existing output paths, and creates output with mode `0600`. Its canonical
envelope includes schema `blast.social-create-guest-draft`, version `1`, the
normalized draft, and `recovered_from` containing SHA256 of **all** original
source bytes (including whitespace). The browser refuses a missing/mismatched
source receipt. Do not edit or trim the export before converting it. Inspect
the prepared file locally, import it through the explicit recovery screen and
confirm adoption. Keep the export until the adopted account draft has saved.
The CLI prints hashes/status only; a refusal never prints draft content.
An interrupted output write can leave a partial new file: retain the source
and select a different output path rather than assuming a usable result.

Malformed or ambiguous data throws `RecipientDraftNormalizationError` with
`code: "recipient_draft_v1_invalid"` and a field path. Diagnostics contain no
draft values or chained error. The helper validates shape, not publish readiness:
an unfinished draft stays unfinished, and invalid publish terms are not repaired.
Record IDs, owners, versions, timestamps and publication facts must be retained
outside this API and never rewritten by a later representation migration.

The root `npm test` runs these tests. To run only them, from the repository root:

```sh
node --no-warnings --import ./scripts/test-tsx-hooks.mjs \
  --test --test-concurrency=1 --experimental-strip-types \
  scripts/migrations/recipient-draft-v1/normalize.test.ts \
  scripts/migrations/recipient-draft-v1/recovery-file.test.ts
```

The tests freeze the pre-retirement 30-day interpretation independently of old
runtime parsing, cover every canonical unit and check production source for
imports/exports of this artifact. They do not inventory a real database or guest
sessionStorage or prove a retained-data cutover. The isolated CLI tests use only
owned synthetic files. Database migration/rehearsal, browser interaction and
account/session/quota preservation evidence have separate gates. No hidden
runtime fallback to this helper is permitted.
