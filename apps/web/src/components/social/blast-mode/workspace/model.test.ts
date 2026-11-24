import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceStore } from "./model";
import {
  encodeWorkspace,
  encodeWorkspaceWriteEnvelope,
  decodeWorkspace,
  type WorkspaceWriteEnvelope,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import type { PanelInput } from "@blast/core/modules/social/blast-workspace/setup.ts";

const asset = (id: string): PanelInput => ({
  panel_id: id,
  chain: "sui",
  network: "mainnet",
  coin_type: `0x2::coin::${id}`,
  presale_id: null,
});

test("adding fills vacancies and full-grid programmatic adds displace to history without duplicating identity", () => {
  const store = createWorkspaceStore();
  for (const id of ["A", "B", "C", "D", "E"]) store.add(asset(id));
  assert.deepEqual(store.getSnapshot().visible_order, ["E", "A", "B", "C"]);
  assert.deepEqual(store.getSnapshot().retained_order, ["D"]);
  store.add({ ...asset("B"), panel_id: "ignored", coin_type: "0x02::coin::B" });
  assert.deepEqual(store.getSnapshot().visible_order, ["E", "A", "B", "C"]);
  assert.equal(Object.keys(store.getSnapshot().panels).length, 5);
});

test("explicit removal deletes setup and leaves the exact vacancy without promoting history", () => {
  const store = createWorkspaceStore();
  for (const id of ["D", "C", "F", "E", "B", "A"]) store.add(asset(id));
  store.remove("B");
  assert.deepEqual(store.getSnapshot().visible_order, ["A", "D", "C"]);
  assert.deepEqual(store.getSnapshot().retained_order, ["F", "E"]);
  assert.deepEqual(store.getSnapshot().desktop_slots,["A",null,"D","C"]);
  assert.equal(store.getSnapshot().panels.B, undefined);
});

test("capacity and committed reorder preserve membership, while cancellation leaves the snapshot alone", () => {
  const store = createWorkspaceStore();
  for (const id of ["C", "A", "B", "D"]) store.add(asset(id));
  const before = store.getSnapshot();
  store.reorder(["D", "C", "A", "B"], false);
  assert.equal(store.getSnapshot(), before);
  store.setCapacity(2);
  assert.deepEqual(store.getSnapshot().visible_order, ["C", "A"]);
  assert.deepEqual(store.getSnapshot().retained_order, ["B", "D"]);
  store.setCapacity(4);
  assert.deepEqual(store.getSnapshot().desktop_slots, ["C", "A", null, null]);
  assert.deepEqual(store.getSnapshot().retained_order, ["B", "D"]);
  store.add(asset("B"));
  store.add(asset("D"));
  assert.deepEqual(store.getSnapshot().visible_order, ["C", "A", "B", "D"]);
  store.reorder(["D", "C", "A", "B"]);
  store.focus("B");
  store.selectMobile("A");
  store.remove("B");
  assert.equal(store.getSnapshot().focused_panel_id, "A");
  assert.equal(store.getSnapshot().mobile_panel_id, "A");
  for (const id of ["A", "C", "D"]) store.remove(id);
  assert.equal(store.getSnapshot().focused_panel_id, null);
  assert.equal(store.getSnapshot().mobile_panel_id, null);
  assert.throws(() => store.setCapacity(0));
  assert.throws(() => store.reorder(["missing"]));
});

for (const [label, sequence, removed, expected] of [
  ["visible successor despite retained history", ["A", "B", "C", "D", "E"], "A", "B"],
  ["former index successor", ["A", "B", "C", "D"], "B", "C"],
  ["preceding final panel", ["A", "B", "C", "D"], "D", "C"],
  ["empty workspace", ["A"], "A", null],
] as const) {
  test(`removing the selected panel chooses its ${label} on desktop and mobile`, () => {
    for (const selection of ["both", "focus", "mobile"] as const) {
      const store = createWorkspaceStore();
      for (const id of sequence) store.add(asset(id));
      if (selection !== "mobile") store.focus(removed);
      if (selection !== "focus") store.selectMobile(removed);
      store.remove(removed);
      const snapshot = store.getSnapshot();
      assert.equal(
        snapshot.focused_panel_id,
        expected,
      );
      assert.equal(
        snapshot.mobile_panel_id,
        expected,
      );
    }
  });
}

test("removing another visible or retained panel preserves the current coin on desktop and mobile", () => {
  const store = createWorkspaceStore();
  for (const id of ["E", "D", "C", "B", "A"]) store.add(asset(id));
  store.focus("C");
  store.selectMobile("D");
  store.remove("E");
  store.remove("B");
  store.remove("missing");
  assert.equal(store.getSnapshot().focused_panel_id, "D");
  assert.equal(store.getSnapshot().mobile_panel_id, "D");
});

test("setup patches retain separate side drafts and namespaces, and Data supports all views hidden", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const original = store.getSnapshot().panels.A!;
  store.patchPanel("A", {
    coin: {
      ...original.coin,
      trade: {
        ...original.coin.trade,
        buy: { typed: "0.", mode: "typed" },
        sell: { typed: "12,345.000", mode: "half" },
      },
    },
    presale: {
      ...original.presale,
      commitment: {
        amount: ".",
        why: "draft 🪙",
        payment_coin_type: "0x2::sui::SUI",
      },
    },
  });
  store.patchDataControls("Portfolio", {
    ...store.getSnapshot().data.controls.Portfolio,
    tab: "presales",
    coins: { search: "saved", page: 2, hide_small: true },
  });
  store.selectDataView("Portfolio");
  for (const view of [
    "Coins",
    "Presales",
    "Bonding",
    "Traders",
    "Activity",
    "Feed",
    "Portfolio",
  ] as const)
    store.setDataViewEnabled(view, false);
  assert.equal(store.getSnapshot().data.selected_view, null);
  assert.deepEqual(store.getSnapshot().data.enabled_views, []);
  store.setDataViewEnabled("Feed", true);
  store.setDataViewEnabled("Portfolio", true);
  assert.equal(store.getSnapshot().data.selected_view, "Feed");
  assert.equal(
    store.getSnapshot().data.controls.Portfolio.coins.search,
    "saved",
  );
  store.openOnSell({ ...asset("A"), panel_id: "ignored", presale_id: "0x123" });
  const panel = store.getSnapshot().panels.A!;
  assert.equal(panel.coin.trade.side, "sell");
  assert.equal(panel.coin.trade.buy.typed, "0.");
  assert.equal(panel.coin.trade.sell.typed, "12,345.000");
  assert.equal(panel.presale.commitment.amount, ".");
  assert.equal(panel.presale_id, "0x123");
  assert.equal(store.getSnapshot().focused_panel_id, "A");
  assert.equal(store.getSnapshot().mobile_panel_id, "A");
});

test("versioned setup round-trips every field and more than 24 retained panels without converting typed drafts", () => {
  const store = createWorkspaceStore();
  for (let index = 0; index < 35; index += 1) store.add(asset(`Coin${index}`));
  const panel = store.getSnapshot().panels.Coin0!;
  store.patchPanel("Coin0", {
    coin: {
      ...panel.coin,
      chart: {
        renderer: "recharts",
        window: "launch",
        viewport: { from_ms: 1000, to_ms: 9000 },
      },
      trade: {
        ...panel.coin.trade,
        buy: { typed: "00000000000000000000000000001.", mode: "typed" },
        sell: { typed: ".000000", mode: "all" },
      },
      navigation: { scroll_top: 50, expanded_ids: ["saved"] },
    },
    presale: {
      ...panel.presale,
      terms_open: true,
      friends_all: true,
      commitment: {
        amount: ".",
        why: "🪙 draft",
        payment_coin_type: "0x2::sui::SUI",
      },
    },
  });
  store.setDataCollapsed(true);
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const decoded = decodeWorkspace(encoded.bytes);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.workspace, store.getSnapshot());
  assert.equal(decoded.workspace.retained_order.length, 31);
  assert.equal(
    decoded.workspace.panels.Coin0!.coin.trade.buy.typed,
    "00000000000000000000000000001.",
  );
  assert.equal(JSON.parse(encoded.bytes).schema_version, 1);
});

test("codec preserves invalid original bytes, rejects unsafe setup and never trims an oversized snapshot", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  for (const bytes of ["{broken", '{"schema_version":2,"future":"keep"}']) {
    const decoded = decodeWorkspace(bytes);
    assert.equal(decoded.ok, false);
    if (!decoded.ok) assert.equal(decoded.original_bytes, bytes);
  }
  const original = store.getSnapshot();
  const invalid = [
    { ...original, retained_order: ["A"] },
    { ...original, focused_panel_id: "absent" },
    { ...original, desktop_capacity: 5 },
    { ...original, balances: { private: "123" } },
    {
      ...original,
      data: { ...original.data, selected_view: "Coins", enabled_views: [] },
    },
    {
      ...original,
      panels: {
        ...original.panels,
        A: {
          ...original.panels.A,
          coin: {
            ...original.panels.A!.coin,
            trade: { ...original.panels.A!.coin.trade, slippage_bps: 501 },
          },
        },
      },
    },
  ];
  for (const value of invalid)
    assert.equal(decodeWorkspace(JSON.stringify(value)).ok, false);
  const panel = original.panels.A!;
  store.patchPanel("A", {
    coin: {
      ...panel.coin,
      trade: {
        ...panel.coin.trade,
        buy: { typed: "🪙".repeat(262144), mode: "typed" },
      },
    },
  });
  const large = encodeWorkspace(store.getSnapshot());
  assert.deepEqual(large, { ok: false, reason: "envelope_too_large" });
  let deep: unknown = "kept";
  for (let index = 0; index < 17; index += 1) deep = { next: deep };
  const nested = decodeWorkspace(JSON.stringify({ ...original, nested: deep }));
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.equal(nested.reason, "nesting_too_deep");
});

test("known missing Data visibility fields migrate without losing any saved controls", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const snapshot = store.getSnapshot();
  const prior = {
    ...snapshot,
    data: {
      collapsed: true,
      controls: {
        ...snapshot.data.controls,
        Portfolio: { ...snapshot.data.controls.Portfolio, tab: "presales" },
      },
    },
  };
  const result = decodeWorkspace(JSON.stringify(prior));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.migrated, true);
  assert.deepEqual(result.workspace.data.enabled_views, [
    "Coins",
    "Presales",
    "Bonding",
    "Traders",
    "Activity",
    "Feed",
    "Portfolio",
  ]);
  assert.equal(result.workspace.data.selected_view, "Coins");
  assert.equal(result.workspace.data.collapsed, true);
  assert.equal(result.workspace.data.controls.Portfolio.tab, "presales");
  assert.deepEqual(result.workspace.panels, snapshot.panels);
});

test("a setup saved before Bonding gains the view after Presales once, keeping every choice; one with every view off stays off", () => {
  const controls: Record<string, unknown> = { ...createWorkspaceStore().getSnapshot().data.controls };
  delete controls.Bonding;
  const before = (enabled: readonly string[], selected: string | null) => {
    const snapshot = createWorkspaceStore().getSnapshot();
    return JSON.stringify({ ...snapshot, data: { ...snapshot.data, enabled_views: enabled, selected_view: selected, controls } });
  };
  const saved = decodeWorkspace(before(["Coins", "Presales", "Feed"], "Feed"));
  assert.ok(saved.ok);
  assert.deepEqual(saved.workspace.data.enabled_views, ["Coins", "Presales", "Bonding", "Feed"]);
  assert.equal(saved.workspace.data.selected_view, "Feed");
  assert.deepEqual(saved.workspace.data.controls.Bonding, { view: "new", navigation: { scroll_top: 0, expanded_ids: [] } });
  // Once it has its controls, turning Bonding off sticks.
  const store = createWorkspaceStore();
  store.setDataViewEnabled("Bonding", false);
  const again = decodeWorkspace(encodeWorkspace(store.getSnapshot()).ok ? JSON.stringify(store.getSnapshot()) : "");
  assert.ok(again.ok);
  assert.equal(again.workspace.data.enabled_views.includes("Bonding"), false);
  const off = decodeWorkspace(before([], null));
  assert.ok(off.ok);
  assert.deepEqual(off.workspace.data.enabled_views, []);
  assert.equal(off.workspace.data.selected_view, null);
  const noPresales = decodeWorkspace(before(["Feed"], "Feed"));
  assert.ok(noPresales.ok);
  assert.deepEqual(noPresales.workspace.data.enabled_views, ["Feed", "Bonding"]);
});

test("subscribers receive one complete Sell operation and snapshots cannot be mutated outside the contract", () => {
  const store = createWorkspaceStore();
  const seen: string[] = [];
  const unsubscribe = store.subscribe(() => {
    const snapshot = store.getSnapshot();
    seen.push(snapshot.panels.A!.coin.trade.side);
  });
  store.openOnSell(asset("A"));
  assert.deepEqual(seen, ["sell"]);
  const snapshot = store.getSnapshot();
  assert.throws(() =>
    Object.assign(snapshot.panels.A!.coin.trade.buy, {
      typed: "changed outside model",
    }),
  );
  assert.equal(store.getSnapshot().panels.A!.coin.trade.buy.typed, "");
  unsubscribe();
  store.focus("A");
  assert.deepEqual(seen, ["sell"]);
  assert.throws(() => store.patchPanel("A", { panel_id: "other" } as never));
  assert.equal(store.getSnapshot().panels.A!.panel_id, "A");
});

test("panel patches cannot replace identity, while chain-normalized duplicates and invalid tab controls are rejected", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  assert.throws(() =>
    store.patchPanel("A", { coin_type: "0x3::coin::B" } as never),
  );
  assert.throws(() => store.add({ ...asset("B"), panel_id: "A" }));
  const snapshot = store.getSnapshot();
  assert.throws(() =>
    store.patchPanel("A", {
      coin: {
        ...snapshot.panels.A!.coin,
        tabs: { selected: "overview", enabled: [] },
      },
    }),
  );
  const alias = {
    ...snapshot.panels.A!,
    panel_id: "alias",
    coin_type: "0x02::coin::A",
  };
  assert.equal(
    decodeWorkspace(
      JSON.stringify({
        ...snapshot,
        panels: { ...snapshot.panels, alias },
        retained_order: ["alias"],
      }),
    ).ok,
    false,
  );
  assert.equal(store.getSnapshot(), snapshot);
});

test("the local snapshot limit counts UTF-8 bytes exactly and never erases the in-memory draft", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const base = encodeWorkspace(store.getSnapshot());
  assert.equal(base.ok, true);
  if (!base.ok) return;
  const space = 1_048_576 - new TextEncoder().encode(base.bytes).length;
  const setup = store.getSnapshot().panels.A!.coin;
  store.patchPanel("A", {
    coin: {
      ...setup,
      trade: {
        ...setup.trade,
        buy: { typed: "x".repeat(space), mode: "typed" },
      },
    },
  });
  const exact = encodeWorkspace(store.getSnapshot());
  assert.equal(exact.ok, true);
  if (exact.ok)
    assert.equal(new TextEncoder().encode(exact.bytes).length, 1_048_576);
  const full = store.getSnapshot().panels.A!.coin;
  store.patchPanel("A", {
    coin: {
      ...full,
      trade: {
        ...full.trade,
        buy: { typed: full.trade.buy.typed + "x", mode: "typed" },
      },
    },
  });
  assert.deepEqual(encodeWorkspace(store.getSnapshot()), {
    ok: false,
    reason: "envelope_too_large",
  });
  assert.equal(
    store.getSnapshot().panels.A!.coin.trade.buy.typed.length,
    space + 1,
  );
});

test("the complete write envelope accepts exactly one MiB of UTF-8 and rejects one extra byte without trimming", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const envelope = (): WorkspaceWriteEnvelope => ({
    initialize_if_absent: false,
    writer_id: "review-writer",
    sequence: 1,
    workspace: store.getSnapshot(),
  });
  const base = encodeWorkspaceWriteEnvelope(envelope());
  assert.ok(base.ok);
  assert.deepEqual(JSON.parse(base.bytes), envelope());
  const space = 1_048_576 - Buffer.byteLength(base.bytes);
  const typed = "🪙".repeat(Math.floor(space / 4)) + "0".repeat(space % 4);
  const coin = store.getSnapshot().panels.A!.coin;
  store.patchPanel("A", {
    coin: {
      ...coin,
      trade: { ...coin.trade, buy: { typed, mode: "typed" } },
    },
  });
  const exact = encodeWorkspaceWriteEnvelope(envelope());
  assert.ok(exact.ok);
  assert.equal(Buffer.byteLength(exact.bytes), 1_048_576);
  assert.equal(
    JSON.parse(exact.bytes).workspace.panels.A.coin.trade.buy.typed,
    typed,
  );
  const full = store.getSnapshot().panels.A!.coin;
  store.patchPanel("A", {
    coin: {
      ...full,
      trade: { ...full.trade, buy: { typed: typed + "0", mode: "typed" } },
    },
  });
  const snapshot = store.getSnapshot();
  assert.ok(encodeWorkspace(snapshot).ok);
  assert.deepEqual(encodeWorkspaceWriteEnvelope(envelope()), {
    ok: false,
    reason: "envelope_too_large",
  });
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(snapshot.panels.A!.coin.trade.buy.typed, typed + "0");
});

test("write envelopes validate all metadata and workspace membership without changing the snapshot", () => {
  const store = createWorkspaceStore();
  const workspace = store.getSnapshot();
  const envelope: WorkspaceWriteEnvelope = {
    initialize_if_absent: true,
    writer_id: "writer-🪙",
    sequence: 2,
    workspace,
  };
  const encoded = encodeWorkspaceWriteEnvelope(envelope);
  assert.ok(encoded.ok);
  assert.deepEqual(JSON.parse(encoded.bytes), envelope);
  for (const patch of [
    { initialize_if_absent: "false" },
    { writer_id: "" },
    { writer_id: 1 },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 0.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { sequence: Infinity },
    { sequence: "1" },
    { extra: true },
    { workspace: { ...workspace, visible_order: ["absent"] } },
  ])
    assert.equal(
      encodeWorkspaceWriteEnvelope({ ...envelope, ...patch } as never).ok,
      false,
    );
  assert.equal(store.getSnapshot(), workspace);
});

for (const view of ["coins", "presales"] as const) {
  test(`Portfolio ${view} search accepts 200 characters and rejects 201 atomically through patch and codec`, () => {
    const store = createWorkspaceStore();
    const controls = store.getSnapshot().data.controls.Portfolio;
    store.patchDataControls("Portfolio", {
      ...controls,
      [view]: { ...controls[view], search: "x".repeat(200) },
    });
    const snapshot = store.getSnapshot();
    const encoded = encodeWorkspace(snapshot);
    assert.ok(encoded.ok);
    const decoded = decodeWorkspace(encoded.bytes);
    assert.ok(decoded.ok);
    assert.equal(
      decoded.workspace.data.controls.Portfolio[view].search,
      "x".repeat(200),
    );
    const oversized = {
      ...snapshot.data.controls.Portfolio,
      [view]: { ...controls[view], search: "x".repeat(201) },
    };
    assert.throws(() => store.patchDataControls("Portfolio", oversized));
    assert.equal(store.getSnapshot(), snapshot);
    assert.deepEqual(encodeWorkspace(store.getSnapshot()), encoded);
    const invalid = {
      ...snapshot,
      data: {
        ...snapshot.data,
        controls: { ...snapshot.data.controls, Portfolio: oversized },
      },
    };
    assert.equal(encodeWorkspace(invalid).ok, false);
    const bytes = JSON.stringify(invalid);
    const rejected = decodeWorkspace(bytes);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.original_bytes, bytes);
  });
}

test("codec rejects runtime money, credentials and submission state at every setup boundary", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const snapshot = store.getSnapshot();
  for (const field of [
    "balances",
    "executable_quote",
    "private_key",
    "access_token",
    "built_transaction",
    "submission_progress",
  ]) {
    for (const value of [
      { ...snapshot, [field]: "excluded" },
      {
        ...snapshot,
        panels: { A: { ...snapshot.panels.A, [field]: "excluded" } },
      },
      {
        ...snapshot,
        data: {
          ...snapshot.data,
          controls: {
            ...snapshot.data.controls,
            Portfolio: {
              ...snapshot.data.controls.Portfolio,
              [field]: "excluded",
            },
          },
        },
      },
    ])
      assert.equal(decodeWorkspace(JSON.stringify(value)).ok, false, field);
  }
  const badDraft = {
    ...snapshot,
    panels: {
      A: {
        ...snapshot.panels.A,
        coin: {
          ...snapshot.panels.A!.coin,
          trade: {
            ...snapshot.panels.A!.coin.trade,
            buy: { typed: 0.1, mode: "typed" },
          },
        },
      },
    },
  };
  assert.equal(decodeWorkspace(JSON.stringify(badDraft)).ok, false);
});

test("prototype-bearing JSON cannot be accepted by dropping an unrecognized record", () => {
  const decoded = decodeWorkspace(
    '{"schema_version":1,"panels":{"__proto__":{}},"visible_order":[],"retained_order":[],"desktop_capacity":4,"focused_panel_id":null,"mobile_panel_id":null,"data":' +
      JSON.stringify(createWorkspaceStore().getSnapshot().data) +
      "}",
  );
  assert.equal(decoded.ok, false);
});

test("same symbols stay distinct, unresolved asset input changes nothing, and a resolved sale reuses its canonical panel", () => {
  const store = createWorkspaceStore();
  store.add({
    ...asset("sale"),
    coin_type: "0x3::coin::SAME",
    presale_id: "sale-1",
  });
  store.add({ ...asset("other"), coin_type: "0x4::coin::SAME" });
  const beforeFailure = store.getSnapshot();
  assert.throws(() => store.add({ ...asset("unknown"), coin_type: "" }));
  assert.equal(store.getSnapshot(), beforeFailure);
  const id = store.add({ ...asset("resolved"), coin_type: "0x03::coin::SAME" });
  assert.equal(id, "sale");
  assert.deepEqual(store.getSnapshot().visible_order, ["sale", "other"]);
  assert.equal(store.getSnapshot().panels.sale!.presale_id, "sale-1");
  assert.equal(Object.keys(store.getSnapshot().panels).length, 2);
});


test("closing a chart preserves its slot, targeted add fills it, and existing assets focus in place", () => {
  const store = createWorkspaceStore();
  for (const id of ["A", "B", "C", "D", "E"]) store.add(asset(id));
  const before = store.getSnapshot();
  const removed = before.visible_order[1]!;
  store.remove(removed);
  assert.deepEqual(store.getSnapshot().desktop_slots, ["E", null, "B", "C"]);
  assert.deepEqual(store.getSnapshot().retained_order, ["D"]);
  store.add(asset("F"), 1);
  assert.deepEqual(store.getSnapshot().desktop_slots, ["E", "F", "B", "C"]);
  store.add(asset("B"), 0);
  assert.deepEqual(store.getSnapshot().desktop_slots, ["E", "F", "B", "C"]);
  assert.equal(store.getSnapshot().focused_panel_id, "B");
  store.add(asset("G"), 2);
  assert.deepEqual(store.getSnapshot().desktop_slots, ["E", "F", "G", "C"]);
  assert.deepEqual(store.getSnapshot().retained_order, ["B", "D"]);
});


test("legacy dense setup normalizes slots and malformed current slots fail without losing original bytes", () => {
  const store=createWorkspaceStore();
  for(const id of ["A","B","C"]) store.add(asset(id));
  const legacy={...store.getSnapshot()};delete legacy.desktop_slots;
  const decoded=decodeWorkspace(JSON.stringify(legacy));
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.workspace.desktop_slots,["A","B","C",null]);
  store.remove("B");
  const hole=store.getSnapshot();
  const encoded=encodeWorkspace(hole);assert.ok(encoded.ok);
  const restored=decodeWorkspace(encoded.bytes);assert.ok(restored.ok);
  assert.deepEqual(restored.workspace.desktop_slots,["A",null,"C",null]);
  for(const slots of [["A","C"],["A","A",null,null],["C",null,"A",null],["A",null,"absent",null]]) {
    const bytes=JSON.stringify({...hole,desktop_slots:slots});
    const rejected=decodeWorkspace(bytes);assert.equal(rejected.ok,false);
    if(!rejected.ok)assert.equal(rejected.original_bytes,bytes);
  }
  store.reorder(["C","A"]);
  assert.deepEqual(store.getSnapshot().desktop_slots,["C",null,"A",null]);
  store.setCapacity(2);assert.deepEqual(store.getSnapshot().desktop_slots,["C","A"]);
  store.setCapacity(4);assert.deepEqual(store.getSnapshot().desktop_slots,["C","A",null,null]);
});

test("staged full-grid Sell candidate stays retained until explicit replacement and preserves independent drafts", () => {
  const store=createWorkspaceStore();
  for(const id of ["A","B","C","D"])store.add(asset(id));
  store.openOnSell(asset("E"),null);
  assert.deepEqual(store.getSnapshot().desktop_slots,["A","B","C","D"]);
  assert.deepEqual(store.getSnapshot().retained_order,["E"]);
  assert.equal(store.getSnapshot().panels.E!.coin.trade.side,"sell");
  store.add(asset("E"),1);
  assert.deepEqual(store.getSnapshot().desktop_slots,["A","E","C","D"]);
  assert.deepEqual(store.getSnapshot().retained_order,["B"]);
  const before=store.getSnapshot();assert.throws(()=>store.add(asset("F"),9));assert.equal(store.getSnapshot(),before);
});


test("pre-slot coin tab migration enables Posts while preserving selection and explicit all-hidden intent", () => {
  const store=createWorkspaceStore();store.add(asset("A"));store.add(asset("B"));
  for(const [id,enabled,selected] of [["A",["people"],"people"],["B",[],null]] as const) {
    const coin=store.getSnapshot().panels[id]!.coin;
    store.patchPanel(id,{coin:{...coin,tabs:{enabled:[...enabled],selected}}});
  }
  const legacy={...store.getSnapshot()};delete legacy.desktop_slots;
  const decoded=decodeWorkspace(JSON.stringify(legacy));assert.ok(decoded.ok);
  assert.deepEqual(decoded.workspace.panels.A!.coin.tabs,{enabled:["people","posts"],selected:"people"});
  assert.deepEqual(decoded.workspace.panels.B!.coin.tabs,{enabled:[],selected:null});
  const current=decodeWorkspace(JSON.stringify(store.getSnapshot()));assert.ok(current.ok);
  assert.deepEqual(current.workspace.panels.A!.coin.tabs.enabled,["people"],"a current explicit subset stays intentional");
});


test("explicit replacement adopts privately staged setup in one atomic durable transition", () => {
 const store=createWorkspaceStore();for(const id of ["A","B","C","D"])store.add(asset(id));
 const staged=createWorkspaceStore(store.getSnapshot());const id=staged.openOnSell(asset("E"),null);
 const candidate=staged.getSnapshot().panels[id]!;
 staged.patchPanel(id,{coin:{...candidate.coin,trade:{...candidate.coin.trade,sell:{typed:"00042.",mode:"typed"}}}});
 let transitions=0;store.subscribe(()=>{transitions++;assert.equal(store.getSnapshot().panels.E!.coin.trade.sell.typed,"00042.");});
 store.placePanel(staged.getSnapshot().panels[id]!,2);
 assert.equal(transitions,1);assert.deepEqual(store.getSnapshot().desktop_slots,["A","B","E","D"]);
 assert.equal(store.getSnapshot().panels.E!.coin.trade.side,"sell");assert.ok(store.getSnapshot().retained_order.includes("C"));
});


test("legacy presale views migrate to Sale, Commits and Posts without changing exact drafts or hidden intent", () => {
  const store = createWorkspaceStore();
  store.add({ ...asset("A"), presale_id: "sale-A" });
  const snapshot = store.getSnapshot();
  const legacyPresale = { ...snapshot.panels.A!.presale };
  delete legacyPresale.views_version;
  const prior = {
    ...snapshot,
    panels: {
      ...snapshot.panels,
      A: {
        ...snapshot.panels.A!,
        presale: {
          ...legacyPresale,
          tabs: { enabled: ["overview", "people", "activity"], selected: "people" },
          commitment: { ...legacyPresale.commitment, amount: "000123.450001" },
        },
      },
    },
  };
  const result = decodeWorkspace(JSON.stringify(prior));
  assert.ok(result.ok);
  assert.deepEqual(result.workspace.panels.A!.presale.tabs, { enabled: ["overview", "activity", "posts"], selected: "activity" });
  assert.equal(result.workspace.panels.A!.presale.commitment.amount, "000123.450001");
  const hiddenPrior = {
    ...prior,
    panels: { ...prior.panels, A: { ...prior.panels.A, presale: { ...prior.panels.A.presale, tabs: { enabled: [], selected: null } } } },
  };
  const hidden = decodeWorkspace(JSON.stringify(hiddenPrior));
  assert.ok(hidden.ok);
  assert.deepEqual(hidden.workspace.panels.A!.presale.tabs, { enabled: [], selected: null });
});


test("a discovered presale binding activates Sale atomically without moving focus, slots or drafts", () => {
  const store = createWorkspaceStore();
  store.add(asset("A")); store.add(asset("B"));
  const before = store.getSnapshot();
  store.resolvePresale("A", "sale-A");
  const after = store.getSnapshot();
  assert.equal(after.panels.A!.presale_id, "sale-A");
  assert.equal(after.panels.A!.active_namespace, "presale");
  assert.equal(after.focused_panel_id, before.focused_panel_id);
  assert.equal(after.mobile_panel_id, before.mobile_panel_id);
  assert.deepEqual(after.desktop_slots, before.desktop_slots);
  assert.deepEqual(after.panels.A!.coin, before.panels.A!.coin);
  assert.deepEqual(after.panels.A!.presale, before.panels.A!.presale);
  assert.throws(() => store.resolvePresale("A", "different-sale"), /Conflicting/);
});


test("legacy Compare restores one selected coin without losing slots, retained assets or drafts", () => {
  const store = createWorkspaceStore();
  assert.equal(store.getSnapshot().presentation, "focus");
  for (const id of ["A", "B", "C", "D", "E"]) store.add(asset(id));
  store.remove("B");
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed: "00042.", mode: "typed" } } } });
  const initial = store.getSnapshot();
  store.setPresentation("compare");
  assert.deepEqual(store.getSnapshot(), initial);
  const legacy = decodeWorkspace(JSON.stringify({ ...initial, presentation: "compare", mobile_panel_id: "A" }));
  assert.ok(legacy.ok);
  assert.deepEqual(legacy.workspace, initial);
  store.setPresentation("focus");
  assert.deepEqual(store.getSnapshot(), initial);
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const decoded = decodeWorkspace(encoded.bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.workspace, initial);
});

test("Undo restores the vacancy but never overwrites a re-added asset's newer draft", () => {
  const store = createWorkspaceStore();
  store.add(asset("A")); store.add(asset("B"));
  const removed = store.getSnapshot().panels.A!;
  store.remove("A"); store.restorePanel(removed, 0);
  assert.deepEqual(store.getSnapshot().desktop_slots, ["A", "B", null, null]);
  store.remove("A"); store.add(asset("A"));
  const latest = store.getSnapshot().panels.A!;
  store.patchPanel("A", { coin: { ...latest.coin, trade: { ...latest.coin.trade, buy: { typed: "73", mode: "typed" } } } });
  store.restorePanel(removed, 0);
  assert.equal(store.getSnapshot().panels.A!.coin.trade.buy.typed, "73");
});


test("workspace codec preserves legacy USD drafts and explicit token percentage units", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  for (const sell of [{ typed: "17", mode: "typed" } as const, { typed: "", mode: "quarter", unit: "token" } as const]) {
    const coin = store.getSnapshot().panels.A!.coin;
    store.patchPanel("A", { coin: { ...coin, trade: { ...coin.trade, side: "sell", sell } } });
    const encoded = encodeWorkspace(store.getSnapshot());
    assert.ok(encoded.ok);
    const decoded = decodeWorkspace(encoded.bytes);
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.workspace.panels.A!.coin.trade.sell, sell);
  }
});


test("section layout survives serialization and rejects invalid saved layouts atomically", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const layout = { order: ["trade", "chart", "details", "activity"], hidden: ["activity"], split: 55, heights: { chart: 540, trade: 360 } } as const;
  store.setLayout(layout);
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const restored = decodeWorkspace(encoded.bytes);
  assert.ok(restored.ok);
  assert.deepEqual(restored.workspace.layout, layout);
  const before = store.getSnapshot();
  for (const invalid of [{ ...layout, order: ["trade", "trade", "details", "activity"] }, { ...layout, hidden: ["chart"] }, { ...layout, split: 71 }, { ...layout, heights: { chart: 901 } }, { ...layout, heights: { unknown: 320 } }]) {
    assert.throws(() => store.setLayout(invalid as typeof layout));
    assert.equal(store.getSnapshot(), before);
    assert.equal(decodeWorkspace(JSON.stringify({ ...before, layout: invalid })).ok, false);
  }
});


test("terminal sizes round-trip independently of legacy layout and reject corrupt geometry", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const layout = { order: ["trade", "chart", "details", "activity"], hidden: ["activity"], split: 55, terminal: { order: ["chart", "activity", "trade"], widths: [48, 27, 25], height: 520, stacked_order: ["chart", "activity", "trade"], stacked_height: 340 } } as const;
  store.setLayout(layout);
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const decoded = decodeWorkspace(encoded.bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.workspace.layout, layout);
  const before = store.getSnapshot();
  for (const terminal of [
    { ...layout.terminal, widths: [50, 25, 26] },
    { ...layout.terminal, widths: [65, 20, 15] },
    { ...layout.terminal, widths: [50.5, 24.5, 25] },
    { ...layout.terminal, order: ["chart", "chart", "trade"] },
    { ...layout.terminal, height: 279 },
    { ...layout.terminal, stacked_height: 901 },
  ]) {
    const invalid = { ...layout, terminal };
    assert.throws(() => store.setLayout(invalid as unknown as typeof layout));
    assert.equal(store.getSnapshot(), before);
    assert.equal(decodeWorkspace(JSON.stringify({ ...before, layout: invalid })).ok, false);
  }
});

test("Buy more switches side atomically, keeps drafts and stays private until staged placement", () => {
  const store = createWorkspaceStore();
  store.openOnSell(asset("A"));
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { mode: "typed", typed: "12.34" }, sell: { mode: "typed", typed: "1.000000001" } } } });
  const before = store.getSnapshot();
  const staged = createWorkspaceStore(before);
  assert.equal(staged.openOnBuy({ ...asset("A"), panel_id: "ignored" }, null), "A");
  assert.equal(store.getSnapshot(), before);
  assert.equal(staged.getSnapshot().panels.A!.coin.trade.side, "buy");
  const sides: string[] = [];
  const unsubscribe = store.subscribe(() => sides.push(store.getSnapshot().panels.A!.coin.trade.side));
  store.placePanel(staged.getSnapshot().panels.A!, 0);
  unsubscribe();
  assert.deepEqual(sides, ["buy"]);
  assert.equal(store.getSnapshot().panels.A!.coin.trade.buy.typed, "12.34");
  assert.equal(store.getSnapshot().panels.A!.coin.trade.sell.typed, "1.000000001");
  assert.equal(Object.keys(store.getSnapshot().panels).length, 1);
});


test("chart range and interval survive the version-one workspace journal", () => {
  const store = createWorkspaceStore();
  store.add(asset("A"));
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", { coin: { ...panel.coin, chart: { renderer: "recharts", window: "30d", interval: "1d", viewport: null } } });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const decoded = decodeWorkspace(encoded.bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.workspace.panels.A!.coin.chart, { renderer: "recharts", window: "30d", interval: "1d", viewport: null });
});

test("saved candle style and volume preference survive workspace encoding", () => {
  const store = createWorkspaceStore();
  store.add(asset("Candles"));
  const panel = store.getSnapshot().panels.Candles!;
  store.patchPanel("Candles", { coin: { ...panel.coin, chart: { renderer: "recharts", window: "7d", interval: "15m", style: "candles", volume: false, viewport: null } } });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.ok(encoded.ok);
  const decoded = decodeWorkspace(encoded.bytes);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.workspace.panels.Candles!.coin.chart, store.getSnapshot().panels.Candles!.coin.chart);
});
