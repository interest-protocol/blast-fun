import assert from "node:assert/strict";
import test from "node:test";

import { socialWhyPath, socialWhyReportsPath } from "@blast/core/modules/social/contracts/whys.ts";

import {
  WHY_DELETED_TOAST,
  WHY_REPORTED_TOAST,
  addWhy,
  addWhyFailureMessage,
  deleteWhy,
  deleteWhyFailureMessage,
  reportWhy,
  reportWhyFailureMessage,
} from "./why-client";

/** Social feed T-022: the card's delete and report calls, and the words they show. */

const WHY_ID = "3f1c2d4e-5a6b-47c8-9d0e-1f2a3b4c5d6e";
const token = async () => "privy-token";

type Call = Readonly<{ url: string; init: RequestInit | undefined }>;

/** A fetch that answers `status` with `body` (a `204` has none), recording what it was asked. */
function fetchReturning(status: number, body?: unknown, headers?: HeadersInit) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status, headers });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const bodyOf = (call: Call): unknown => JSON.parse(String(call.init?.body));

test("addWhy parses the published response and retains the request ID when it is malformed", async () => {
  const publishedBody = { why_id: WHY_ID, text: "A test why." };
  const created = fetchReturning(201, publishedBody);
  assert.deepEqual(await addWhy({ getAccessToken: token, fetch: created.fetch }, WHY_ID, publishedBody.text), {
    status: "ok",
    body: publishedBody,
    httpStatus: 201,
  });

  const malformed = fetchReturning(201, { ...publishedBody, why_id: "invalid" }, { "X-Request-ID": "why-ref-2" });
  assert.deepEqual(await addWhy({ getAccessToken: token, fetch: malformed.fetch }, WHY_ID, publishedBody.text), {
    status: "error",
    code: "invalid_response",
    httpStatus: 201,
    requestId: "why-ref-2",
  });
});

test("deleteWhy sends DELETE to the why's own path with the viewer's token and no body, and reads the 204", async () => {
  const { calls, fetch } = fetchReturning(204);
  const result = await deleteWhy({ getAccessToken: token, fetch }, WHY_ID);
  assert.deepEqual(result, { status: "ok", body: null, httpStatus: 204 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, socialWhyPath(WHY_ID));
  assert.equal(calls[0]?.init?.method, "DELETE");
  assert.equal(calls[0]?.init?.body, undefined);
  assert.equal(calls[0]?.init?.cache, "no-store");
  assert.equal(calls[0]?.init?.credentials, "same-origin");
  assert.deepEqual(calls[0]?.init?.headers, { authorization: "Bearer privy-token" });
});

test("deleteWhy passes the route's refusal through", async () => {
  const { fetch } = fetchReturning(403, { error: { code: "not_author", message: "private provider text" } }, { "X-Request-ID": "why-ref-1" });
  assert.deepEqual(await deleteWhy({ getAccessToken: token, fetch }, WHY_ID), {
    status: "refused",
    code: "not_author",
    httpStatus: 403,
    requestId: "why-ref-1",
    retryAfterSeconds: null,
  });
});

test("reportWhy posts to the why's reports path: an empty body without a reason, the trimmed reason with one", async () => {
  const stored = fetchReturning(201, { why_id: WHY_ID, already_reported: false });
  const first = await reportWhy({ getAccessToken: token, fetch: stored.fetch }, WHY_ID);
  assert.deepEqual(first, { status: "ok", body: { why_id: WHY_ID, already_reported: false }, httpStatus: 201 });
  assert.equal(stored.calls[0]?.url, socialWhyReportsPath(WHY_ID));
  assert.equal(stored.calls[0]?.init?.method, "POST");
  assert.deepEqual(bodyOf(stored.calls[0]!), {});
  assert.deepEqual(stored.calls[0]?.init?.headers, { authorization: "Bearer privy-token", "content-type": "application/json" });

  const withReason = fetchReturning(201, { why_id: WHY_ID, already_reported: false });
  await reportWhy({ getAccessToken: token, fetch: withReason.fetch }, WHY_ID, "  spam  ");
  assert.deepEqual(bodyOf(withReason.calls[0]!), { reason: "spam" });
  // A blank reason is no reason at all.
  const blank = fetchReturning(201, { why_id: WHY_ID, already_reported: false });
  await reportWhy({ getAccessToken: token, fetch: blank.fetch }, WHY_ID, "   ");
  assert.deepEqual(bodyOf(blank.calls[0]!), {});
});

test("reportWhy reads the repeat's 200 the same way, and refuses an answer that is not the contract's", async () => {
  const repeat = fetchReturning(200, { why_id: WHY_ID, already_reported: true });
  assert.deepEqual(await reportWhy({ getAccessToken: token, fetch: repeat.fetch }, WHY_ID), {
    status: "ok",
    body: { why_id: WHY_ID, already_reported: true },
    httpStatus: 200,
  });
  const wrong = fetchReturning(201, { why_id: WHY_ID });
  assert.deepEqual(await reportWhy({ getAccessToken: token, fetch: wrong.fetch }, WHY_ID), { status: "error", code: "invalid_response", httpStatus: 201 });
});

test("a wallet-session viewer sends no Authorization header, only the same-origin cookie (OA-16)", async () => {
  const { calls } = await (async () => {
    const probe = fetchReturning(204);
    await deleteWhy({ getAccessToken: async () => null, fetch: probe.fetch }, WHY_ID);
    return probe;
  })();
  assert.deepEqual(calls[0]?.init?.headers, {});
  assert.equal(calls[0]?.init?.credentials, "same-origin");
});

test("every refusal the card can meet has its own words, and the toasts are the design's", () => {
  const refusal = (code: string) => ({ status: "refused", code, retryAfterSeconds: null }) as const;
  assert.equal(deleteWhyFailureMessage(refusal("not_author")), "Only the author can delete this why. Code: not_author.");
  assert.equal(deleteWhyFailureMessage(refusal("why_removed")), "The Blast team removed this why. Code: why_removed.");
  assert.equal(deleteWhyFailureMessage(refusal("not_found")), "This why is no longer shown. Code: not_found.");
  assert.equal(deleteWhyFailureMessage(refusal("rate_limited")), "You’ve changed a lot of whys. Try again later. Code: rate_limited.");
  assert.equal(deleteWhyFailureMessage(refusal("unauthorized")), "Sign in again to delete your why. Code: unauthorized.");
  assert.equal(deleteWhyFailureMessage(refusal("teapot")), "Couldn’t delete your why. Try again. Code: request_failed.");
  assert.equal(deleteWhyFailureMessage({ status: "error" }), "Couldn’t delete your why. Check your connection and try again. Code: request_failed.");

  assert.equal(reportWhyFailureMessage(refusal("cannot_report_self")), "You can’t report your own why. Code: cannot_report_self.");
  assert.equal(reportWhyFailureMessage(refusal("not_found")), "This why is no longer shown. Code: not_found.");
  assert.equal(reportWhyFailureMessage(refusal("rate_limited")), "You’ve reported a lot of whys. Try again later. Code: rate_limited.");
  assert.equal(reportWhyFailureMessage(refusal("unauthorized")), "Sign in again to report this why. Code: unauthorized.");
  assert.equal(reportWhyFailureMessage(refusal("teapot")), "Couldn’t send your report. Try again. Code: request_failed.");
  assert.equal(reportWhyFailureMessage({ status: "error" }), "Couldn’t send your report. Check your connection and try again. Code: request_failed.");

  // The report's answer is the same whether it stored a row or found one (§3.7).
  assert.equal(WHY_REPORTED_TOAST, "Thanks. The Blast team will review it.");
  assert.equal(WHY_DELETED_TOAST, "Why deleted");
  // T-021's words are untouched.
  assert.equal(addWhyFailureMessage(refusal("why_has_link")), "Links aren’t allowed in a why. Code: why_has_link.");
});
