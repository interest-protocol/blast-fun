import assert from "node:assert/strict";
import test from "node:test";
import { blankDraft, CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import { fetchDraft, fetchLatestDraftId, recordPublished } from "./create-client.ts";

const id = "11111111-1111-4111-8111-111111111111";
const draft = {
  draft_id: id, version: 1, created_at_ms: 1, updated_at_ms: 1, draft: blankDraft(),
  logo_url: null, cover: null, published_presale_id: null, allowlist: null, issues: [],
  fee_policy: CREATE_DEFAULT_FEE_POLICY, quotes: [], sui_price: null,
};
const options = (body: unknown, status = 200) => ({
  getAccessToken: async () => "token",
  fetch: (async () => Response.json(body, { status, headers: { "X-Request-ID": "create-reference" } })) as typeof fetch,
});

test("draft reads validate their response and preserve request diagnostics", async () => {
  assert.deepEqual(await fetchDraft(options(draft), id), { status: "ok", body: draft, httpStatus: 200 });
  assert.deepEqual(await fetchDraft(options({ ...draft, version: -1 }), id), {
    status: "error", code: "invalid_response", httpStatus: 200, requestId: "create-reference",
  });
});

test("malformed draft pages return a diagnostic instead of dereferencing items", async () => {
  assert.deepEqual(await fetchLatestDraftId(options({})), {
    status: "error", code: "invalid_response", httpStatus: 200, requestId: "create-reference",
  });
});

test("draft conflicts preserve the stored draft and diagnostic unchanged", async () => {
  const error = { code: "draft_conflict", draft };
  assert.deepEqual(await fetchDraft(options({ error }, 409), id), {
    status: "refused", code: "draft_conflict", error, httpStatus: 409, requestId: "create-reference",
  });
});

test("published metadata must satisfy the shared response contract", async () => {
  assert.deepEqual(await recordPublished(options({ presale_id: "invalid", metadata: {}, editable: true }), id, "sale"), {
    status: "error", code: "invalid_response", httpStatus: 200, requestId: "create-reference",
  });
});
