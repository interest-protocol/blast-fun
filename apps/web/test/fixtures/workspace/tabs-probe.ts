import type { DataView, WorkspaceV1 } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { WorkspaceStore } from "../../../src/components/social/blast-mode/workspace/model.ts";

type Pending = { view: DataView; signal: AbortSignal; resolve: () => void };
function createProbe() {
  const starts: DataView[] = [];
  const stops: DataView[] = [];
  const accepted: DataView[] = [];
  const reads: DataView[] = [];
  const active = new Set<DataView>();
  const hold = new Set<DataView>();
  const pending: Pending[] = [];
  let setup: WorkspaceV1 | null = null;
  let shellTicks = 0;
  return {
    // No transaction kit or signer exists in this root fixture.
    snapshot: () => ({ starts: [...starts], stops: [...stops], accepted: [...accepted], reads: [...reads], active: [...active], pending: pending.map(({ view, signal }) => ({ view, aborted: signal.aborted })), shellTicks, financialSends: 0, setup }),
    setup(value: WorkspaceV1) { setup = value; },
    tickShell() { shellTicks++; },
    start(view: DataView) { active.add(view); starts.push(view); },
    stop(view: DataView) { active.delete(view); stops.push(view); },
    accept(view: DataView) { accepted.push(view); },
    holdNext(view: DataView) { hold.add(view); },
    read(view: DataView, signal: AbortSignal) {
      reads.push(view);
      if (!hold.delete(view)) return Promise.resolve();
      return new Promise<void>((resolve) => pending.push({ view, signal, resolve }));
    },
    release(view: DataView) {
      for (let index = pending.length - 1; index >= 0; index--) {
        if (pending[index]!.view === view) pending.splice(index, 1)[0]!.resolve();
      }
    },
  };
}
type Probe = ReturnType<typeof createProbe>;
export function tabsProbe(): Probe {
  const target = window as unknown as { workspaceTabsProbe?: Probe };
  return target.workspaceTabsProbe ??= createProbe();
}

export function setFixtureDataPosition<K extends DataView>(store: WorkspaceStore, view: K, value: number) {
  const controls = store.getSnapshot().data.controls[view];
  store.patchDataControls(view, { ...controls, navigation: { ...controls.navigation, scroll_top: Math.max(0, value) } });
}
