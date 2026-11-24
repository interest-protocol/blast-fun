import type { WorkspaceStore } from "./model";

// Presentation intent belongs to the workspace lifetime, not a mounted panel or saved market facts.
const historyByStore=new WeakMap<WorkspaceStore,Set<string>>();
export function presaleHistory(store:WorkspaceStore):Set<string> {
  let history=historyByStore.get(store);
  if(!history){history=new Set();historyByStore.set(store,history);}
  return history;
}
export function isPresaleHistory(store:WorkspaceStore,id:string):boolean {
  return presaleHistory(store).has(id);
}
