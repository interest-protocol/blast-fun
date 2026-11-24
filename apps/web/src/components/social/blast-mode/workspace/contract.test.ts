import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceStore } from "./model.ts";
import { emptyWorkspace } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { parseBlastWorkspaceWrite } from "@blast/core/modules/social/contracts/blast-workspace.ts";

test("T-012: account writes accept complete setup and reject account selectors", () => {
  const value = { initialize_if_absent: true, writer_id: "device-a", sequence: 1, workspace: emptyWorkspace() };
  assert.deepEqual(parseBlastWorkspaceWrite(value), value);
  assert.throws(() => parseBlastWorkspaceWrite({ ...value, account_id: "other" }), { code: "invalid_request" });
});

test("T-012 AC-024: malformed, unsafe, future and deeply nested writes use published errors", () => {
  const value = { initialize_if_absent: false, writer_id: "device-a", sequence: 1, workspace: emptyWorkspace() };
  for (const patch of [{ sequence: 0 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { writer_id: "" }, { initialize_if_absent: "true" }, { workspace: { ...emptyWorkspace(), secret: "no" } }]) {
    assert.throws(() => parseBlastWorkspaceWrite({ ...value, ...patch }), { code: "invalid_request" });
  }
  assert.throws(() => parseBlastWorkspaceWrite({ ...value, workspace: { ...emptyWorkspace(), schema_version: 2 } }), { code: "workspace_schema_unsupported" });
  let deep: unknown = "leaf";
  for (let n = 0; n < 18; n++) deep = { next: deep };
  assert.throws(() => parseBlastWorkspaceWrite({ ...value, extra: deep }), { code: "invalid_request" });
  assert.throws(() => parseBlastWorkspaceWrite(JSON.parse('{"__proto__":{},"initialize_if_absent":false,"writer_id":"a","sequence":1,"workspace":{}}')), { code: "invalid_request" });
});

test("T-012 REQ-018: published request, read and acknowledgement schemas match the account client contract", async () => {
  const { createSocialValidator } = await import("@blast/core/modules/social/contracts/validate.ts");
  const validator = createSocialValidator();
  const request = { initialize_if_absent: true, writer_id: "a", sequence: 1, workspace: emptyWorkspace() };
  assert.deepEqual(validator.validate("blast-workspace-request", request).errors, []);
  assert.equal(validator.validate("blast-workspace-request", { ...request, account_id: "other" }).valid, false);
  assert.equal(validator.validate("blast-workspace-request", { ...request, workspace: { ...emptyWorkspace(), market_price: 1 } }).valid, false);
  const read = { account_id: "00000000-0000-4000-8000-000000000001", revision: "0", saved_at_ms: null, workspace: null };
  assert.deepEqual(validator.validate("blast-workspace-response", read).errors, []);
  const ack = { account_id: read.account_id, revision: "1", saved_at_ms: 1800000000000, sequence: 1 };
  assert.deepEqual(validator.validate("blast-workspace-acknowledgement", ack).errors, []);
  assert.equal(validator.validate("blast-workspace-acknowledgement", { ...ack, workspace: emptyWorkspace() }).valid, false);
});


test("account and published contracts preserve token percentages and legacy USD drafts", async () => {
  const { createSocialValidator } = await import("@blast/core/modules/social/contracts/validate.ts");
  const validator = createSocialValidator();
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", chain: "sui", network: "mainnet", coin_type: "0x2::coin::KSTL", presale_id: null });
  for (const sell of [{ typed: "17", mode: "typed" } as const, { typed: "", mode: "quarter", unit: "token" } as const]) {
    const coin = store.getSnapshot().panels.A!.coin;
    store.patchPanel("A", { coin: { ...coin, trade: { ...coin.trade, side: "sell", sell } } });
    const request = { initialize_if_absent: false, writer_id: "a", sequence: 1, workspace: store.getSnapshot() };
    assert.deepEqual(parseBlastWorkspaceWrite(request).workspace.panels.A!.coin.trade.sell, sell);
    assert.deepEqual(validator.validate("blast-workspace-request", request).errors, []);
    const response = { account_id: "00000000-0000-4000-8000-000000000001", revision: "1", saved_at_ms: 1800000000000, workspace: request.workspace };
    assert.deepEqual(validator.validate("blast-workspace-response", response).errors, []);
  }
});
