/** Resolve a trading chord to the same enabled control a pointer would use. */
export function tradeShortcut(event: KeyboardEvent, panel: HTMLElement): HTMLButtonElement | null {
  const submit = isTradeSubmitShortcut(event, panel);
  if (editableTarget(event) && !submit) return null;
  if (event.shiftKey && !submit) return null;
  const selector = shortcutSelector(event, submit);
  if (!selector) return null;
  return [...panel.querySelectorAll<HTMLButtonElement>(selector)].find(button =>
    !button.disabled && !button.closest('[hidden],[inert],[aria-hidden="true"]') && button.getClientRects().length > 0
  ) ?? null;
}

export function isTradeSubmitShortcut(event: KeyboardEvent, panel: HTMLElement) {
  if (!event.shiftKey || event.code !== "Space") return false;
  const editable = editableTarget(event);
  return !editable || (editable instanceof Element && editable.matches("[data-panel-amount],[data-presale-amount]") && panel.contains(editable));
}

function editableTarget(event: KeyboardEvent) {
  return event.composedPath().find(target => target instanceof Element && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
}

function shortcutSelector(event: KeyboardEvent, submit: boolean) {
  if (submit) return "[data-coin-submit],[data-presale-submit]";
  const key = event.key.toLowerCase();
  if (key === "q") return '[data-side="buy"]';
  if (key === "e") return '[data-side="sell"]';
  return /^[1-4]$/.test(key) ? `[data-trade-preset="${key}"]` : null;
}
