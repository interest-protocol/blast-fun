import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { blankLaunchDraft } from "@blast/core/modules/social/launch/model.ts";
import { launchDraftResponseSchema } from "@blast/core/modules/social/contracts/launch.ts";
import { fetchLatestLaunchDraftId, fetchLaunchDraft, requestLaunchStep } from "./launch-client.ts";
import { publishLaunch } from "./launch-publish-flow.ts";

const id = "00000000-0000-4000-8000-000000000101";
const address = `0x${"a".repeat(64)}`;
const rules = {
  meme_decimals: [6, 9], quote_fee_bps: 100, meme_fee_bps: 50,
  protocol_meme_bps: 250, protocol_quote_bps: 150, creation_fee: "0",
  protocol_fee_share_bps: 6500, pool_fee_meme_bps: 5000, pool_fee_quote_bps: 1500,
  quotes: ["0x2::sui::SUI"], cetus_tiers: null, bluefin_options: { status: "unavailable" },
};
const draft = {
  draft_id: id, version: 1, created_at_ms: 1, updated_at_ms: 2,
  draft: blankLaunchDraft(""), logo_url: null, cover: null, publishing: false,
  published_launch_id: null, issues: [{ section: "coin", path: "name", message: "Add a name" }], rules,
};
const api = (body: unknown) => ({ getAccessToken: async () => "token", fetch: async () => Response.json(body) });

test("launch reads accept unfinished stored drafts and reject malformed nested rules", async () => {
  const result = await fetchLaunchDraft(api(draft), id);
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.body, draft);
  const bad = await fetchLaunchDraft(api({ ...draft, rules: { ...rules, creation_fee: 1 } }), id);
  assert.equal(bad.status, "error");
  const latest = await fetchLatestLaunchDraftId(api({ drafts: [{ draft_id: id, version: 1, updated_at_ms: 2, name: "", symbol: "", logo_url: null }] }));
  assert.equal(latest.status, "ok");
  if (latest.status === "ok") assert.equal(latest.body, id);
  assert.ok(!launchDraftResponseSchema.safeParse({ ...draft, draft: { ...draft.draft, first_buy: 0.00001 } }).success);
});

test("launch step keeps byte decoding in the signing verifier and accepts additive plan fields", async () => {
  const plan = { draft_id: id, version: 1, launchpad_original_package_id: address,
    core_original_package_id: address, deployment_fingerprint: "a".repeat(64), extra: true,
    steps: [{ kind: "publish_coin", transaction: "{}", sponsorship: { reservation_id: id, transaction_bytes: "%not base64%" } }] };
  const result = await requestLaunchStep(api(plan), id, 1, address, "publish_coin", null, "sponsored");
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.body.steps[0].sponsorship?.transaction_bytes, "%not base64%");
});

test("malformed launch plans keep the specific refusal before any wallet or chain call", async () => {
  for (const body of [{}, { draft_id: id, version: 1, launchpad_original_package_id: address, steps: [{ kind: "publish_coin", transaction: "{}" }] }]) {
    let signed = false;
    await assert.rejects(publishLaunch({
      api: api(body), client: {} as ClientWithCoreApi,
      storage: { getItem: () => null, setItem: () => { throw new Error("unexpected checkpoint"); }, removeItem: () => {} },
      draftId: id, version: 1, creator: address, fee: "sponsored", progress: () => {},
      sign: async () => { signed = true; throw new Error("unexpected signing"); },
    }), /: The server returned an invalid launch step\. Code: invalid_response\./);
    assert.equal(signed, false);
  }
});

test("launch verifies the wallet before sponsorship, then refuses altered bytes without signing", async () => {
  for (const wrongSender of [true, false]) {
    const transaction = new Transaction();
    transaction.setSender(wrongSender ? `0x${"b".repeat(64)}` : address);
    transaction.moveCall({ target: `${address}::example::call` });
    const plan = { draft_id: id, version: 1, launchpad_original_package_id: address,
      core_original_package_id: address, deployment_fingerprint: "a".repeat(64),
      steps: [{ kind: "publish_coin", transaction: await transaction.toJSON(), sponsorship: { reservation_id: id, transaction_bytes: "%not base64%" } }] };
    let signed = false;
    await assert.rejects(publishLaunch({
      api: api(plan), client: {} as ClientWithCoreApi,
      storage: { getItem: () => null, setItem: () => { throw new Error("unexpected checkpoint"); }, removeItem: () => {} },
      draftId: id, version: 1, creator: address, fee: "sponsored", progress: () => {},
      sign: async () => { signed = true; throw new Error("unexpected signing"); },
    }), wrongSender ? /The launching wallet changed/ : /The sponsor changed the launch transaction. Nothing was signed/);
    assert.equal(signed, false);
  }
});
