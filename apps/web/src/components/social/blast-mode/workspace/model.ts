import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { validateWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { WorkspaceLayoutSchema, type WorkspaceLayout } from "@blast/core/modules/social/blast-workspace/workspace-layout-model.ts";
import {
  DATA_VIEWS,
  DataControlsSchema,
  PanelSchema,
  PanelPatchSchema,
  emptyWorkspace,
  newPanel,
  type DataControls,
  type DataView,
  type PanelInput,
  type PanelSetup,
  type PanelPatch,
  type WorkspaceV1,
} from "@blast/core/modules/social/blast-workspace/setup.ts";

export function createWorkspaceStore(initial: WorkspaceV1 = emptyWorkspace()) {
  let state = validateWorkspace(initial);
  const listeners = new Set<() => void>();
  function commit(next: WorkspaceV1) {
    state = validateWorkspace(next);
    for (const listener of listeners) listener();
  }
  function placement(id:string,targetSlot?:number|null) {
    const slots=[...state.desktop_slots!];
    let retained=state.retained_order.filter(value=>value!==id);
    if(state.visible_order.includes(id)) return {slots,retained};
    if(targetSlot === null) return {slots,retained:[id,...retained]};
    if(targetSlot !== undefined && (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= slots.length)) throw new Error("Invalid target slot");
    const vacancy=slots.indexOf(null);
    if(targetSlot !== undefined || vacancy >= 0) {
      const target=targetSlot ?? vacancy;
      const displaced=slots[target];
      if(displaced)retained=[displaced,...retained];
      slots[target]=id;
    } else {
      // Programmatic full-grid additions keep the established prepend/displace behavior.
      const displaced=slots.pop();slots.unshift(id);
      if(displaced)retained=[displaced,...retained];
    }
    return {slots,retained};
  }
  function add(input: PanelInput, side: "buy" | "sell" | undefined = undefined, targetSlot?: number | null, confirmed?: PanelSetup) {
    const panel = newPanel(input);
    const existing = Object.values(state.panels).find(
      (value) =>
        value.chain === panel.chain &&
        value.network === panel.network &&
        value.coin_type === panel.coin_type,
    );
    if (!existing && Object.hasOwn(state.panels, panel.panel_id))
      throw new Error("Panel id already belongs to another asset");
    if (
      existing?.presale_id &&
      panel.presale_id &&
      existing.presale_id !== panel.presale_id
    )
      throw new Error("Conflicting presale binding");
    const id = existing?.panel_id ?? panel.panel_id;
    let setup = existing
      ? { ...existing, presale_id: existing.presale_id ?? panel.presale_id }
      : panel;
    if (confirmed) setup = PanelSchema.parse({...confirmed,panel_id:id});
    if (side)
      setup = {
        ...setup,
        active_namespace: "coin",
        coin: { ...setup.coin, trade: { ...setup.coin.trade, side } },
      };
    const {slots,retained} = placement(id,targetSlot);
    commit({
      ...state,
      panels: { ...state.panels, [id]: setup },
      focused_panel_id: targetSlot === null ? state.focused_panel_id : id,
      mobile_panel_id: targetSlot === null ? state.mobile_panel_id : id,
      desktop_slots: slots,
      visible_order: slots.filter((value): value is string => value !== null),
      retained_order: retained,
    });
    return id;
  }
  function patchPanel(id: string, patch: PanelPatch) {
    if (!Object.hasOwn(state.panels, id)) throw new Error("Unknown panel");
    const panel = PanelSchema.parse({
      ...state.panels[id],
      ...PanelPatchSchema.parse(patch),
    });
    commit({ ...state, panels: { ...state.panels, [id]: panel } });
  }
  function remove(id: string) {
    if (!Object.hasOwn(state.panels, id)) return;
    const index = state.visible_order.indexOf(id);
    const panels = { ...state.panels };
    delete panels[id];
    const visible = state.visible_order.filter((value) => value !== id);
    const retained = state.retained_order.filter((value) => value !== id);

    const fallback = visible[index] ?? visible[visible.length - 1] ?? null;
    commit({
      ...state,
      panels,
      desktop_slots: state.desktop_slots!.map((value) => value === id ? null : value),
      visible_order: visible,
      retained_order: retained,
      focused_panel_id:
        state.focused_panel_id === id ? fallback : state.focused_panel_id,
      mobile_panel_id:
        state.mobile_panel_id === id ? fallback : state.mobile_panel_id,
    });
  }
  /**
   * The person's "Show SUI" on a coin no source has a record of: the panel
   * becomes SUI in its own slot, keeping its setup; when SUI is already open,
   * this panel goes instead. Never called without that press.
   */
  function showSui(id: string) {
    const current = state.panels[id];
    if (!current || current.network !== "mainnet" || current.coin_type === SUI_COIN_TYPE) return;
    if (Object.values(state.panels).some((value) => value.chain === current.chain && value.network === current.network && value.coin_type === SUI_COIN_TYPE)) return remove(id);
    const panel = PanelSchema.parse({ ...current, coin_type: SUI_COIN_TYPE, presale_id: null, active_namespace: "coin" });
    commit({ ...state, panels: { ...state.panels, [id]: panel } });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add: (input: PanelInput, targetSlot?: number | null) => add(input, undefined, targetSlot),
    setPresentation(presentation: "focus" | "compare") {
      commit({ ...state, presentation });
    },
    setLayout(layout: WorkspaceLayout) {
      commit({ ...state, layout: WorkspaceLayoutSchema.parse(layout) });
    },
    restorePanel(panel: PanelSetup, slot: number) {
      const target = slot >= 0 && slot < state.desktop_capacity && state.desktop_slots![slot] === null ? slot : null;
      const existing = Object.values(state.panels).some(value => value.chain === panel.chain && value.network === panel.network && value.coin_type === panel.coin_type);
      return add(panel, undefined, target, existing ? undefined : panel);
    },
    resolvePresale(id: string, presaleId: string) {
      const current = state.panels[id];
      if (!current) return;
      if (current.presale_id && current.presale_id !== presaleId)
        throw new Error("Conflicting presale binding");
      const panel = PanelSchema.parse({ ...current, presale_id: presaleId, active_namespace: "presale" });
      commit({ ...state, panels: { ...state.panels, [id]: panel } });
    },
    placePanel(panel: PanelSetup, targetSlot: number) {
      return add(panel, undefined, targetSlot, panel);
    },
    remove,
    showSui,
    setCapacity(capacity: number) {
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4)
        throw new Error("Invalid capacity");
      const shrinking = capacity < state.desktop_capacity;
      const slots = Array.from({ length: capacity }, (_, index) => (shrinking ? state.visible_order[index] : state.desktop_slots![index]) ?? null);
      const displaced = shrinking ? state.visible_order.slice(capacity) : [];
      const visible = slots.filter((id): id is string => id !== null);
      commit({
        ...state,
        desktop_capacity: capacity,
        desktop_slots: slots,
        visible_order: visible,
        retained_order: [...displaced, ...state.retained_order],
        focused_panel_id: visible.includes(state.focused_panel_id!) ? state.focused_panel_id : visible[0] ?? null,
        mobile_panel_id: visible.includes(state.mobile_panel_id!) ? state.mobile_panel_id : visible[0] ?? null,
      });
    },
    reorder(order: readonly string[], committed = true) {
      if (!committed) return;
      const visible = new Set(state.visible_order);
      if (
        order.length !== state.visible_order.length ||
        new Set(order).size !== order.length ||
        order.some((id) => !visible.has(id))
      )
        throw new Error("Invalid order");
      let index = 0;
      commit({ ...state, visible_order: [...order], desktop_slots: state.desktop_slots!.map((id) => id === null ? null : order[index++]!) });
    },
    focus(id: string) {
      if (!state.visible_order.includes(id))
        throw new Error("Panel is not visible");
      commit({ ...state, focused_panel_id: id, mobile_panel_id: id });
    },
    selectMobile(id: string) {
      if (!state.visible_order.includes(id))
        throw new Error("Panel is not visible");
      commit({ ...state, focused_panel_id: id, mobile_panel_id: id });
    },
    patchPanel,
    openOnBuy(input: PanelInput, targetSlot?: number | null) {
      return add(input, "buy", targetSlot);
    },
    openOnSell(input: PanelInput, targetSlot?: number | null) {
      return add(input, "sell", targetSlot);
    },
    selectDataView(view: DataView) {
      if (!state.data.enabled_views.includes(view))
        throw new Error("Data view is hidden");
      commit({ ...state, data: { ...state.data, selected_view: view } });
    },
    setDataViewEnabled(view: DataView, enabled: boolean) {
      if (!DATA_VIEWS.includes(view)) throw new Error("Unknown Data view");
      const views = DATA_VIEWS.filter((key) =>
        key === view ? enabled : state.data.enabled_views.includes(key),
      );
      const selected = state.data.selected_view;
      commit({
        ...state,
        data: {
          ...state.data,
          enabled_views: views,
          selected_view:
            selected !== null && views.includes(selected)
              ? selected
              : (views[0] ?? null),
        },
      });
    },
    setDataCollapsed(collapsed: boolean) {
      commit({ ...state, data: { ...state.data, collapsed } });
    },
    patchDataControls<K extends DataView>(view: K, controls: DataControls[K]) {
      const next = DataControlsSchema.parse({
        ...state.data.controls,
        [view]: controls,
      });
      commit({ ...state, data: { ...state.data, controls: next } });
    },
  };
}
export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
