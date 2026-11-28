/**
 * The page's modal sheets as one stack, in the order they opened (OA-31).
 * Every sheet — the shared `Sheet` and the settings page's link-a-wallet
 * sheet — opens, closes and leaves through here, so that with two on the
 * page at once (one still closing as the next opens, or sign-in over a
 * sale):
 *
 * - the newest is drawn on top and is the one Escape and Tab belong to; a
 *   closing sheet keeps its place in the stack but is no longer a layer;
 * - the page stays scroll-locked while any sheet is open;
 * - a sheet that has finished closing hands focus back only when no sheet
 *   opened after it is still open, and to the first of its return targets
 *   still in the page and not in a closing sheet: the control that opened
 *   it, else whatever opened the sheet that control sat in (Commit →
 *   Deposit: the Deposit button leaves with the commit sheet).
 */

/** `Sheet.module.css`'s scrim; the toasts (90) stay above every sheet. */
const BASE_Z = 80;
const TOP_Z = 89;

export type SheetLayer = Readonly<{
  scrim: HTMLElement;
  sheet: HTMLElement;
  /** Where focus goes back, first choice first. */
  returns: readonly HTMLElement[];
}>;

type Entry = SheetLayer & { open: boolean };

const stack: Entry[] = [];

function restack(): void {
  const top = stack.findLastIndex((entry) => entry.open);
  stack.forEach((entry, index) => {
    entry.scrim.style.zIndex = String(Math.min(BASE_Z + index, TOP_Z));
    entry.sheet.toggleAttribute("inert", entry.open && index < top);
  });
}

function lockScroll(): void {
  document.body.style.overflow = stack.some((entry) => entry.open) ? "hidden" : "";
}

/** Where focus goes back when a sheet opening now closes: the focused control, then its own sheet's targets. */
export function sheetReturnTargets(): readonly HTMLElement[] {
  const from = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (from === null) return [];
  const owner = stack.find((entry) => entry.sheet.contains(from));
  return [from, ...(owner?.returns ?? [])];
}

/** A sheet opens, or is caught while closing: it goes on top, and the page locks. */
export function openSheetLayer(layer: SheetLayer): void {
  const index = stack.findIndex((entry) => entry.sheet === layer.sheet);
  if (index >= 0) stack.splice(index, 1);
  stack.push({ ...layer, open: true });
  restack();
  lockScroll();
}

/** A sheet starts to close: it stops being a layer at once, and stays drawn where it was until it is gone. */
export function closeSheetLayer(sheet: HTMLElement): void {
  const entry = stack.find((candidate) => candidate.sheet === sheet);
  if (!entry) return;
  entry.open = false;
  restack();
}

/**
 * A sheet is gone (its closing motion ended, or it left the page): the page
 * unlocks once no sheet is open. Answers where focus goes back, or null
 * while a sheet opened after it is still open.
 */
export function removeSheetLayer(sheet: HTMLElement): HTMLElement | null {
  const index = stack.findIndex((entry) => entry.sheet === sheet);
  if (index < 0) return null;
  const [entry] = stack.splice(index, 1);
  restack();
  lockScroll();
  if (stack.slice(index).some((above) => above.open)) return null;
  return entry!.returns.find((element) => element.isConnected && !stack.some((other) => !other.open && other.sheet.contains(element))) ?? null;
}

/** Whether this sheet is the newest open one: Escape and Tab are its. */
export function isTopSheet(sheet: HTMLElement): boolean {
  return stack.findLast((entry) => entry.open)?.sheet === sheet;
}
