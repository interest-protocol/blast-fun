import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceStore } from "./model";
import {
  decodeWorkspace,
  encodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";

const coin = `0x${"2".padStart(64, "0")}::sui::SUI`;

test("legacy setup without a Coins anchor decodes without inventing a migration", () => {
  const snapshot = createWorkspaceStore().getSnapshot();
  const bytes = JSON.stringify(snapshot);
  assert.equal(
    Object.hasOwn(snapshot.data.controls.Coins.navigation, "anchor"),
    false,
  );
  const decoded = decodeWorkspace(bytes);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.migrated, false);
    assert.deepEqual(decoded.workspace, snapshot);
    assert.deepEqual(encodeWorkspace(decoded.workspace), { ok: true, bytes });
  }
});

test("Coins anchor survives complete setup encoding alongside model edits", () => {
  const store = createWorkspaceStore();
  const controls = store.getSnapshot().data.controls.Coins;
  store.patchDataControls("Coins", {
    ...controls,
    navigation: {
      ...controls.navigation,
      anchor: { coin_type: "0x2::sui::SUI", index: 3, offset: -12.5 },
    },
  });
  store.add({
    panel_id: "sui",
    chain: "sui",
    network: "mainnet",
    coin_type: coin,
    presale_id: null,
  });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const decoded = decodeWorkspace(encoded.bytes);
  assert.equal(decoded.ok, true);
  if (decoded.ok)
    assert.deepEqual(decoded.workspace.data.controls.Coins.navigation.anchor, {
      coin_type: coin,
      index: 3,
      offset: -12.5,
    });
});

for (const anchor of [
  { coin_type: "not-an-asset", index: 0, offset: 0 },
  { coin_type: coin, index: -1, offset: 0 },
  { coin_type: coin, index: 0.5, offset: 0 },
  { coin_type: coin, index: 0, offset: null },
  { coin_type: coin, index: 0, offset: "0" },
  { coin_type: coin, index: 0, offset: 0, extra: true },
]) {
  test(`malformed Coins anchor is rejected and retains original bytes: ${JSON.stringify(anchor)}`, () => {
    const snapshot = structuredClone(createWorkspaceStore().getSnapshot());
    const bytes = JSON.stringify({
      ...snapshot,
      data: {
        ...snapshot.data,
        controls: {
          ...snapshot.data.controls,
          Coins: {
            ...snapshot.data.controls.Coins,
            navigation: { ...snapshot.data.controls.Coins.navigation, anchor },
          },
        },
      },
    });
    const decoded = decodeWorkspace(bytes);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) assert.equal(decoded.original_bytes, bytes);
  });
}
