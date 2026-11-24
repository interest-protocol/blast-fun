/** Minimum outer card sizes: identity, 120px chart, complete ticket and feedback. */
export const COMPARE_CARD_WIDTH = 360;
export const COMPARE_CARD_HEIGHT = 446;
// Reserve the largest responsive grid gap so a fourth card never adds scrolling.
const COMPARE_GRID_GAP = 24;
export function compareAvailablePageSize(width: number, height: number): 1 | 2 | 4 {
  if (width < COMPARE_CARD_WIDTH * 2 + COMPARE_GRID_GAP) return 1;
  return height >= COMPARE_CARD_HEIGHT * 2 + COMPARE_GRID_GAP ? 4 : 2;
}
/** Pre-measurement fallback only; ResizeObserver supplies the actual workspace. */
export function comparePageSize(width: number, height: number, discoveryOpen: boolean): 1 | 2 | 4 {
  const discovery = discoveryOpen ? (width >= 1280 ? 320 : 300) + 16 : 44;
  return compareAvailablePageSize(width - 48 - discovery, height - 100);
}
export function comparePage(ids: readonly string[], selected: string | null, pageSize: number) {
  const index = Math.max(0, ids.indexOf(selected ?? ""));
  const start = Math.floor(index / pageSize) * pageSize;
  return { start, ids: ids.slice(start, start + pageSize) };
}
