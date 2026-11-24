import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKSPACE_MAX_BYTES,
  encodeWorkspaceWriteEnvelope,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import {
  createCapacityWorkspace,
  capacityEnvelope,
  exactEnvelope,
  utf8Bytes,
} from "./workload.ts";

test("T-018: mixed measurement workload retains more than 24 complete records", () => {
  const workspace = createCapacityWorkspace(35);
  assert.equal(workspace.visible_order.length, 4);
  assert.equal(workspace.desktop_slots!.length, workspace.desktop_capacity);
  assert.deepEqual(workspace.desktop_slots!.filter((id) => id !== null), workspace.visible_order);
  assert.equal(workspace.retained_order.length, 31);
  assert.equal(
    Object.values(workspace.panels).filter((panel) => panel.presale_id !== null)
      .length,
    17,
  );
  assert.deepEqual(workspace.data.enabled_views, [
    "Coins", "Presales", "Bonding", "Traders", "Activity", "Feed", "Portfolio",
  ]);
  const panel = workspace.panels[workspace.retained_order[0]!]!;
  assert.notEqual(panel.coin.trade.buy.typed, panel.presale.trade.buy.typed);
  assert.ok(
    utf8Bytes(JSON.stringify(workspace)) > JSON.stringify(workspace).length,
  );
});

test("T-018: boundary workload fills the complete UTF-8 HTTP envelope exactly", () => {
  const near = exactEnvelope(WORKSPACE_MAX_BYTES);
  const over = exactEnvelope(WORKSPACE_MAX_BYTES + 1);
  assert.equal(utf8Bytes(JSON.stringify(near)), 1048576);
  assert.equal(utf8Bytes(JSON.stringify(over)), 1048577);
  assert.equal(encodeWorkspaceWriteEnvelope(near).ok, true);
  assert.deepEqual(encodeWorkspaceWriteEnvelope(over), {
    ok: false,
    reason: "envelope_too_large",
  });
  assert.equal(near.workspace.retained_order.length, 31);
  const fresh = exactEnvelope(WORKSPACE_MAX_BYTES, "t018-boundary-00000002");
  assert.equal(fresh.writer_id, "t018-boundary-00000002");
  assert.equal(utf8Bytes(JSON.stringify(fresh)), 1048576);
  assert.equal(
    capacityEnvelope(createCapacityWorkspace(8), 1, "t018-8")
      .initialize_if_absent,
    false,
  );
});
