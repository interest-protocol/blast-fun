import type { WorkspaceStore } from "./model";

/** Open the shared market browser and focus its search field. */
export function openWorkspaceSearch(store: WorkspaceStore) {
  store.setDataViewEnabled("Coins", true);
  store.selectDataView("Coins");
  store.setDataCollapsed(false);
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#workspace-data input[type="search"]')?.focus());
}
