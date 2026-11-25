# Errors: public messages and diagnostic references

Every failed user action should explain what happened, what the user can do,
and how support can identify the failure. Public responses must not contain
credentials, provider payloads, SQL queries, environment values, or arbitrary
exception messages.

## Backend convention

Keep the existing domain error contracts: a stable public `error.code`, a
fixed safe `error.message`, the appropriate HTTP status, and a server-generated
`X-Request-ID` header. Use `Retry-After` for temporary outages and limits.
Domain-specific public fields, such as a budget reason or an unconfirmed
transaction digest, must be explicitly allowed by the domain schema.

For example:

```http
HTTP/1.1 503 Service Unavailable
X-Request-ID: 94ecbfea-df02-4b14-ae2f-7775b3914dc3
Retry-After: 5
Cache-Control: no-store

{"error":{"code":"service_unavailable","message":"The service is temporarily unavailable."}}
```

Do not add diagnostic fields to existing bodies casually: presale and social
schemas reject undeclared fields. The response header carries the reference
without changing those contracts. A reference identifies an occurrence; a
code identifies a category. An opaque reference does not explain the failure
unless a server log contains the same reference.

Catch unexpected exceptions at the shared route boundary and return fixed
safe text. Record the route template, request ID, status, public code, and a
value-free cause label (`errorLabel`, `presaleErrorCause`, or
`socialErrorCause`). Distinguish known budget, configuration, authentication,
and dependency failures before the fallback. If a shared label cannot
distinguish two failures, add a fixed subsystem or step label to the relevant
server log, rather than exposing the exception message.

Never log request headers/bodies or arbitrary exception messages as a shortcut
to diagnosis. Use the existing presale redaction utilities where applicable.
Do not accept a caller's reference as authoritative; generate it server-side.

## Frontend convention

Keep HTTP status, public code, retry delay, and request ID through client and
query transformations. Render an allowlisted, actionable message with the
code and reference. Ignore arbitrary server or wallet exception text. A
temporary outage can say:

> Blast is temporarily unavailable. Try again soon. Code: service_unavailable.
> Reference: 94ecbfea-df02-4b14-ae2f-7775b3914dc3.

Messages for writes must describe the real outcome: whether a draft is saved,
nothing was submitted, network fees were spent, or execution remains
unconfirmed. An unknown transaction outcome must preserve its digest and
offer a confirmation/recovery path; it must not say that nothing was sent.
Keep wallet cancellation distinct from failures. A network failure with no
server response has no server request ID; do not manufacture one that cannot
be found in backend logs.

Retry safe reads according to their HTTP status and published code. Do not
automatically replay money-moving mutations after ambiguous failures. Wallet-paid
withdrawals sign exact prebuilt bytes and retain their digest before submission;
a lost execution reply checks that transaction instead of signing again.

## Coverage in this change

- Presale route errors log their response request ID, status, public code,
  and safe cause label. Undeclared-code logs retain the same reference.
- Social route errors and sampled responses include the response request ID.
- The shared `callSocialApi` retains request IDs on refused and malformed
  responses. Query error conversion preserves those IDs in both directions
  and includes them in safe messages. Temporary outages and rate limits have
  actionable query messages.
- Create publishing retains response references and explains sponsorship
  limits with public codes and safe reasons.

## Backend boundary coverage

- `publicErrorResponse` creates fixed public envelopes, an `X-Request-ID`,
  no-store caching, retry guidance for outages, and a correlated `http.error`
  log. Logs contain the public code, status and a value-free cause label;
  credentials, request bodies, provider text and SQL never enter them.
- `publicJson` adds the same contract to legacy server-owned JSON errors and
  partial-failure reports while preserving successful bodies and domain fields.
  Closed presale/social contracts keep references in headers, not extra fields.
- Mission-control admission, callsign, telemetry, completion, wallet proofs,
  owner/profile/session/share/account links, restoration, cleanup, projection,
  and X-verification boundaries use structured errors and references, including
  failures during outer runtime construction. Crew restoration distinguishes
  dependency outages from credential denial without identifying an account.
- Launchpad reads, search/discovery/list, identity/writes/runtime, market reads,
  telemetry and outcomes use references and fixed safe errors. Market reads
  never relay an upstream error payload. Image errors use JSON codes while
  successful images keep their existing binary/cache behavior.
- Proxy API feature refusals carry the same fixed not_found code and reference;
  normal page 404s remain empty and do not create API error logs.
- Gate refresh preserves its legacy string protocol and adds a fixed sibling
  code/message plus reference. Shared route-limit and final telemetry guards
  convert unexpected outer exceptions into fixed public failures.
- Every kit 5xx and write refusal is logged with its response reference.
  Social read refusals remain sampled to bound noisy anonymous traffic; they
  retain references even when a custom metric is not emitted. Success metrics
  remain sampled. Logging can be disabled by the existing metrics setting.
- Browser-safe fixed copy is exported from social/presale contracts and
  `LEGACY_ERROR_MESSAGES`; browser code can identify known public codes without
  trusting arbitrary response messages.

The frontend migration retains code/status/reference through shared clients,
query adapters and product flows. Keep safe wallet/transaction recovery copy,
request cancellation, malformed responses and unavailable reads distinct.
Infrastructure failures before application code runs (a gateway/proxy outage or
process failure), or framework responses outside route handlers (such as an
unsupported HTTP method), cannot carry an application-generated request reference; clients
must use a fixed local diagnostic code for those transport/parse failures.

## Checks to keep

- Exercise real Request-to-Response handlers: code/status/retry delay must
  match the contract, and the response reference must match its error log.
- Inject exceptions containing fake credentials and provider/SQL text;
  assert that neither response nor emitted log exposes those values.
- Test clients with 401, 429, 503, malformed JSON, invalid successful bodies,
  transport failure, and cancellation. References survive when supplied;
  raw messages are ignored.
- Test round trips through query errors and verify actual UI copy for each
  transaction outcome. Add type-level coverage for client result inference
  when metadata is added, and run the workspace typecheck.
- For each migrated route family, inventory its outer runtime/gate catches
  as well as its handler: failures before the handler need the same treatment.
