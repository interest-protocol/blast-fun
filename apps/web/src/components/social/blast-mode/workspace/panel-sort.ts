import type { WorkspaceStore } from "./model";

export type PanelSortBox = Readonly<{ id: string; left: number; top: number; width: number; height: number }>;
export type PanelSortPoint = Readonly<{ x: number; y: number }>;
type Projection = Readonly<{ order: readonly string[]; offsets: ReadonlyMap<string, PanelSortPoint> }>;

/** A gesture-local projection. The workspace is written only by a successful finish. */
export function createPanelSort(activeId: string, order: readonly string[], boxes: readonly PanelSortBox[]) {
  const original = [...order];
  const geometry = new Map(boxes.map(box => [box.id, box]));
  const source = geometry.get(activeId);
  if (!source || !original.includes(activeId) || new Set(original).size !== original.length ||
    original.some(id => { const box = geometry.get(id); return !box || ![box.left, box.top, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0; })) return null;
  let projected = original;
  let finished = false;
  return {
    move(delta: PanelSortPoint): Projection {
      let target = original.indexOf(activeId);
      let distance = Infinity;
      for (const [index, id] of original.entries()) {
        const box = geometry.get(id)!;
        const candidate = Math.hypot(source.left + source.width / 2 + delta.x - box.left - box.width / 2, source.top + source.height / 2 + delta.y - box.top - box.height / 2);
        if (candidate < distance) { distance = candidate; target = index; }
      }
      projected = original.filter(id => id !== activeId);
      projected.splice(target, 0, activeId);
      const offsets = new Map<string, PanelSortPoint>();
      for (const [index, id] of projected.entries()) {
        const from = geometry.get(id)!;
        const to = geometry.get(original[index]!)!;
        offsets.set(id, id === activeId ? delta : { x: to.left - from.left, y: to.top - from.top });
      }
      return { order: projected, offsets };
    },
    finish(store: Pick<WorkspaceStore, "getSnapshot" | "reorder">, canceled = false): boolean {
      if (finished) return false;
      finished = true;
      const current = store.getSnapshot().visible_order;
      if (canceled || current.length !== original.length || current.some((id, index) => id !== original[index]) || projected.every((id, index) => id === original[index])) return false;
      store.reorder(projected);
      return true;
    },
  };
}
