import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceStore } from "./model";
import { createPanelSort, type PanelSortBox } from "./panel-sort";

function workspace() {
  const store = createWorkspaceStore();
  for (const id of ["A", "B", "C", "D"])
    store.add({ panel_id: id, chain: "sui", network: "mainnet", coin_type: `0x2::coin::${id}`, presale_id: null });
  return store;
}
const boxes: PanelSortBox[] = [
  { id: "A", left: 0, top: 0, width: 300, height: 200 },
  { id: "B", left: 320, top: 0, width: 300, height: 200 },
  { id: "C", left: 0, top: 220, width: 300, height: 200 },
  { id: "D", left: 320, top: 220, width: 300, height: 200 },
];

test("held panel follows both axes and siblings make room before a single durable drop", () => {
  const store = workspace();
  const before = store.getSnapshot();
  let writes = 0;
  store.subscribe(() => writes++);
  const drag = createPanelSort("A", before.visible_order, boxes);
  assert.ok(drag);
  const preview = drag.move({ x: 320, y: 220 });
  assert.deepEqual(preview.order, ["B", "C", "D", "A"]);
  assert.deepEqual(preview.offsets.get("A"), { x: 320, y: 220 });
  assert.deepEqual(preview.offsets.get("B"), { x: -320, y: 0 });
  assert.deepEqual(preview.offsets.get("C"), { x: 320, y: -220 });
  assert.deepEqual(preview.offsets.get("D"), { x: -320, y: 0 });
  assert.equal(store.getSnapshot(), before);
  assert.equal(writes, 0);
  assert.equal(drag.finish(store), true);
  assert.deepEqual(store.getSnapshot().visible_order, ["B", "C", "D", "A"]);
  assert.deepEqual(store.getSnapshot().panels, before.panels);
  assert.equal(writes, 1);
  assert.equal(drag.finish(store), false);
  assert.equal(writes, 1);
});


test("Escape/cancel and returning to the original slot preserve the exact snapshot", () => {
  for (const canceled of [true, false]) {
    const store = workspace();
    const before = store.getSnapshot();
    const drag = createPanelSort("A", before.visible_order, boxes)!;
    drag.move({ x: 320, y: 220 });
    if (!canceled) drag.move({ x: 0, y: 0 });
    assert.equal(drag.finish(store, canceled), false);
    assert.equal(store.getSnapshot(), before);
  }
});

test("a completed drag preserves exact vacancies, panel settings and selection", () => {
  const store = workspace();
  store.remove("B");
  store.focus("C");
  const before = store.getSnapshot();
  const drag = createPanelSort("D", before.visible_order, boxes)!;
  assert.deepEqual(drag.move({ x: -320, y: -220 }).order, ["D", "A", "C"]);
  assert.equal(store.getSnapshot(), before);
  assert.equal(drag.finish(store), true);
  const after = store.getSnapshot();
  assert.deepEqual(after.desktop_slots, ["D", null, "A", "C"]);
  assert.deepEqual(after.panels, before.panels);
  assert.equal(after.focused_panel_id, "C");
  assert.equal(after.mobile_panel_id, before.mobile_panel_id);
});

test("external membership or order changes invalidate a gesture instead of overwriting them", () => {
  for (const change of ["remove", "reorder"]) {
    const store = workspace();
    const drag = createPanelSort("A", store.getSnapshot().visible_order, boxes)!;
    drag.move({ x: 320, y: 220 });
    if (change === "remove") store.remove("B");
    else store.reorder(["D", "C", "B", "A"]);
    const external = store.getSnapshot();
    assert.equal(drag.finish(store), false);
    assert.equal(store.getSnapshot(), external);
  }
});

test("missing or unusable layout never starts a gesture", () => {
  assert.equal(createPanelSort("A", ["A", "B"], boxes.slice(0, 1)), null);
  assert.equal(createPanelSort("A", ["A"], [{ ...boxes[0]!, width: 0 }]), null);
  assert.equal(createPanelSort("missing", ["A"], boxes), null);
});
