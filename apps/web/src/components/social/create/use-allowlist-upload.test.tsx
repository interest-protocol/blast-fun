import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
const { act, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useAllowlistUpload } = await import("./use-allowlist-upload");
const { createStore, useCreateState } = await import("./create-store");
const { filledSample } = await import("../../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts");

const id = "00000000-0000-4000-8000-000000000001";
const fileName = "my-presale-wallets.csv";
const draft = { ...filledSample(), eligibility: "allowlist" as const };
const entries = {
  quote: draft.quote_type,
  source: { file_name: fileName, uploaded_count: 1, include_blast_holders: false, added_count: 0, holder_cap: null },
  entries: [{ wallet: `0x${"1".padStart(64, "0")}`, cap: "1000001" }],
};

test("a confirmed upload closes review and retains the filename while saved details load", async () => {
  const pendingRead = Promise.withResolvers<Response>();
  let uploadedName: string | undefined;
  let failUpload = true;
  const api = (signal?: AbortSignal) => ({ signal, getAccessToken: async () => "token", fetch: (async (_input, init) => {
    if (init?.method !== "POST") return pendingRead.promise;
    uploadedName = ((init.body as FormData).get("file") as File).name;
    if (failUpload) return Response.json({ error: { code: "service_unavailable" } }, { status: 503, headers: { "x-request-id": "support-reference" } });
    return Response.json({ allowlist_id: id, entry_count: 1, leaf_count: "1", root: "a".repeat(64), total_cap: "1000001", warnings: [] }, { status: 201 });
  }) as typeof fetch });
  let upload!: ReturnType<typeof useAllowlistUpload>;
  function Harness() {
    upload = useAllowlistUpload({ state: useCreateState(), api, session: useRef(new AbortController()) });
    return null;
  }
  const root = createRoot(dom.document.createElement("div"));
  createStore.reset({ phase: "ready", draftId: "draft", draft });
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => upload.onList(new File(["address,amount\n0x1,1.000001"], fileName)));
    assert.ok(upload.listReview);
    await act(async () => upload.acceptList());
    assert.equal(createStore.get().draft.allowlist_id, null);
    assert.equal(upload.listReview?.uploadError, "Your current list is unchanged. Try again in a moment.");
    assert.doesNotMatch(upload.listReview!.uploadError!, /service_unavailable|support-reference|Code:/);
    failUpload = false;
    await act(async () => upload.acceptList());
    assert.equal(uploadedName, fileName);
    assert.equal(upload.listReview, null);
    assert.equal(upload.actions.fileName, fileName, "the card keeps the filename before its follow-up read resolves");
    await act(async () => pendingRead.resolve(Response.json(entries)));
    await act(async () => upload.actions.onReview());
    const review = () => upload.listReview;
    assert.equal(review()?.fileName, fileName);
    assert.equal(review()?.saved, true);
    const originalClick = dom.window.HTMLAnchorElement.prototype.click;
    let downloadedName = "";
    dom.window.HTMLAnchorElement.prototype.click = function () { downloadedName = this.download; };
    try {
      upload.actions.onDownload();
      assert.equal(downloadedName, fileName);
    } finally { dom.window.HTMLAnchorElement.prototype.click = originalClick; }
  } finally {
    await act(async () => root.unmount());
    createStore.reset();
  }
});

test("Review retries a failed saved read and opens the modal on that same click", async () => {
  let reads = 0;
  const retry = Promise.withResolvers<Response>();
  const api = (signal?: AbortSignal) => ({ signal, getAccessToken: async () => "token", fetch: (async () => {
    reads++;
    return reads === 1 ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 }) : retry.promise;
  }) as typeof fetch });
  let upload!: ReturnType<typeof useAllowlistUpload>;
  function Harness() {
    upload = useAllowlistUpload({ state: useCreateState(), api, session: useRef(new AbortController()) });
    return null;
  }
  const root = createRoot(dom.document.createElement("div"));
  createStore.reset({ phase: "ready", draftId: "draft", draft: { ...draft, allowlist_id: id } });
  try {
    await act(async () => root.render(<Harness />));
    assert.equal(upload.actions.pending, false);
    await act(async () => upload.actions.onReview());
    assert.equal(upload.actions.pending, true);
    await act(async () => retry.resolve(Response.json(entries)));
    assert.equal(reads, 2);
    assert.equal(upload.listReview?.saved, true, "a successful retry opens immediately without asking for another click");
    assert.equal(upload.listReview?.fileName, fileName);
    assert.equal(upload.actions.holderSummary, null);
  } finally {
    await act(async () => root.unmount());
    createStore.reset();
  }
});
