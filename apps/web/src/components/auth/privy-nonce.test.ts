import assert from "node:assert/strict";
import test from "node:test";

import { documentNonce } from "./privy-nonce.ts";

/** A document whose first nonced script carries `nonce` (the IDL property survives the attribute being hidden). */
const doc = (nonce: string | null) =>
  ({ querySelector: () => (nonce === null ? null : { nonce }) }) as unknown as Pick<
    Document,
    "querySelector"
  >;

test("UI-99: Privy's styles take the nonce this document's CSP allows, not a client-navigated layout's fresh one", () => {
  // Server render: no document, the request's nonce.
  assert.equal(documentNonce("request-nonce", undefined), "request-nonce");
  // A layout mounted by client navigation carries another request's nonce; the page's own wins.
  assert.equal(documentNonce("fresh-rsc-nonce", doc("page-nonce")), "page-nonce");
  // No nonced script (no CSP nonce on this document): the prop, or none.
  assert.equal(documentNonce("request-nonce", doc(null)), "request-nonce");
  assert.equal(documentNonce(null, doc("")), null);
});
