type Focusable = { focus(): void; isConnected: boolean; checkVisibility?(): boolean };

function canTakeFocus(element: Focusable | null | undefined): element is Focusable {
  return Boolean(element?.isConnected && (element.checkVisibility?.() ?? true));
}

/**
 * Remember the focused control before a focus surface opens. The returned
 * function puts focus back on it when the surface closes. When that control
 * has left the page or is hidden (for example after a breakpoint change), the
 * first connected, visible `fallbacks` entry takes focus instead.
 */
export function captureFocusReturn(doc: { activeElement: unknown }) {
  const opener = doc.activeElement as Focusable | null;
  return (...fallbacks: (Focusable | null)[]) => {
    [opener, ...fallbacks].find(canTakeFocus)?.focus();
  };
}

/**
 * When focus is inside `region` and the region is about to leave the page,
 * give focus to `replacement` so it does not fall to the document body.
 */
export function handOffFocus(
  doc: { activeElement: unknown },
  region: { contains(node: Node | null): boolean },
  replacement: Focusable | null,
) {
  if (region.contains(doc.activeElement as Node | null) && canTakeFocus(replacement)) {
    replacement.focus();
  }
}
