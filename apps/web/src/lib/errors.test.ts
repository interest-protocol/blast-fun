import assert from "node:assert/strict";
import { test } from "node:test";
import { publicErrorCopy, diagnosticMessage, PublicError, publicErrorMessage, responseError, splitDiagnostic } from "./errors.ts";

test("provider messages and arbitrary codes never reach public copy", () => {
  const response = new Response(null, { status: 503, headers: { "x-request-id": "support-123" } });
  const error = responseError({ error: { code: "secret-database-url", message: "private provider token" } }, response);
  assert.match(error.message, /Code: service_unavailable/);
  assert.match(error.message, /Reference: support-123/);
  assert.doesNotMatch(error.message, /secret|database|private|token/);
  assert.doesNotMatch(publicErrorMessage(new Error("private token")), /private|token/);
});

test("known failures carry safe codes and validated support references", () => {
  const error = responseError({ error: { code: "insufficient_balance", message: "secret" } }, new Response(null, { status: 409, headers: { "x-request-id": "balance-123", "retry-after": "10" } }));
  assert.match(error.message, /Code: insufficient_balance/);
  assert.equal(error.requestId, "balance-123");
  assert.equal(error.retryAfterSeconds, 10);
  assert.equal(error.httpStatus, 409);
  assert.equal(publicErrorMessage(error), error.message);
  assert.match(new PublicError("Daily sponsorship is used up.", { code: "budget_exceeded", reason: "daily_limit" }).message, /budget_exceeded\/daily_limit/);
  assert.doesNotMatch(diagnosticMessage("Try again.", { requestId: "<script>secret</script>" }), /script|secret/);
});


test("unknown public codes use the caller's safe recovery copy", () => {
  assert.equal(publicErrorCopy("secret_provider_code", "Prices could not load. Try again."), "Prices could not load. Try again.");
  assert.equal(publicErrorCopy(null, "Prices could not load. Try again."), "Prices could not load. Try again.");
  // The paused sheet's banner says only what failed, with its code line; the note under the steps says "saved", the button says retry.
  assert.deepEqual(splitDiagnostic(diagnosticMessage(publicErrorCopy("publish_failed"), { code: "publish_failed" })), { text: "Publishing could not finish.", detail: "Code: publish_failed." });
});

test("a diagnostic message splits into its sentence and the code line it keeps visible", () => {
  assert.deepEqual(splitDiagnostic(diagnosticMessage("Prices are unavailable. Try again shortly.", { httpStatus: 503, requestId: "ref-1" })), {
    text: "Prices are unavailable. Try again shortly.",
    detail: "Code: service_unavailable. Reference: ref-1.",
  });
  assert.deepEqual(splitDiagnostic("Add native SUI to pay the network fee."), { text: "Add native SUI to pay the network fee.", detail: null });
});
