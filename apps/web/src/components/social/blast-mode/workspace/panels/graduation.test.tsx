import assert from "node:assert/strict";
import test from "node:test";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { createWorkspaceStore } from "../model";
import {
  decodeWorkspace,
  encodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import { isPresaleHistory, presaleHistory } from "../presale-history";
import { WorkspaceLiveProvider } from "../live-clock";
import { handClock } from "../../../../../../test/fixtures/workspace/live-clock.ts";
import { PresalePanel } from "./PresalePanel";
import {
  presaleAsset,
  presaleDetail,
} from "../../../../../../test/fixtures/workspace/presale-fixtures.ts";

async function mount(inspectHistory = false, initialDetail = presaleDetail()) {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    // Next's Link (the sale page link) schedules prefetch work on `self`.
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const client = createTestQueryClient();
  const time = handClock();
  const store = createWorkspaceStore();
  if(inspectHistory)presaleHistory(store).add("P");
  store.add({ panel_id: "P", ...presaleAsset });
  store.add({
    panel_id: "other",
    ...presaleAsset,
    presale_id: null,
    coin_type: "0x2::other::OTHER",
  });
  const panel = store.getSnapshot().panels.P!;
  store.patchPanel("P", {
    coin: {
      ...panel.coin,
      tabs: { selected: "people", enabled: ["people", "overview"] },
      chart: {
        renderer: "recharts",
        window: "launch",
        viewport: { from_ms: 10, to_ms: 20 },
      },
      navigation: { scroll_top: 54, expanded_ids: ["saved"] },
      trade: {
        ...panel.coin.trade,
        buy: { typed: "00042.", mode: "typed" },
        sell: { typed: ".0001", mode: "typed" },
      },
    },
    presale: {
      ...panel.presale,
      // A saved tab outside Blast mode's Sale/Backers pair: it reads as Sale and is never rewritten.
      tabs: { selected: "activity", enabled: ["activity", "overview"] },
      commitment: {
        amount: "123.450001",
        why: "Saved presale only",
        payment_coin_type: null,
      },
    },
  });
  let detail = initialDetail;
  let failure = false;
  let visible = true;
  let reads = 0;
  const source = {
    detail: async () => {
      reads++;
      if (failure) throw new Error("Controlled read failure");
      return detail;
    },
    viewer: async () => null,
  };
  const onTradingAvailable = () =>
    store.patchPanel("P", { active_namespace: "coin" });
  function Subject() {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    const setup = snapshot.panels.P!;
    return (
      <QueryProvider client={client}>
        <WorkspaceLiveProvider clock={time.clock}>
        <PresalePanel
          inspectHistory={isPresaleHistory(store,"P")}
          panel_id="P"
          asset={setup}
          presale_setup={setup.presale}
          onSetupChange={(presale) => store.patchPanel("P", { presale })}
          onTradingAvailable={onTradingAvailable}
          effective_visibility={visible}
          actions={{
            commit: null,
            authenticated: false,
            actor_key: "guest",
            signIn: () => {},
          }}
          reads={source}
        />
        </WorkspaceLiveProvider>
      </QueryProvider>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const render = () => act(async () => root.render(<Subject />));
  await render();
  return {
    store,
    render,
    hide:()=>act(async()=>root.render(null)),
    setDetail: (value: typeof detail) => {
      detail = value;
    },
    setFailure: (value: boolean) => {
      failure = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    reads: () => reads,
    /** The panel's own poll (every 15 s, `POLL_MS`): one interval on the host clock, then the answer. */
    async refresh() {
      const before = reads;
      await act(async () => {
        time.advance(15_000);
        await new Promise((settle) => setTimeout(settle, 0));
      });
      assert.ok(reads > before, "the presented presale reads again on its poll");
    },
    async close() {
      await act(async () => root.unmount());
      client.clear();
      dom.window.close();
    },
  };
}

test("authoritative trading activates the same panel without changing either saved setup or its place", async () => {
  const fixture = await mount();
  try {
    const before = fixture.store.getSnapshot();
    for (const phase of ["closed", "funded"] as const) {
      const detail = presaleDetail(phase);
      fixture.setDetail({
        ...detail,
        presale: { ...detail.presale, fill_bps: 10000, end_ms: 1 },
      });
      await fixture.refresh();
      assert.equal(
        fixture.store.getSnapshot().panels.P!.active_namespace,
        "presale",
      );
    }
    fixture.setDetail(presaleDetail("trading"));
    await fixture.refresh();
    const after = fixture.store.getSnapshot();
    assert.equal(after.panels.P!.active_namespace, "coin");
    assert.deepEqual(after, {
      ...before,
      panels: {
        ...before.panels,
        P: { ...before.panels.P!, active_namespace: "coin" },
      },
    });
    const encoded = encodeWorkspace(after);
    assert.equal(encoded.ok, true);
    if (encoded.ok)
      assert.deepEqual(decodeWorkspace(encoded.bytes), {
        ok: true,
        workspace: after,
        migrated: false,
      });
    await act(async () => {
      const id = fixture.store.add({
        ...presaleAsset,
        panel_id: "coin-readded",
        presale_id: null,
      });
      assert.equal(id, "P");
    });
    assert.equal(Object.keys(fixture.store.getSnapshot().panels).length, 2);
  } finally {
    await fixture.close();
  }
});

test("retained presales read trading only when presented again and keep the default Chart tab", async () => {
  const fixture = await mount();
  try {
    await act(async () => {
      fixture.store.setCapacity(1);
      const panel = fixture.store.getSnapshot().panels.P!;
      fixture.store.patchPanel("P", {
        coin: {
          ...panel.coin,
          tabs: {
            selected: "overview",
            enabled: ["overview", "people", "activity"],
          },
        },
      });
    });
    const before = fixture.store.getSnapshot();
    fixture.setVisible(false);
    await fixture.render();
    const reads = fixture.reads();
    fixture.setDetail(presaleDetail("trading"));
    await fixture.render();
    assert.equal(fixture.reads(), reads);
    assert.equal(
      fixture.store.getSnapshot().panels.P!.active_namespace,
      "presale",
    );
    assert.deepEqual(fixture.store.getSnapshot().retained_order, ["other"]);
    await act(async()=>fixture.store.add({panel_id:"other",chain:"sui",network:"mainnet",coin_type:"0x2::other::OTHER",presale_id:null}));
    assert.deepEqual(fixture.store.getSnapshot().retained_order,["P"]);
    await act(async () => {
      fixture.store.add({ panel_id: "again", ...presaleAsset });
    });
    fixture.setVisible(true);
    await fixture.render();
    const after = fixture.store.getSnapshot();
    assert.equal(after.panels.P!.active_namespace, "coin");
    assert.equal(after.panels.P!.coin.tabs.selected, "overview");
    assert.deepEqual(after.panels.P!.coin, before.panels.P!.coin);
    assert.deepEqual(after.panels.P!.presale, before.panels.P!.presale);
    assert.deepEqual(after.visible_order, ["P"]);
    assert.deepEqual(after.retained_order, ["other"]);
  } finally {
    await fixture.close();
  }
});

test("failed or mismatched authoritative identity never graduates and a retry recovers", async () => {
  const fixture = await mount();
  try {
    const before = fixture.store.getSnapshot();
    fixture.setFailure(true);
    await fixture.refresh();
    assert.match(document.body.textContent!, /Presale could not load/);
    assert.deepEqual(fixture.store.getSnapshot(), before);
    fixture.setFailure(false);
    const detail = presaleDetail("trading");
    for (const presale of [
      { ...detail.presale, presale_id: "different" },
      { ...detail.presale, sale_token: "0x2::same_symbol::KSTL" },
      { ...detail.presale, sale_token: "invalid" },
    ]) {
      fixture.setDetail({ ...detail, presale });
      await fixture.refresh();
      assert.match(
        document.body.textContent!,
        /Presale information is unavailable/,
      );
      assert.deepEqual(fixture.store.getSnapshot(), before);
    }
    fixture.setDetail({ ...detail, terms: null });
    await fixture.refresh();
    assert.equal(
      fixture.store.getSnapshot().panels.P!.active_namespace,
      "coin",
    );
    assert.deepEqual(
      fixture.store.getSnapshot().panels.P!.presale,
      before.panels.P!.presale,
    );
  } finally {
    await fixture.close();
  }
});


test("manual presale history stays selected for an already trading coin while a newly observed graduation still switches", async () => {
  const fixture=await mount(true,presaleDetail("trading"));
  try {
    assert.equal(fixture.store.getSnapshot().panels.P!.active_namespace,"presale");
    await fixture.refresh();
    assert.equal(fixture.store.getSnapshot().panels.P!.active_namespace,"presale");
    fixture.setDetail(presaleDetail("closed"));await fixture.refresh();
    fixture.setDetail(presaleDetail("trading"));await fixture.refresh();
    assert.equal(fixture.store.getSnapshot().panels.P!.active_namespace,"coin");
  } finally {await fixture.close();}
});


test("ordinary unmount and re-entry graduates while explicit history intent survives panel unmount", async () => {
 for(const manual of [false,true]) {
  const fixture=await mount(manual,presaleDetail("closed"));
  try {
   const before=fixture.store.getSnapshot();
   await fixture.hide();fixture.setDetail(presaleDetail("trading"));await fixture.render();
   assert.equal(fixture.store.getSnapshot().panels.P!.active_namespace,manual?"presale":"coin");
   assert.deepEqual(fixture.store.getSnapshot().desktop_slots,before.desktop_slots);
   assert.deepEqual(fixture.store.getSnapshot().panels.P!.coin,before.panels.P!.coin);
   assert.deepEqual(fixture.store.getSnapshot().panels.P!.presale,before.panels.P!.presale);
  } finally {await fixture.close();}
 }
});
