# Shared backend logging

`logging.ts` configures Pino 10.0.0, already present in the workspace lockfile,
as a direct core dependency. `recordMetric` and the worker's `redactingLog`
use it without changing their call signatures or the `MISSION_CONTROL_METRICS`
switch. Lines retain `metric`, ISO `at` and scalar fields, and add Pino's numeric
`level` (30 for info, 50 for fatal worker error paths). Fatal worker logs still
write synchronously to stderr, including when metrics are disabled.

Pass counts, booleans and short labels only. Use `errorLabel(error)` for caught
errors; never pass a raw exception, request, SDK object or provider response.
The wrapper drops non-scalar values and protects the logger's reserved fields.
Pino redacts configured credential field names. Worker-supplied secret values,
Sui private keys and URL user information are redacted in string values before
JSON encoding, including strings containing quotes or newlines. Arbitrary strings
can still contain unknown secrets; path redaction does not sanitize error messages.

The metrics module is also used by browser read clients. Core's `#metric-log`
import condition selects `logging.browser.ts` for them, which erases its type
imports and writes nothing. Pino stays out of these client bundles; its own browser
entry is also disabled as a fallback for direct imports. No transport thread,
file destination or asynchronous buffer is created by this wrapper.

References: [Pino API](https://github.com/pinojs/pino/blob/v10.0.0/docs/api.md),
[redaction](https://github.com/pinojs/pino/blob/v10.0.0/docs/redaction.md),
[browser options](https://github.com/pinojs/pino/blob/v10.0.0/docs/browser.md).
